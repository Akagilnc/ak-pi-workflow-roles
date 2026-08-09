import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Api, type AssistantMessage, type Context, type Model, type Provider, type ProviderStreamOptions } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prepareComplianceDispatch } from "./compliance-transport.ts";

export class AuditorTurnLimitError extends Error { constructor(readonly limit: number) { super(`Auditor exceeded ${limit} turns`); this.name = "AuditorTurnLimitError"; } }
export type AuditorCompletion = (model: Model<Api>, context: Context, options: ProviderStreamOptions) => Promise<AssistantMessage>;
export type AuditorDecisionTool = { name: string; description: string; parameters: object; execute(...args: any[]): Promise<AgentToolResult<unknown>> };

export async function runAuditorRole(options: { systemPrompt: string; serializedInput: string; tool: AuditorDecisionTool; roleLabel: string; context: ExtensionContext; signal?: AbortSignal; runCompletion?: AuditorCompletion; retainResponse?(response: AssistantMessage): void }): Promise<{ decision: unknown; response: AssistantMessage }> {
  const [{ createAgentSession, DefaultResourceLoader, ModelRuntime, SettingsManager }, { childSessionManager }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("./activation-ledger-session.ts"),
  ]);
  const activeModel = options.context.model;
  if (activeModel === undefined) throw new Error(`${options.roleLabel} requires an active model`);
  const dispatch = await prepareComplianceDispatch(activeModel, options.context, options.roleLabel);
  const parentProvider = options.runCompletion === undefined
    ? options.context.modelRegistry.getProvider(activeModel.provider)
    : undefined;
  if (parentProvider === undefined && options.runCompletion === undefined) throw new Error(`${options.roleLabel} provider not found: ${activeModel.provider}`);
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null });
  const provider: Provider = { id: parentProvider?.id ?? activeModel.provider, name: parentProvider?.name ?? options.roleLabel, auth: { apiKey: { name: "Inherited auditor authentication", async resolve() { const { env, ...auth } = dispatch.auth; return { auth: { ...auth, ...(dispatch.model.baseUrl === undefined ? {} : { baseUrl: dispatch.model.baseUrl }) }, ...(env === undefined ? {} : { env }) }; } } }, getModels() { return [dispatch.model]; }, stream(model, context, request) { if (options.runCompletion !== undefined) { const promise = options.runCompletion(model, context, (request ?? {}) as ProviderStreamOptions); return { async *[Symbol.asyncIterator]() {}, result: () => promise } as any; } return parentProvider!.stream(model, context, request); }, streamSimple(model, context, request) { return parentProvider!.streamSimple(model, context, request); } };
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
    const turnLimit = 32; let turns = 0; let turnError: AuditorTurnLimitError | undefined;
    const unsubscribe = session.subscribe((event) => { if (event.type === "message_end" && event.message.role === "assistant" && ++turns > turnLimit) { turnError = new AuditorTurnLimitError(turnLimit); void session.abort(); } });
    const abort = () => { void session.abort(); };
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    try { await session.prompt(options.serializedInput); } finally { options.signal?.removeEventListener("abort", abort); unsubscribe(); }
    if (turnError !== undefined) throw turnError;
    const response = [...session.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
    session.dispose();
    if (response !== undefined) {
      try {
        options.retainResponse?.(response);
      } catch (retentionFailure) {
        if (response.stopReason !== "error") throw retentionFailure;
        const failure = new Error(response.errorMessage?.trim() || "provider failure", { cause: retentionFailure }) as Error & {
          knownCause: "provider";
          failureCode?: string;
          details: Record<string, unknown>;
        };
        failure.name = "ProviderStopError";
        failure.knownCause = "provider";
        failure.failureCode = response.provider && response.model
          ? `${response.provider}/${response.model}`
          : response.provider || response.model;
        const retentionError = retentionFailure instanceof Error ? retentionFailure : undefined;
        const retentionCause = retentionError?.cause;
        failure.details = {
          ...(response.provider ? { provider: response.provider } : {}),
          ...(response.model ? { model: response.model } : {}),
          retentionFailure: {
            name: retentionError?.name ?? typeof retentionFailure,
            message: retentionError?.message ?? String(retentionFailure),
            ...((retentionError as Error & { code?: unknown } | undefined)?.code !== undefined ? { code: (retentionError as Error & { code?: unknown }).code } : {}),
            ...(retentionCause === undefined ? {} : { cause: retentionCause instanceof Error ? { name: retentionCause.name, message: retentionCause.message, ...((retentionCause as Error & { code?: unknown }).code === undefined ? {} : { code: (retentionCause as Error & { code?: unknown }).code }) } : retentionCause }),
          },
        };
        throw failure;
      }
    }
    if (response === undefined || response.stopReason === "error" || response.stopReason === "aborted" || decision === undefined) throw new Error(`${options.roleLabel} exited without a readable decision receipt`);
    return { decision, response };
  } finally { await rm(scratch, { recursive: true, force: true }); }
}
