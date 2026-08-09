import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Api, type AssistantMessage, type Context, type Model, type Provider, type ProviderStreamOptions } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager, type AgentToolResult, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { childSessionManager } from "./activation-ledger-session.ts";
import { prepareComplianceDispatch } from "./compliance-transport.ts";

export const AUDITOR_TURN_LIMIT = 8;
export type AuditorLastResponseFacts = { stopReason: AssistantMessage["stopReason"]; toolNames: readonly string[] };
export class AuditorTurnLimitError extends Error {
  constructor(readonly limit: number, readonly observedTurns: number, readonly lastResponse?: AuditorLastResponseFacts) {
    super(`Auditor exhausted its ${limit}-turn limit after ${observedTurns} provider turns`);
    this.name = "AuditorTurnLimitError";
  }
}
export type AuditorCompletion = (model: Model<Api>, context: Context, options: ProviderStreamOptions) => Promise<AssistantMessage>;
export type AuditorDecisionTool = { name: string; description: string; parameters: object; execute(...args: any[]): Promise<AgentToolResult<unknown>> };

export async function runAuditorRole(options: { systemPrompt: string; serializedInput: string; tool: AuditorDecisionTool; roleLabel: string; context: ExtensionContext; signal?: AbortSignal; runCompletion?: AuditorCompletion }): Promise<{ decision: unknown; response: AssistantMessage }> {
  const activeModel = options.context.model;
  if (activeModel === undefined) throw new Error(`${options.roleLabel} requires an active model`);
  const dispatch = await prepareComplianceDispatch(activeModel, options.context, options.roleLabel);
  const parentProvider = options.context.modelRegistry.getProvider(activeModel.provider);
  if (parentProvider === undefined && options.runCompletion === undefined) throw new Error(`${options.roleLabel} provider not found: ${activeModel.provider}`);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  const provider: Provider = { id: parentProvider?.id ?? activeModel.provider, name: parentProvider?.name ?? options.roleLabel, auth: { apiKey: { name: "Inherited auditor authentication", async resolve() { return { auth: { ...dispatch.auth, ...(dispatch.model.baseUrl === undefined ? {} : { baseUrl: dispatch.model.baseUrl }) } }; } } }, getModels() { return [dispatch.model]; }, stream(model, context, request) { if (options.runCompletion !== undefined) { const promise = options.runCompletion(model, context, (request ?? {}) as ProviderStreamOptions); return { async *[Symbol.asyncIterator]() {}, result: () => promise } as any; } return parentProvider!.stream(model, context, request); }, streamSimple(model, context, request) { return parentProvider!.streamSimple(model, context, request); } };
  runtime.registerNativeProvider(provider);
  const scratch = await mkdtemp(join(tmpdir(), "ak-auditor-role-"));
  let decision: unknown;
  try {
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const cwd = options.context.cwd ?? process.cwd();
    const loader = new DefaultResourceLoader({ cwd, agentDir: scratch, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, systemPrompt: options.systemPrompt });
    await loader.reload();
    const tool = { ...options.tool, label: options.roleLabel, async execute(...args: any[]) { if (decision !== undefined) throw new Error("Auditor decision was submitted more than once"); decision = args[1]; return options.tool.execute(...args); } };
    const { session } = await createAgentSession({ cwd, agentDir: scratch, model: dispatch.model, thinkingLevel: options.context.thinkingLevel ?? "off", modelRuntime: runtime, resourceLoader: loader, tools: ["read", "grep", "find", "ls", "bash", "write", "edit", tool.name], customTools: [tool], sessionManager: childSessionManager(options.context.sessionManager, cwd, "auditor-roles"), settingsManager: settings });
    let turns = 0;
    let boundaryResponse: AssistantMessage | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant" && boundaryResponse === undefined) {
        turns += 1;
        if (turns >= AUDITOR_TURN_LIMIT) boundaryResponse = event.message;
      }
      // Let every tool in the boundary turn settle before stopping. In particular,
      // a decision may share that turn with evidence tools executing in parallel.
      if (event.type === "turn_end" && boundaryResponse !== undefined && decision === undefined) void session.abort();
    });
    const abort = () => { void session.abort(); };
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    try {
      try {
        await session.prompt(options.serializedInput);
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        throw error;
      }
      if (options.signal?.aborted) throw options.signal.reason;
      if (boundaryResponse !== undefined && decision === undefined) {
        const toolNames = boundaryResponse.content.flatMap((part) => part.type === "toolCall" ? [part.name] : []);
        throw new AuditorTurnLimitError(AUDITOR_TURN_LIMIT, turns, { stopReason: boundaryResponse.stopReason, toolNames });
      }
      const response = [...session.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.name === tool.name));
      if (response === undefined || response.stopReason === "error" || response.stopReason === "aborted" || decision === undefined) throw new Error(`${options.roleLabel} exited without a readable decision receipt`);
      return { decision, response };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      session.dispose();
    }
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
