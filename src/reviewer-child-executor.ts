import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, type Api, type Model, type Provider, type Usage } from "@earendil-works/pi-ai";
import { createAgentSession, createBashTool, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { prepareComplianceDispatch } from "./compliance-transport.ts";
import type { AcceptedReviewerLeg } from "./reviewer-dispatch.ts";
import { REVIEWER_VERIFICATION_POLICY } from "./reviewer-verification-policy.ts";
import type { ReviewerPromptIdentity } from "./reviewer-prompt-identity.ts";

export type ReviewerExecutorFaultPoint = "child.reload" | "child.session";
type ClassifiedReviewerError = Error & Readonly<{ reviewerFailure: "provider" | "child" }>;
function classifiedError(error: unknown, reviewerFailure: "provider" | "child"): ClassifiedReviewerError { const wrapped = error instanceof Error ? error : new Error(String(error), { cause: error }); const classification = "reviewerFailure" in wrapped ? (wrapped as ClassifiedReviewerError).reviewerFailure : reviewerFailure; return Object.assign(wrapped, { reviewerFailure: classification }); }
function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, next: Usage): void {
  total.input += next.input;
  total.output += next.output;
  total.cacheRead += next.cacheRead;
  total.cacheWrite += next.cacheWrite;
  total.totalTokens += next.totalTokens;
  total.cost.input += next.cost.input;
  total.cost.output += next.cost.output;
  total.cost.cacheRead += next.cost.cacheRead;
  total.cost.cacheWrite += next.cost.cacheWrite;
  total.cost.total += next.cost.total;
}

async function createChildRuntime(
  context: ExtensionContext,
): Promise<{ runtime: ModelRuntime; model: Model<Api> }> {
  const activeModel = context.model;
  if (activeModel === undefined) {
    throw new Error("Reviewer Agent requires an active model");
  }
  const dispatch = await prepareComplianceDispatch(
    activeModel,
    context,
    "Reviewer Agent",
  );
  const parentProvider = context.modelRegistry.getProvider(activeModel.provider);
  if (parentProvider === undefined) {
    throw new Error(`Reviewer Agent provider not found: ${activeModel.provider}`);
  }
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const provider: Provider = {
    id: parentProvider.id,
    name: parentProvider.name,
    ...(parentProvider.baseUrl === undefined
      ? {}
      : { baseUrl: parentProvider.baseUrl }),
    ...(parentProvider.headers === undefined
      ? {}
      : { headers: parentProvider.headers }),
    auth: {
      apiKey: {
        name: "Inherited Reviewer Agent authentication",
        async resolve() {
          return {
            auth: {
              ...(dispatch.auth.apiKey === undefined
                ? {}
                : { apiKey: dispatch.auth.apiKey }),
              ...(dispatch.auth.headers === undefined
                ? {}
                : { headers: dispatch.auth.headers }),
              ...(dispatch.model.baseUrl === undefined
                ? {}
                : { baseUrl: dispatch.model.baseUrl }),
            },
            ...(dispatch.auth.env === undefined
              ? {}
              : { env: dispatch.auth.env }),
          };
        },
      },
    },
    getModels() { return [dispatch.model]; },
    stream(model, childContext, options) {
      return parentProvider.stream(model, childContext, options);
    },
    streamSimple(model, childContext, options) {
      return parentProvider.streamSimple(model, childContext, options);
    },
  };
  runtime.registerNativeProvider(provider);
  return { runtime, model: dispatch.model };
}

export type ReviewerChildExecuteOptions = Readonly<{
  signal?: AbortSignal;
  fault?(operation: ReviewerExecutorFaultPoint): void;
  /** Parent directory for credential/config scratch. Defaults to os.tmpdir(). */
  credentialScratchParent?: string;
}>;

export async function executeReviewerChild(
  workspace: string,
  leg: AcceptedReviewerLeg,
  context: ExtensionContext,
  options: ReviewerChildExecuteOptions = {},
): Promise<{ report: string; usage: Usage; prompt: ReviewerPromptIdentity }> {
  const signal = options.signal;
  const fault = options.fault;
  const childConfigDir = await mkdtemp(
    join(options.credentialScratchParent ?? tmpdir(), "ak-reviewer-child-"),
  );
  let outerFailure: unknown;
  try {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const loader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir: childConfigDir,
    settingsManager: settings,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: [
      "Work only in the supplied writable review clone.",
      REVIEWER_VERIFICATION_POLICY,
      "Inspect and probe; do not repair the reviewed product, commit, push, or mutate remotes.",
      "Clearly distinguish scratch artifacts and probe changes from facts about the pinned reviewed target.",
      "Return one substantive non-blank review-leg report.",
    ].join("\n"),
  });
  fault?.("child.reload");
  await loader.reload();
  let runtime: ModelRuntime;
  let model: Model<Api>;
  try {
    ({ runtime, model } = await createChildRuntime(context));
  } catch (error) {
    throw classifiedError(error, "provider");
  }
  const customTools = leg.grant.tools.includes("bash")
    ? [{
        ...createBashTool(workspace),
        async execute(...args: any[]) {
          const input = args[1] as { command?: unknown };
          if (typeof input.command !== "string" || !leg.grant.bashCommands.includes(input.command)) {
            throw new Error("Reviewer bash command denied: command is not an exact accepted member");
          }
          return (createBashTool(workspace).execute as any)(...args);
        },
      }]
    : [];
  fault?.("child.session");
  const { session } = await createAgentSession({
    cwd: workspace,
    agentDir: childConfigDir,
    model,
    thinkingLevel: context.thinkingLevel ?? "off",
    modelRuntime: runtime,
    resourceLoader: loader,
    tools: [...leg.grant.tools],
    customTools,
    sessionManager: context.sessionManager?.getSessionFile?.() === undefined
      ? SessionManager.inMemory(workspace)
      : SessionManager.create(
          workspace,
          join(context.sessionManager.getSessionDir(), "reviewer-legs"),
        ),
    settingsManager: settings,
  });
  const usage = emptyUsage();
  const unsubscribe = session.subscribe((event) => {
    if (event.type === "message_end" && event.message.role === "assistant") {
      addUsage(usage, event.message.usage);
    }
  });
  const abortChild = () => { void session.abort(); };
  if (signal?.aborted) abortChild();
  else signal?.addEventListener("abort", abortChild, { once: true });
  let primaryFailure: unknown;
  try {
    const visibleTools = session.agent.state.tools.map((tool) => tool.name);
    if (JSON.stringify(visibleTools) !== JSON.stringify(leg.grant.tools)) {
      throw new Error(`Reviewer child tool isolation failed: ${visibleTools.join(", ")}`);
    }
    const delivered = leg.prompt;
    try {
      await session.prompt(delivered.text);
    } catch (error) {
      throw classifiedError(error, "provider");
    }
    if (signal?.aborted) {
      throw new Error("Reviewer Agent was cancelled");
    }
    const lastAssistant = [...session.messages]
      .reverse()
      .find((message) => message.role === "assistant");
    if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error") {
      throw classifiedError(new Error("Reviewer Agent provider failed", { cause: lastAssistant }), "provider");
    }
    if (lastAssistant?.role !== "assistant" || lastAssistant.stopReason === "aborted") {
      throw classifiedError(new Error("Reviewer Agent child terminated without a report", { cause: lastAssistant ?? session.messages }), "child");
    }
    const report = session.getLastAssistantText() ?? "";
    if (report.trim().length === 0) {
      throw new Error("Reviewer Agent returned a blank child report");
    }
    return { report, usage, prompt: delivered };
  } catch (error) {
    primaryFailure = classifiedError(error, "child");
    throw primaryFailure;
  } finally {
    signal?.removeEventListener("abort", abortChild);
    let cleanupFailure: unknown;
    for (const cleanup of [() => unsubscribe(), () => session.dispose()]) {
      try { cleanup(); } catch (failure) { cleanupFailure = cleanupFailure === undefined ? failure : new AggregateError([cleanupFailure, failure], "Reviewer child cleanup failed", { cause: cleanupFailure }); }
    }
    if (cleanupFailure !== undefined) {
      if (primaryFailure !== undefined) throw new AggregateError([primaryFailure, cleanupFailure], "Reviewer child execution and cleanup failed", { cause: primaryFailure });
      throw new AggregateError([cleanupFailure], "Reviewer child cleanup failed", { cause: cleanupFailure });
    }
  }
  } catch (error) {
    outerFailure = error;
    throw classifiedError(error, "child");
  } finally {
    try {
      await rm(childConfigDir, { recursive: true, force: true });
    } catch (cleanupFailure) {
      if (outerFailure !== undefined) throw new AggregateError([outerFailure, cleanupFailure], "Reviewer child configuration cleanup failed", { cause: outerFailure });
      throw cleanupFailure;
    }
  }
}

