/**
 * Unique in-process child lifecycle helper (#236 established; #233 sinks auditor + navigator).
 * Owns scratch, inherited provider runtime, AgentSession, abort/dispose.
 * Not a subprocess RPC.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type Provider,
  type ProviderStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
  AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE,
  AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE,
  prepareComplianceDispatch,
  type AuditorParentAttemptBinding,
} from "./compliance-transport.ts";
import { wrapPackageOwnedToolDefinition } from "./package-owned-tool-idle.ts";
import type { ReviewerPromptText } from "./reviewer-prompt-identity.ts";
import { createStreamIdleGuard, isStreamIdleTimeoutError } from "./stream-idle-guard.ts";

// ── shared constants / types ──────────────────────────────────────────────

export const AUDITOR_TURN_LIMIT = 32;
export const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;

export class AuditorTurnLimitError extends Error {
  constructor(
    readonly limit: number,
    readonly observedTurns?: number,
  ) {
    super(
      observedTurns === undefined
        ? `Auditor exceeded ${limit} turns`
        : `Auditor exhausted its ${limit}-turn limit after ${observedTurns} provider turns`,
    );
    this.name = "AuditorTurnLimitError";
  }
}
export type AuditorCompletion = (
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions,
) => Promise<AssistantMessage>;
export type AuditorDecisionTool = {
  name: string;
  description: string;
  parameters: object;
  execute(...args: any[]): Promise<import("@earendil-works/pi-coding-agent").AgentToolResult<unknown>>;
};

export type InProcessScratchOptions = {
  readonly prefix: string;
  readonly parentDirectory?: string;
};

/** Shared scratch directory with guaranteed cleanup. */
export async function withInProcessScratch<T>(
  options: InProcessScratchOptions,
  run: (scratch: string) => Promise<T>,
): Promise<T> {
  const scratch = await mkdtemp(join(options.parentDirectory ?? tmpdir(), options.prefix));
  let failure: unknown;
  try {
    return await run(scratch);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (cleanupFailure) {
      if (failure !== undefined) {
        throw new AggregateError([failure, cleanupFailure], "in-process child scratch cleanup failed", { cause: failure });
      }
      throw cleanupFailure;
    }
  }
}

export type InheritedRuntimeOptions = {
  readonly context: ExtensionContext;
  readonly label: string;
  readonly runCompletion?: AuditorCompletion;
  readonly signal?: AbortSignal;
  /** When true, wrap provider streams with ADR 0059 idle-only retry. */
  readonly idleRetry?: boolean;
};

export type InheritedRuntime = {
  readonly runtime: ModelRuntime;
  readonly model: Model<Api>;
  readonly dispatch: Awaited<ReturnType<typeof prepareComplianceDispatch>>;
  /** Present when a stream failed under idle-retry instrumentation. */
  streamFailure: unknown;
};

/**
 * Build an inherited ModelRuntime + provider. Optional idle-only retry is the
 * ADR 0059 provider-stream seam (not package-owned-tool idle).
 */
export async function createInheritedRuntime(options: InheritedRuntimeOptions): Promise<InheritedRuntime> {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const activeModel = options.context.model;
  if (activeModel === undefined) throw new Error(`${options.label} requires an active model`);
  const dispatch = await prepareComplianceDispatch(activeModel, options.context, options.label);
  const parentProvider = options.runCompletion === undefined
    ? options.context.modelRegistry.getProvider(activeModel.provider)
    : undefined;
  if (parentProvider === undefined && options.runCompletion === undefined) {
    throw new Error(`${options.label} provider not found: ${activeModel.provider}`);
  }
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
  });
  const state: InheritedRuntime = {
    runtime,
    model: dispatch.model,
    dispatch,
    streamFailure: undefined,
  };

  const abortReason = (signal: AbortSignal): unknown =>
    signal.reason ?? new Error(`${options.label} provider stream aborted`);

  async function waitForStream<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) throw abortReason(signal);
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(abortReason(signal));
          signal.addEventListener("abort", onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
    }
  }

  const createRetriedStream = (
    simple: boolean,
    model: Model<Api>,
    context: Context,
    request?: ProviderStreamOptions,
  ): ReturnType<Provider["stream"]> => {
    const wrapped = createAssistantMessageEventStream();
    void (async () => {
      for (let attempt = 0; ; attempt += 1) {
        const idle = createStreamIdleGuard(
          options.signal === undefined ? {} : { parentSignal: options.signal },
        );
        try {
          const inheritedRequest = {
            ...(request ?? {}),
            ...(dispatch.auth.env === undefined ? {} : { env: dispatch.auth.env }),
            signal: idle.signal,
          } as ProviderStreamOptions;
          if (options.runCompletion !== undefined) {
            const response = await waitForStream(
              options.runCompletion(model, context, inheritedRequest),
              idle.signal,
            );
            wrapped.end(response);
            return;
          }
          const source = simple
            ? parentProvider!.streamSimple(model, context, inheritedRequest as any)
            : parentProvider!.stream(model, context, inheritedRequest as any);
          let sawEvent = false;
          const iterator = source[Symbol.asyncIterator]();
          while (true) {
            const next = await waitForStream(iterator.next(), idle.signal);
            if (next.done) break;
            sawEvent = true;
            idle.poke();
            wrapped.push(next.value as any);
          }
          const response = await waitForStream(source.result(), idle.signal);
          if (!sawEvent) wrapped.end(response);
          return;
        } catch (error) {
          const failure = isStreamIdleTimeoutError(idle.signal.reason) ? idle.signal.reason : error;
          if (
            options.idleRetry === true
            && isStreamIdleTimeoutError(failure)
            && attempt < DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES
            && options.signal?.aborted !== true
          ) {
            continue;
          }
          state.streamFailure = failure;
          const response: AssistantMessage = {
            role: "assistant",
            content: [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: emptyUsage(),
            stopReason: "error",
            errorMessage: failure instanceof Error ? failure.message : String(failure),
            timestamp: Date.now(),
          };
          wrapped.push({ type: "error", reason: "error", error: response });
          wrapped.end(response);
          return;
        } finally {
          idle.dispose();
        }
      }
    })();
    return wrapped as ReturnType<Provider["stream"]>;
  };

  const provider: Provider = options.idleRetry === true || options.runCompletion !== undefined
    ? {
      id: parentProvider?.id ?? activeModel.provider,
      name: parentProvider?.name ?? options.label,
      auth: {
        apiKey: {
          name: `Inherited ${options.label} authentication`,
          async resolve() {
            const { env, ...auth } = dispatch.auth;
            return {
              auth: {
                ...auth,
                ...(dispatch.model.baseUrl === undefined ? {} : { baseUrl: dispatch.model.baseUrl }),
              },
              ...(env === undefined ? {} : { env }),
            };
          },
        },
      },
      getModels() { return [dispatch.model]; },
      stream(model, context, request) {
        return createRetriedStream(false, model, context, request as ProviderStreamOptions | undefined);
      },
      streamSimple(model, context, request) {
        return createRetriedStream(true, model, context, request as ProviderStreamOptions | undefined);
      },
    }
    : {
      id: parentProvider!.id,
      name: parentProvider!.name,
      ...(parentProvider!.baseUrl === undefined ? {} : { baseUrl: parentProvider!.baseUrl }),
      ...(parentProvider!.headers === undefined ? {} : { headers: parentProvider!.headers }),
      auth: {
        apiKey: {
          name: `Inherited ${options.label} authentication`,
          async resolve() {
            return {
              auth: {
                ...(dispatch.auth.apiKey === undefined ? {} : { apiKey: dispatch.auth.apiKey }),
                ...(dispatch.auth.headers === undefined ? {} : { headers: dispatch.auth.headers }),
                ...(dispatch.model.baseUrl === undefined ? {} : { baseUrl: dispatch.model.baseUrl }),
              },
              ...(dispatch.auth.env === undefined ? {} : { env: dispatch.auth.env }),
            };
          },
        },
      },
      getModels() { return [dispatch.model]; },
      stream(model, childContext, streamOptions) {
        return parentProvider!.stream(model, childContext, streamOptions);
      },
      streamSimple(model, childContext, streamOptions) {
        return parentProvider!.streamSimple(model, childContext, streamOptions);
      },
    };

  runtime.registerNativeProvider(provider);
  return state;
}

type ClassifiedReviewerError = Error & Readonly<{
  evidenceChildFailure: "provider" | "child";
  evidenceChildOriginal?: unknown;
}>;
function classifiedError(error: unknown, evidenceChildFailure: "provider" | "child"): ClassifiedReviewerError {
  const diagnostic = typeof error === "object" && error !== null && typeof (error as { errorMessage?: unknown }).errorMessage === "string"
    ? (error as { errorMessage: string }).errorMessage
    : error === undefined ? "" : String(error);
  const wrapped = error instanceof Error
    ? error
    : Object.assign(new Error(diagnostic, { cause: error }), { evidenceChildOriginal: error });
  const classification = "evidenceChildFailure" in wrapped
    ? (wrapped as ClassifiedReviewerError).evidenceChildFailure
    : evidenceChildFailure;
  return Object.assign(wrapped, { evidenceChildFailure: classification });
}

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

// ── evidence child (reviewer legs) ────────────────────────────────────────

export type EvidenceChildExecuteOptions = Readonly<{
  signal?: AbortSignal;
  /** Parent directory for credential/config scratch. Defaults to os.tmpdir(). */
  credentialScratchParent?: string;
}>;

export async function executeEvidenceChild(
  workspace: string,
  prompt: ReviewerPromptText,
  context: ExtensionContext,
  options: EvidenceChildExecuteOptions = {},
): Promise<{ report: string; usage: Usage; prompt: ReviewerPromptText }> {
  const signal = options.signal;
  return withInProcessScratch(
    {
      prefix: "ak-evidence-child-",
      ...(options.credentialScratchParent === undefined
        ? {}
        : { parentDirectory: options.credentialScratchParent }),
    },
    async (childConfigDir) => {
      const { openInProcessAgentSession } = await import("./in-process-session.ts");
      const { childSessionManager } = await import("./activation-ledger-session.ts");
      let inherited: InheritedRuntime;
      try {
        inherited = await createInheritedRuntime({
          context,
          label: "Evidence child",
        });
      } catch (error) {
        throw classifiedError(error, "provider");
      }
      // No tools allowlist — Pi defaults + unrestricted evidence surface (ADR 0064).
      // Single createAgentSession owner: in-process-session.ts.
      const { session, dispose } = await openInProcessAgentSession({
        cwd: workspace,
        agentDir: childConfigDir,
        model: inherited.model,
        thinkingLevel: context.thinkingLevel ?? "off",
        modelRuntime: inherited.runtime,
        systemPrompt: [
          "Work only in the supplied workspace.",
          "Use the available evidence tools to investigate. Do not commit, push, or mutate remotes.",
          "Return one substantive non-blank report.",
        ].join("\n"),
        sessionManager: childSessionManager(context.sessionManager, workspace, "evidence-children"),
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
        const delivered = prompt;
        try {
          await session.prompt(delivered);
        } catch (error) {
          throw classifiedError(error, "provider");
        }
        if (signal?.aborted) throw new Error("Evidence child was cancelled");
        const lastAssistant = [...session.messages]
          .reverse()
          .find((message) => message.role === "assistant");
        if (lastAssistant?.role === "assistant" && lastAssistant.stopReason === "error") {
          throw classifiedError(
            new Error(lastAssistant.errorMessage ?? "", { cause: lastAssistant }),
            "provider",
          );
        }
        if (lastAssistant?.role !== "assistant" || lastAssistant.stopReason === "aborted") {
          throw classifiedError(
            new Error("Evidence child child terminated without a report", {
              cause: lastAssistant ?? session.messages,
            }),
            "child",
          );
        }
        const report = session.getLastAssistantText() ?? "";
        if (report.trim().length === 0) {
          throw new Error("Evidence child returned a blank child report");
        }
        return { report, usage, prompt: delivered };
      } catch (error) {
        primaryFailure = classifiedError(error, "child");
        throw primaryFailure;
      } finally {
        signal?.removeEventListener("abort", abortChild);
        let cleanupFailure: unknown;
        for (const cleanup of [() => unsubscribe(), () => dispose()]) {
          try {
            cleanup();
          } catch (failure) {
            cleanupFailure = cleanupFailure === undefined
              ? failure
              : new AggregateError([cleanupFailure, failure], "Reviewer child cleanup failed", {
                cause: cleanupFailure,
              });
          }
        }
        if (cleanupFailure !== undefined) {
          if (primaryFailure !== undefined) {
            throw new AggregateError(
              [primaryFailure, cleanupFailure],
              "Reviewer child execution and cleanup failed",
              { cause: primaryFailure },
            );
          }
          throw new AggregateError([cleanupFailure], "Reviewer child cleanup failed", {
            cause: cleanupFailure,
          });
        }
      }
    },
  );
}

// ── auditor child ─────────────────────────────────────────────────────────

export type AuditorRoleOptions = {
  systemPrompt: string;
  prompt: string;
  tool: AuditorDecisionTool;
  dossierTool: AuditorDecisionTool;
  roleLabel: string;
  context: ExtensionContext;
  signal?: AbortSignal;
  runCompletion?: AuditorCompletion;
  retainResponse?(response: AssistantMessage): void;
};

/**
 * Auditor lifecycle via the shared in-process helper.
 * Adapter keeps role label / soul / decision tool / result projection only.
 * No tools allowlist (ADR 0064). Provider-stream idle-only retry (ADR 0059).
 * Durable child session via ADR 0065 sitian entry.
 */
export async function executeAuditorChild(
  options: AuditorRoleOptions,
): Promise<{ decision: unknown; response: AssistantMessage }> {
  const { createRecordSession } = await import("./sitian-record-entry.ts");

  return withInProcessScratch({ prefix: "ak-auditor-role-" }, async (scratch) => {
    const inherited = await createInheritedRuntime({
      context: options.context,
      label: options.roleLabel,
      idleRetry: true,
      ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const cwd = options.context.cwd ?? process.cwd();

    let decision: unknown;
    const tool = wrapPackageOwnedToolDefinition({
      ...options.tool,
      label: options.roleLabel,
      async execute(...args: any[]) {
        if (decision !== undefined) throw new Error("Auditor decision was submitted more than once");
        // Record first so a second submit is rejected even if execute returns;
        // compliance decision tools return and do not throw.
        decision = args[1];
        return options.tool.execute(...args);
      },
    });

    const parentSessionManager = options.context.sessionManager;
    const parentHeader = parentSessionManager?.getHeader?.();
    const parentSessionFile = parentSessionManager?.getSessionFile?.();
    const parentAttemptEntryId = parentSessionManager?.getLeafId?.();
    const auditorSessionManager: SessionManager = createRecordSession({
      cwd,
      kind: "auditor-roles",
      ...(parentSessionManager === undefined ? {} : { parent: parentSessionManager }),
    });

    // Shared session open — no tools allowlist (ADR 0064).
    const { openInProcessAgentSession: openSession } = await import("./in-process-session.ts");
    const { session, dispose } = await openSession({
      cwd,
      agentDir: scratch,
      model: inherited.model,
      thinkingLevel: options.context.thinkingLevel ?? "off",
      modelRuntime: inherited.runtime,
      systemPrompt: options.systemPrompt,
      customTools: [wrapPackageOwnedToolDefinition({ ...options.dossierTool, label: options.roleLabel }), tool],
      sessionManager: auditorSessionManager,
    });

    const binding: AuditorParentAttemptBinding = {
      version: 1,
      parent: {
        ...(parentHeader?.id === undefined ? {} : { sessionId: parentHeader.id }),
        ...(parentSessionFile === undefined ? {} : { sessionFile: parentSessionFile }),
        ...(parentAttemptEntryId === null || parentAttemptEntryId === undefined
          ? {}
          : { attemptEntryId: parentAttemptEntryId }),
      },
    };
    // Durable binding is a prerequisite: never observe the provider when its
    // response could not later be tied to the current parent attempt.
    auditorSessionManager.appendCustomEntry(AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE, binding);

    let turns = 0;
    let turnError: AuditorTurnLimitError | undefined;
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant") {
        turns += 1;
        if (turns > AUDITOR_TURN_LIMIT) {
          turnError = new AuditorTurnLimitError(AUDITOR_TURN_LIMIT, turns);
          void session.abort();
        }
      }
    });
    const abort = () => { void session.abort(); };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    try {
      try {
        await session.prompt(options.prompt);
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (inherited.streamFailure !== undefined) throw inherited.streamFailure;
        throw error;
      }
      if (options.signal?.aborted) throw options.signal.reason;
      if (inherited.streamFailure !== undefined) throw inherited.streamFailure;
      if (turnError !== undefined) throw turnError;

      const assistants = [...session.messages]
        .reverse()
        .filter((message): message is AssistantMessage => message.role === "assistant");
      const response = decision === undefined
        ? assistants[0]
        : assistants.find((message) =>
          message.content.some((part) => part.type === "toolCall" && part.name === tool.name));

      if (response !== undefined) {
        try {
          options.retainResponse?.(response);
        } catch (retentionFailure) {
          if (response.stopReason !== "error") throw retentionFailure;
          const failure = new Error(
            response.errorMessage?.trim() || "provider failure",
            { cause: retentionFailure },
          ) as Error & {
            knownCause: "provider";
            failureCode?: string;
            details: Record<string, unknown>;
          };
          failure.name = response.model || response.provider || "Error";
          failure.knownCause = "provider";
          failure.failureCode = response.provider || response.model;
          const retentionError = retentionFailure instanceof Error ? retentionFailure : undefined;
          const retentionCause = retentionError?.cause;
          failure.details = {
            ...(response.provider ? { provider: response.provider } : {}),
            ...(response.model ? { model: response.model } : {}),
            retentionFailure: {
              name: retentionError?.name ?? typeof retentionFailure,
              message: retentionError?.message ?? String(retentionFailure),
              ...((retentionError as Error & { code?: unknown } | undefined)?.code !== undefined
                ? { code: (retentionError as Error & { code?: unknown }).code }
                : {}),
              ...(retentionCause === undefined
                ? {}
                : {
                  cause: retentionCause instanceof Error
                    ? {
                      name: retentionCause.name,
                      message: retentionCause.message,
                      ...((retentionCause as Error & { code?: unknown }).code === undefined
                        ? {}
                        : { code: (retentionCause as Error & { code?: unknown }).code }),
                    }
                    : retentionCause,
                }),
            },
          };
          auditorSessionManager.appendCustomEntry(AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE, {
            version: 1,
            parent: binding.parent,
            failure: {
              cause: failure.knownCause,
              identity: { name: failure.name, code: failure.failureCode },
              diagnostic: failure.message,
              details: failure.details,
            },
          });
          throw failure;
        }
      }

      if (
        response === undefined
        || response.stopReason === "error"
        || response.stopReason === "aborted"
        || decision === undefined
      ) {
        throw new Error(`${options.roleLabel} exited without a readable decision receipt`);
      }
      return { decision, response };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      dispose();
    }
  });
}
