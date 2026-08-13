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
import { createReceiptDeliveryPolicy, NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, RECEIPT_DELIVERY_PROMPT, type NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";

// ── shared constants / types ──────────────────────────────────────────────

export const AUDITOR_TURN_LIMIT = 32;
export const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;

export type AuditorLastResponseFacts = {
  readonly stopReason: AssistantMessage["stopReason"];
  readonly toolNames: readonly string[];
};
export class AuditorTurnLimitError extends Error {
  constructor(
    readonly limit: number,
    readonly observedTurns?: number,
    readonly lastResponse?: AuditorLastResponseFacts,
  ) {
    super(observedTurns === undefined
      ? `Auditor exceeded ${limit} turns`
      : `Auditor exhausted its ${limit}-turn limit after ${observedTurns} provider turns`);
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
  readonly injectedSystemPrompt?: string;
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
  // Injected completions historically accepted the minimal model exposed by an
  // ExtensionContext. AgentSession crosses ModelRuntime first, so complete the
  // model metadata required by that runtime without changing provider identity.
  const inheritedModel: Model<Api> = options.runCompletion === undefined
    ? dispatch.model
    : {
      ...dispatch.model,
      name: dispatch.model.name ?? dispatch.model.id,
      baseUrl: dispatch.model.baseUrl ?? "",
      reasoning: dispatch.model.reasoning ?? false,
      input: dispatch.model.input ?? ["text"],
      cost: dispatch.model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: dispatch.model.contextWindow ?? 1,
      maxTokens: dispatch.model.maxTokens ?? 1,
    };
  const state: InheritedRuntime = {
    runtime,
    model: inheritedModel,
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
        // Typed HTTP status observed via onResponse — never inferred from prose.
        let observedHttpStatus: number | undefined;
        try {
          const requestSignal = request?.signal;
          const streamSignal = requestSignal === undefined
            ? idle.signal
            : AbortSignal.any([idle.signal, requestSignal]);
          const priorOnResponse = request?.onResponse;
          const priorFetch = request?.fetch;
          const inheritedRequest = {
            ...(request ?? {}),
            ...(dispatch.auth.env === undefined ? {} : { env: dispatch.auth.env }),
            signal: streamSignal,
            // Single HTTP observation at fetch. openai-completions throws APIError
            // before onResponse, so the typed callback never sees non-2xx on that
            // path (default-Pi auditor retention tracer). Never infer from prose.
            fetch: (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
              const fetchImpl = priorFetch ?? globalThis.fetch;
              const response = await fetchImpl(input, init);
              if (typeof response?.status === "number") observedHttpStatus = response.status;
              return response;
            }) as typeof fetch,
            // Preserve prior onResponse chain; do not maintain a second status write.
            ...(priorOnResponse === undefined ? {} : { onResponse: priorOnResponse }),
          } as ProviderStreamOptions;
          if (options.runCompletion !== undefined) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            if (streamSignal.aborted) throw abortReason(streamSignal);
            const completed = await waitForStream(
              options.runCompletion(
                model,
                options.injectedSystemPrompt === undefined
                  ? context
                  : { ...context, systemPrompt: options.injectedSystemPrompt },
                inheritedRequest,
              ),
              streamSignal,
            );
            const response: AssistantMessage = attachObservedHttpStatus({
              ...completed,
              api: model.api,
              provider: model.provider,
              model: model.id,
            }, observedHttpStatus);
            if (response.stopReason === "error" || response.stopReason === "aborted") {
              wrapped.push({ type: "error", reason: response.stopReason, error: response });
            } else {
              wrapped.end(response);
            }
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
            wrapped.push(enrichStreamEvent(next.value, observedHttpStatus) as any);
          }
          const response = attachObservedHttpStatus(
            await waitForStream(source.result(), idle.signal),
            observedHttpStatus,
          );
          if (!sawEvent) wrapped.end(response);
          return;
        } catch (error) {
          if (request?.signal?.aborted) {
            const response: AssistantMessage = {
              role: "assistant",
              content: [],
              api: model.api,
              provider: model.provider,
              model: model.id,
              usage: emptyUsage(),
              stopReason: "aborted",
              errorMessage: "Auditor session aborted",
              timestamp: Date.now(),
            };
            wrapped.push({ type: "error", reason: "aborted", error: response });
            wrapped.end(response);
            return;
          }
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
          const projected = projectStructuredRemote(failure);
          // Prefer structured fields on the thrown failure; fall back to onResponse observation.
          const httpStatus = projected.httpStatus ?? numericHttpStatus(observedHttpStatus);
          const response = {
            role: "assistant" as const,
            content: [] as [],
            api: model.api,
            provider: model.provider,
            model: model.id,
            usage: emptyUsage(),
            stopReason: "error" as const,
            // Preserve the held failure message bytes — do not rewrite.
            errorMessage: failure instanceof Error ? failure.message : String(failure),
            timestamp: Date.now(),
            ...(projected.diagnostics === undefined ? {} : { diagnostics: projected.diagnostics }),
            ...(httpStatus === undefined ? {} : { status: httpStatus, statusCode: httpStatus }),
            ...(projected.body === undefined ? {} : { body: projected.body }),
            ...(projected.code === undefined ? {} : { code: projected.code }),
            ...(projected.errno === undefined ? {} : { errno: projected.errno }),
          } as unknown as AssistantMessage;
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
      getModels() { return [inheritedModel]; },
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
      getModels() { return [inheritedModel]; },
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

type EvidenceChildFailureClassification = "provider" | "child" | "unknown";
type ClassifiedReviewerError = Error & Readonly<{
  evidenceChildFailure: EvidenceChildFailureClassification;
  evidenceChildOriginal?: unknown;
}>;
function numericHttpStatus(value: unknown): number | undefined {
  if (typeof value === "number" && (value < 200 || value >= 300)) return value;
  return undefined;
}

type StructuredRemoteProjection = {
  readonly hasTestimony: boolean;
  readonly httpStatus?: number;
  readonly diagnostics?: unknown;
  readonly body?: unknown;
  readonly code?: unknown;
  readonly errno?: unknown;
};

/**
 * Single-pass structured remote testimony/payload projection.
 * Testimony = non-success HTTP status or non-empty diagnostics on the held chain.
 * body/code/errno project only from a node that already carries remote testimony
 * (status or diagnostics) so a plain local Error.code is never provider testimony.
 */
function projectStructuredRemote(error: unknown): StructuredRemoteProjection {
  let httpStatus: number | undefined;
  let diagnostics: unknown;
  let body: unknown;
  let code: unknown;
  let errno: unknown;
  let cursor: unknown = error;
  const seen = new Set<unknown>();
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const record = cursor as Record<string, unknown>;
    const nodeStatus = numericHttpStatus(record.statusCode)
      ?? numericHttpStatus(record.status)
      ?? numericHttpStatus(record.httpStatus);
    const nodeDiagnostics = Array.isArray(record.diagnostics) && record.diagnostics.length > 0
      ? record.diagnostics
      : undefined;
    const nodeHasTestimony = nodeStatus !== undefined || nodeDiagnostics !== undefined;
    if (httpStatus === undefined && nodeStatus !== undefined) httpStatus = nodeStatus;
    if (diagnostics === undefined && nodeDiagnostics !== undefined) diagnostics = nodeDiagnostics;
    // Payload only from confirmed-remote nodes — never arbitrary local Error.code.
    if (nodeHasTestimony) {
      if (body === undefined && record.body !== undefined) body = record.body;
      if (code === undefined && record.code !== undefined) code = record.code;
      if (errno === undefined && record.errno !== undefined) errno = record.errno;
    }
    cursor = record.cause;
  }
  return {
    hasTestimony: httpStatus !== undefined || diagnostics !== undefined,
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(body === undefined ? {} : { body }),
    ...(code === undefined ? {} : { code }),
    ...(errno === undefined ? {} : { errno }),
  };
}

/**
 * Attach a directly observed HTTP status onto an error/aborted assistant message.
 * Does not invent status from errorMessage prose; skips when already held.
 */
function attachObservedHttpStatus<T extends AssistantMessage>(
  message: T,
  observedHttpStatus: number | undefined,
): T {
  if (observedHttpStatus === undefined) return message;
  if (message.stopReason !== "error" && message.stopReason !== "aborted") return message;
  if (numericHttpStatus(observedHttpStatus) === undefined) return message;
  if (projectStructuredRemote(message).httpStatus !== undefined) return message;
  return Object.assign(message, {
    status: observedHttpStatus,
    statusCode: observedHttpStatus,
  });
}
function enrichStreamEvent(event: unknown, observedHttpStatus: number | undefined): unknown {
  if (observedHttpStatus === undefined || event === null || typeof event !== "object") return event;
  const record = event as Record<string, unknown>;
  if (record.type === "error" && record.error !== null && typeof record.error === "object") {
    return {
      ...record,
      error: attachObservedHttpStatus(record.error as AssistantMessage, observedHttpStatus),
    };
  }
  if (record.type === "done" && record.message !== null && typeof record.message === "object") {
    return {
      ...record,
      message: attachObservedHttpStatus(record.message as AssistantMessage, observedHttpStatus),
    };
  }
  if (record.partial !== null && typeof record.partial === "object") {
    return {
      ...record,
      partial: attachObservedHttpStatus(record.partial as AssistantMessage, observedHttpStatus),
    };
  }
  return event;
}
function classifiedError(error: unknown, evidenceChildFailure: EvidenceChildFailureClassification): ClassifiedReviewerError {
  const diagnostic = typeof error === "object" && error !== null && typeof (error as { errorMessage?: unknown }).errorMessage === "string"
    ? (error as { errorMessage: string }).errorMessage
    : error === undefined ? "" : String(error);
  const wrapped = error instanceof Error
    ? error
    : Object.assign(new Error(diagnostic, { cause: error }), { evidenceChildOriginal: error });
  const classification = "evidenceChildFailure" in wrapped
    ? (wrapped as ClassifiedReviewerError).evidenceChildFailure
    : evidenceChildFailure === "provider" && !projectStructuredRemote(error).hasTestimony
      ? "unknown"
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
      const { createRecordSession } = await import("./sitian-record-entry.ts");
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
        sessionManager: createRecordSession({
          cwd: workspace,
          kind: "evidence-children",
          ...(context.sessionManager === undefined ? {} : { parent: context.sessionManager }),
        }),
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
            projectStructuredRemote(lastAssistant).hasTestimony ? "provider" : "unknown",
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
): Promise<{ decision: unknown; response: AssistantMessage; noReceiptLifecycle?: NoReceiptLifecycleFacts }> {
  const { createRecordSession } = await import("./sitian-record-entry.ts");

  return withInProcessScratch({ prefix: "ak-auditor-role-" }, async (scratch) => {
    const inherited = await createInheritedRuntime({
      context: options.context,
      label: options.roleLabel,
      idleRetry: true,
      ...(options.runCompletion === undefined
        ? {}
        : { runCompletion: options.runCompletion, injectedSystemPrompt: options.systemPrompt }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });

    const cwd = options.context.cwd ?? process.cwd();

    let decision: unknown;
    let noReceiptLifecycle: NoReceiptLifecycleFacts | undefined;
    let decisionSubmitted = false;
    let decisionCallId: string | undefined;
    let decisionToolFailure: unknown;
    const decisionToolFailures = new Map<string, unknown>();
    const delivery = createReceiptDeliveryPolicy();
    const tool = wrapPackageOwnedToolDefinition({
      ...options.tool,
      label: options.roleLabel,
      async execute(...args: any[]) {
        if (decisionSubmitted && decisionCallId !== args[0]) {
          throw new Error("Auditor decision was submitted more than once");
        }
        // Pi may already have issued several decision calls in one assistant
        // response. Execute every issued call: the budget limits future
        // solicitations, not terminal calls already in flight.
        try {
          const result = await options.tool.execute(...args);
          delivery.recordAccepted();
          decision = args[1];
          decisionCallId = args[0];
          decisionToolFailure = undefined;
          decisionToolFailures.delete(args[0]);
          decisionSubmitted = true;
          return result;
        } catch (error) {
          decisionToolFailure = error;
          decisionToolFailures.set(args[0], error);
          throw error;
        }
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
    const sessionUsage = emptyUsage();
    let boundaryResponse: AssistantMessage | undefined;
    let retentionFailure: unknown;
    let retainedResponse: AssistantMessage | undefined;
    let rejectedDecisionResponse: AssistantMessage | undefined;
    let promptNeighboringFailure: unknown;
    let promptDecisionFailures: unknown[] = [];
    const registeredToolNames = new Set(session.getAllTools().map((entry) => entry.name));
    const evidenceToolFailures = new Map<string, unknown>();
    for (const name of registeredToolNames) {
      if (name === tool.name) continue;
      const definition = session.getToolDefinition(name);
      if (definition === undefined) continue;
      const execute = definition.execute.bind(definition);
      definition.execute = async (...args: any[]) => {
        try {
          return await (execute as (...executeArgs: any[]) => Promise<any>)(...args);
        } catch (error) {
          evidenceToolFailures.set(args[0], error);
          throw error;
        }
      };
    }
    const findToolFailure = (response: AssistantMessage): unknown => {
      const callIds = response.content.flatMap((part) =>
        part.type === "toolCall" && part.name !== tool.name && registeredToolNames.has(part.name) ? [part.id] : []);
      for (const callId of callIds) {
        if (evidenceToolFailures.has(callId)) return evidenceToolFailures.get(callId);
      }
      const callIdSet = new Set(callIds);
      return [...session.messages].reverse().find((message) =>
        message.role === "toolResult" && callIdSet.has(message.toolCallId) && message.isError);
    };
    const drainRejectedDecisionFailures = (response: AssistantMessage) => {
      for (const part of response.content) {
        if (part.type !== "toolCall" || part.name !== tool.name || !decisionToolFailures.has(part.id)) continue;
        decisionToolFailure = decisionToolFailures.get(part.id);
        promptDecisionFailures.push(decisionToolFailure);
        decisionToolFailures.delete(part.id);
      }
    };
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "message_end" && event.message.role === "assistant" && boundaryResponse === undefined) {
        turns += 1;
        addUsage(sessionUsage, event.message.usage);
        retainedResponse = event.message;
        try { options.retainResponse?.(event.message); } catch (error) { retentionFailure = error; }
        // A tool call in assistant output is only an observation. Preserve its
        // candidate for typed malformed-decision settlement, but the wrapped
        // execute path above is the sole owner of accepted-receipt state; a
        // rejected execution must remain retryable in this same session.
        for (const part of event.message.content) {
          if (part.type === "toolCall" && part.name === tool.name) {
            rejectedDecisionResponse = event.message;
            if (decision === undefined) {
              decision = part.arguments;
              decisionCallId = part.id;
              // Pi can reject malformed root arguments before invoking execute;
              // that remains the existing typed audit-incomplete candidate path.
              if (part.arguments === undefined) decisionSubmitted = true;
            }
          }
        }
        if (turns >= AUDITOR_TURN_LIMIT) boundaryResponse = event.message;
      }
      if (event.type === "turn_end") {
        if (rejectedDecisionResponse !== undefined) {
          promptNeighboringFailure = findToolFailure(rejectedDecisionResponse);
          drainRejectedDecisionFailures(rejectedDecisionResponse);
        }
        if (decisionSubmitted || promptNeighboringFailure !== undefined
          || (boundaryResponse !== undefined && rejectedDecisionResponse === undefined)
          || retentionFailure !== undefined) {
          void session.abort();
        }
      }
    });
    const abort = () => { void session.abort(); };
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });

    try {
      try {
        const promptAllowingRejectedDecision = async (prompt: string) => {
          rejectedDecisionResponse = undefined;
          promptNeighboringFailure = undefined;
          decisionToolFailure = undefined;
          promptDecisionFailures = [];
          let promptFailure: unknown;
          try {
            await session.prompt(prompt);
          } catch (error) {
            promptFailure = error;
          }
          // Prefer turn_end correlation, but Pi may reject prompt() before that
          // event. In that case correlate against this prompt's captured decision
          // response and call-id maps at the catch boundary.
          const correlatedResponse = rejectedDecisionResponse as AssistantMessage | undefined;
          if (correlatedResponse !== undefined) {
            promptNeighboringFailure ??= findToolFailure(correlatedResponse);
            drainRejectedDecisionFailures(correlatedResponse);
          }
          // An adjacent failure outranks correctable decision feedback.
          if (promptNeighboringFailure !== undefined) throw promptNeighboringFailure;
          // An accepted correction in the same response owns the terminal
          // outcome; correlated rejected siblings remain observations, not a
          // stale failure capable of replacing that accepted receipt.
          if (decisionSubmitted) {
            decisionToolFailure = undefined;
            return;
          }
          if (decisionToolFailure !== undefined) return;
          if (promptFailure !== undefined) throw promptFailure;
        };
        const chargeAndClearRejectedDecisionFailures = (failures: unknown[]) => {
          for (const failure of failures) {
            delivery.recordRejected(failure instanceof Error ? failure.message : String(failure));
          }
          decisionToolFailure = undefined;
          promptDecisionFailures = [];
        };
        await promptAllowingRejectedDecision(options.prompt);
        while (!decisionSubmitted && (boundaryResponse === undefined || decisionToolFailure !== undefined)
          && inherited.streamFailure === undefined && delivery.nextAction() === "request-delivery") {
          if (decisionToolFailure !== undefined) {
            const failures = promptDecisionFailures.length === 0
              ? [decisionToolFailure]
              : promptDecisionFailures;
            chargeAndClearRejectedDecisionFailures(failures);
            if (delivery.nextAction() === "no-receipt") boundaryResponse = undefined;
            if (delivery.nextAction() === "request-delivery") {
              // A rejection and its correction solicitation are one budget unit;
              // recordRejected already charged it.
              if (retainedResponse === rejectedDecisionResponse) {
                await promptAllowingRejectedDecision(RECEIPT_DELIVERY_PROMPT);
                chargeAndClearRejectedDecisionFailures(promptDecisionFailures);
              }
            }
          } else {
            delivery.recordDeliveryRequest();
            await promptAllowingRejectedDecision(RECEIPT_DELIVERY_PROMPT);
          }
        }
        if (!decisionSubmitted && inherited.streamFailure === undefined
          && delivery.nextAction() === "no-receipt") {
          const runPointer = options.context.sessionManager.getSessionFile() ?? options.context.cwd ?? process.cwd();
          const attemptPointer = binding.parent.attemptEntryId ?? binding.parent.sessionId ?? `current:${runPointer}`;
          const facts = delivery.facts({ runPointer, attemptPointer });
          decision = facts;
          // Late turn_end feedback cannot overturn a lifecycle that has already
          // charged this prompt to the exhausted shared budget.
          decisionToolFailure = undefined;
          auditorSessionManager.appendCustomEntry(NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, facts);
          // Provenance is granted only after the lifecycle owner persisted the
          // current child record; accepted model arguments can never set it.
          noReceiptLifecycle = facts;
        }
      } catch (error) {
        if (options.signal?.aborted) throw options.signal.reason;
        if (inherited.streamFailure !== undefined) throw inherited.streamFailure;
        throw error;
      }
      if (options.signal?.aborted) throw options.signal.reason;
      if (inherited.streamFailure !== undefined) throw inherited.streamFailure;
      if (!decisionSubmitted && decisionToolFailure !== undefined) throw decisionToolFailure;
      const relevantResponse = !decisionSubmitted
        ? boundaryResponse
        : [...session.messages].reverse().find((message): message is AssistantMessage =>
          message.role === "assistant" && message.content.some((part) => part.type === "toolCall" && part.name === tool.name));
      if (relevantResponse !== undefined) {
        const toolFailure = findToolFailure(relevantResponse);
        if (toolFailure !== undefined) throw toolFailure;
      }
      if (retentionFailure !== undefined && retainedResponse?.stopReason !== "error") throw retentionFailure;
      if (boundaryResponse !== undefined && !decisionSubmitted && noReceiptLifecycle === undefined) {
        const toolNames = boundaryResponse.content.flatMap((part) => part.type === "toolCall" ? [part.name] : []);
        throw new AuditorTurnLimitError(AUDITOR_TURN_LIMIT, turns, {
          stopReason: boundaryResponse.stopReason,
          toolNames,
        });
      }

      const assistants = [...session.messages]
        .reverse()
        .filter((message): message is AssistantMessage => message.role === "assistant");
      const response = !decisionSubmitted
        ? assistants[0]
        : assistants.find((message) =>
          message.content.some((part) => part.type === "toolCall" && part.name === tool.name));

      if (response !== undefined) {
        try {
          if (retainedResponse === undefined) options.retainResponse?.(response);
          else if (retentionFailure !== undefined) throw retentionFailure;
        } catch (retentionFailure) {
          if (response.stopReason !== "error") throw retentionFailure;
          // Do not trim/rewrite the held errorMessage bytes.
          const diagnostic = typeof response.errorMessage === "string" && response.errorMessage.trim() !== ""
            ? response.errorMessage
            : undefined;
          const projected = projectStructuredRemote(response);
          const failure = new Error(
            diagnostic ?? "",
            { cause: retentionFailure },
          ) as Error & {
            knownCause: "provider" | "unrecognized";
            failureCode?: string;
            details: Record<string, unknown>;
          };
          if (projected.hasTestimony && (response.model || response.provider)) {
            failure.name = response.model || response.provider || "Error";
            failure.failureCode = response.provider || response.model;
          }
          failure.knownCause = projected.hasTestimony ? "provider" : "unrecognized";
          const retentionError = retentionFailure instanceof Error ? retentionFailure : undefined;
          const retentionCause = retentionError?.cause;
          failure.details = {
            ...(diagnostic === undefined ? {} : { errorMessage: diagnostic }),
            ...(response.provider ? { provider: response.provider } : {}),
            ...(response.model ? { model: response.model } : {}),
            ...(response.api ? { api: response.api } : {}),
            ...(response.rawStopReason ? { rawStopReason: response.rawStopReason } : {}),
            ...(projected.httpStatus === undefined ? {} : { httpStatus: projected.httpStatus }),
            ...(projected.diagnostics === undefined ? {} : { diagnostics: projected.diagnostics }),
            ...(projected.body === undefined ? {} : { body: projected.body }),
            ...(projected.code === undefined ? {} : { code: projected.code }),
            ...(projected.errno === undefined ? {} : { errno: projected.errno }),
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
              ...(failure.failureCode === undefined ? {} : { identity: { name: failure.name, code: failure.failureCode } }),
              ...(failure.message === "" ? {} : { diagnostic: failure.message }),
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
        || (!decisionSubmitted && decision === undefined)
      ) {
        throw new Error(`${options.roleLabel} exited without a readable decision receipt`);
      }
      return {
        decision,
        response: { ...response, usage: sessionUsage },
        ...(noReceiptLifecycle === undefined ? {} : { noReceiptLifecycle }),
      };
    } finally {
      options.signal?.removeEventListener("abort", abort);
      unsubscribe();
      dispose();
    }
  });
}
