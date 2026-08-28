/**
 * Unique in-process child lifecycle helper (#236 established; #233 sinks auditor + navigator).
 * Owns scratch, inherited provider runtime, AgentSession, abort/dispose.
 * Not a subprocess RPC.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import type {
  ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

import {
  AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE,
  AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE,
  type AuditorParentAttemptBinding,
} from "./compliance-transport.ts";
import { auditorRunDirectory } from "./auditor-dossier-tool.ts";
import { createEngineDetourToolDefinition } from "./engine-detour-tool.ts";
import { engineNameFromEnv } from "./engine-detour.ts";
import {
  appendEngineSessionMaterial,
  engineSessionMaterialFromOptions,
  type EngineSessionMaterial,
} from "./package-resources/engine-material.ts";
import { readPackageMaterial } from "./session-opening-materials.ts";
import {
  type GateOfficerSeat,
} from "./public-cli/config.ts";
import { readInstitutionalSeatSelection } from "./institutional-resolution.ts";
import type {
  OpenPiInstitutionalSessionOptions,
  OpenPiInstitutionalSessionResult,
} from "./pi/in-process-session.ts";
import { createReceiptDeliveryPolicy, NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, RECEIPT_DELIVERY_PROMPT, type NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";
import type { ReviewerPromptText } from "./reviewer-prompt-identity.ts";
import {
  hasUpstreamErrorTestimony,
  isNonSuccessHttpStatus,
  projectConfirmedRemotePayload,
} from "./upstream-error-testimony.ts";

/**
 * Shared Standards/Spec evidence-child system materials — path roster only.
 * Builder consumes this unique roster; cadence prose stays in owner material (ADR 0073).
 * Not exported — tests must not mirror internal roster structure.
 */
const EVIDENCE_CHILD_SESSION_MATERIALS = [
  "souls/quality-law.md",
] as const;

/** Package-owned system prompt for Reviewer Standards/Spec evidence children (private carrier). */
async function buildEvidenceChildSystemPrompt(
  engineMaterial?: EngineSessionMaterial,
): Promise<string> {
  // ADR 0073: verification cadence lives in owner material only; no machine prose copy.
  const materials: string[] = [];
  for (const relativePath of EVIDENCE_CHILD_SESSION_MATERIALS) {
    materials.push(await readPackageMaterial(relativePath));
  }
  return appendEngineSessionMaterial(materials, engineMaterial).join("\n");
}

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

/**
 * Run every child cleanup, aggregating failures so one throwing cleanup never
 * skips the rest (e.g. handle.close must still run when unsubscribe throws).
 * If a primary failure is supplied and cleanup also failed, the two are combined
 * into an AggregateError; otherwise only the failing branch is surfaced.
 */
async function runChildCleanup(
  cleanups: ReadonlyArray<() => void | Promise<void>>,
  primaryFailure: unknown,
  label: string,
): Promise<void> {
  let cleanupFailure: unknown;
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (failure) {
      cleanupFailure = cleanupFailure === undefined
        ? failure
        : new AggregateError([cleanupFailure, failure], `${label} cleanup failed`, {
          cause: cleanupFailure,
        });
    }
  }
  if (cleanupFailure === undefined) return;
  if (primaryFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      `${label} execution and cleanup failed`,
      { cause: primaryFailure },
    );
  }
  throw new AggregateError([cleanupFailure], `${label} cleanup failed`, {
    cause: cleanupFailure,
  });
}

type EvidenceChildFailureClassification = "provider" | "child" | "unknown";
type ClassifiedReviewerError = Error & Readonly<{
  evidenceChildFailure: EvidenceChildFailureClassification;
  evidenceChildOriginal?: unknown;
}>;
function numericHttpStatus(value: unknown): number | undefined {
  return isNonSuccessHttpStatus(value) ? value : undefined;
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
 * Cause-chain reader over the shared upstream-testimony authority.
 * Shape walking stays here; testimony + confirmed-remote payload rules are shared.
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
    const nodeHasTestimony = hasUpstreamErrorTestimony({
      ...(nodeStatus === undefined ? {} : { httpStatus: nodeStatus }),
      ...(nodeDiagnostics === undefined ? {} : { diagnostics: nodeDiagnostics }),
    });
    if (httpStatus === undefined && nodeStatus !== undefined) httpStatus = nodeStatus;
    if (diagnostics === undefined && nodeDiagnostics !== undefined) diagnostics = nodeDiagnostics;
    // Payload only from confirmed-remote nodes — never arbitrary local Error.code.
    if (nodeHasTestimony) {
      const payload = projectConfirmedRemotePayload(record);
      if (body === undefined && payload.body !== undefined) body = payload.body;
      if (code === undefined && payload.code !== undefined) code = payload.code;
      if (errno === undefined && payload.errno !== undefined) errno = payload.errno;
    }
    cursor = record.cause;
  }
  return {
    hasTestimony: hasUpstreamErrorTestimony({
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    }),
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

/** Injectable institutional session opener used by evidence-child consumers.
 * Defaults to the real pi adapter; exposed so a behavior-level regression can
 * drive the cleanup contract at this consumer seam without reaching into the
 * private runChildCleanup helper (#518 S3). */
export type InstitutionalSessionOpener = (
  options: OpenPiInstitutionalSessionOptions,
) => Promise<OpenPiInstitutionalSessionResult>;

export type EvidenceChildExecuteOptions = Readonly<{
  signal?: AbortSignal;
  /** Parent directory for credential/config scratch. Defaults to os.tmpdir(). */
  credentialScratchParent?: string;
  /** Run directory carrying the institutional resolution page (#518). Derives
   * from context when absent. */
  runDirectory?: string;
  /**
   * Package root for optional engine method-material resolution (#378).
   * Required only when AK_ROLE_ENGINE is set and packaged notes should attach.
   */
  packageRoot?: string;
  /** Injectable session opener for behavior-level regression (#518 S3). */
  open?: InstitutionalSessionOpener;
}>;

export async function executeEvidenceChild(
  workspace: string,
  prompt: ReviewerPromptText,
  context: ExtensionContext,
  options: EvidenceChildExecuteOptions = {},
): Promise<{ report: string; usage: Usage; prompt: ReviewerPromptText }> {
  const signal = options.signal;
  const runDirectory = options.runDirectory ?? auditorRunDirectory(context);
  if (runDirectory === undefined) {
    throw new Error("Evidence child requires a run directory carrying the institutional resolution page");
  }
  const selection = await readInstitutionalSeatSelection(runDirectory, "evidenceChild");
  return withInProcessScratch(
    {
      prefix: "ak-evidence-child-",
      ...(options.credentialScratchParent === undefined
        ? {}
        : { parentDirectory: options.credentialScratchParent }),
    },
    async (childConfigDir) => {
      const openInstitutional: InstitutionalSessionOpener =
        options.open ?? (await import("./pi/in-process-session.ts")).openPiInstitutionalSession;
      const { createRecordSession } = await import("./archivist-record-entry.ts");
      // #378: when labor engine is configured, legs get the same detour tool + material
      // dual-path as the parent seat (ADR 0069 detour-rejoins-main-road).
      const engineName = engineNameFromEnv();
      const engineMaterial =
        engineName === undefined
          ? undefined
          : options.packageRoot === undefined || options.packageRoot.trim() === ""
            // Name-only when package root is unavailable (still a valid #376 path).
            ? Object.freeze({ name: engineName })
            : engineSessionMaterialFromOptions({
                engine: engineName,
                packageRoot: options.packageRoot,
              });
      // Evidence legs use the parent detour tool; retain any engine process cause
      // so the enclosing child boundary, rather than a tool-error result, terminates.
      let engineDetourFailure: Error | undefined;
      const engineDetourTool =
        engineName === undefined
          ? undefined
          : createEngineDetourToolDefinition({
              engineName,
              fail(error) {
                engineDetourFailure ??= error instanceof Error ? error : new Error(String(error));
                throw engineDetourFailure;
              },
            });
      // No tools allowlist — Pi defaults + unrestricted evidence surface (ADR 0064).
      // Single open seam owner: pi/in-process-session.ts.
      let opened: Awaited<ReturnType<InstitutionalSessionOpener>>;
      try {
        opened = await openInstitutional({
          cwd: workspace,
          agentDir: childConfigDir,
          selection,
          systemPrompt: await buildEvidenceChildSystemPrompt(engineMaterial),
          ...(engineDetourTool === undefined
            ? {}
            : { customTools: [engineDetourTool] }),
          sessionManager: createRecordSession({
            cwd: workspace,
            kind: "evidence-children",
            ...(context.sessionManager === undefined ? {} : { parent: context.sessionManager }),
          }),
          ...(signal === undefined ? {} : { signal }),
          label: "Evidence child",
        });
      } catch (error) {
        throw classifiedError(error, "provider");
      }
      const { handle, session } = opened;
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
          if (engineDetourFailure !== undefined) {
            throw classifiedError(engineDetourFailure, "child");
          }
          throw classifiedError(error, "provider");
        }
        if (engineDetourFailure !== undefined) {
          throw classifiedError(engineDetourFailure, "child");
        }
        if (signal?.aborted) throw new Error("Evidence child was cancelled");
        const lastAssistant = [...session.messages]
          .reverse()
          .find((message) => message.role === "assistant");
        // error|aborted assistant stops share the upstream-testimony rule: provider only
        // with direct HTTP/SDK testimony, otherwise existing unknown. child is reserved
        // for real local child/report failures (no assistant / blank report / cleanup).
        if (
          lastAssistant?.role === "assistant"
          && (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted")
        ) {
          throw classifiedError(
            new Error(lastAssistant.errorMessage ?? "", { cause: lastAssistant }),
            projectStructuredRemote(lastAssistant).hasTestimony ? "provider" : "unknown",
          );
        }
        if (lastAssistant?.role !== "assistant") {
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
        await runChildCleanup([() => unsubscribe(), () => handle.close()], primaryFailure, "Reviewer child");
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
  /** Province seat identity only — shared executor owns seat resolution, and
   * loud auth/availability failure (#453 / ADR 0018). */
  gateSeat?: GateOfficerSeat;
  /** Run directory carrying the institutional resolution page (#518). Derives
   * from context when absent. */
  runDirectory?: string;
};

/** Resolution-page seat key for an auditor invocation: province gate seats map
 * to their own page seats; doctor/judge compliance audits use the auditor seat. */
function auditorSeatKey(gateSeat: GateOfficerSeat | undefined): string {
  return gateSeat ?? "auditor";
}

/**
 * Auditor lifecycle via the shared institutional sub-session adapter.
 * Adapter keeps role label / soul / decision tool / result projection only.
 * No tools allowlist (ADR 0064). Provider-stream idle-only retry (ADR 0059).
 * Durable child session via ADR 0065 archivist entry.
 */
export async function executeAuditorChild(
  options: AuditorRoleOptions,
): Promise<{ decision: unknown; response: AssistantMessage; noReceiptLifecycle?: NoReceiptLifecycleFacts }> {
  const { createRecordSession } = await import("./archivist-record-entry.ts");
  const runDirectory = options.runDirectory ?? auditorRunDirectory(options.context);
  if (runDirectory === undefined) {
    throw new Error(`${options.roleLabel} requires a run directory carrying the institutional resolution page`);
  }
  const seat = auditorSeatKey(options.gateSeat);
  const selection = await readInstitutionalSeatSelection(runDirectory, seat);

  return withInProcessScratch({ prefix: "ak-auditor-role-" }, async (scratch) => {
    const cwd = options.context.cwd ?? process.cwd();

    let decision: unknown;
    let noReceiptLifecycle: NoReceiptLifecycleFacts | undefined;
    let decisionSubmitted = false;
    let decisionCallId: string | undefined;
    let decisionToolFailure: unknown;
    const decisionToolFailures = new Map<string, unknown>();
    const delivery = createReceiptDeliveryPolicy();
    const tool = {
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
    };

    const parentSessionManager = options.context.sessionManager;
    const parentHeader = parentSessionManager?.getHeader?.();
    const parentSessionFile = parentSessionManager?.getSessionFile?.();
    const parentAttemptEntryId = parentSessionManager?.getLeafId?.();
    const auditorSessionManager: SessionManager = createRecordSession({
      cwd,
      kind: "auditor-roles",
      ...(parentSessionManager === undefined ? {} : { parent: parentSessionManager }),
    });

    // Shared session open — no tools allowlist (ADR 0064). Auth resolved
    // child-locally from the explicit seat selection; adapter owns runtime/provider.
    const { openPiInstitutionalSession } = await import("./pi/in-process-session.ts");
    const opened = await openPiInstitutionalSession({
      cwd,
      agentDir: scratch,
      selection,
      systemPrompt: options.systemPrompt,
      customTools: [{ ...options.dossierTool, label: options.roleLabel }, tool],
      sessionManager: auditorSessionManager,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      idleRetry: true,
      ...(options.runCompletion === undefined
        ? {}
        : { runCompletion: options.runCompletion, injectedSystemPrompt: options.systemPrompt }),
      label: options.roleLabel,
    });
    const { handle, session } = opened;

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
              // that remains the existing unreadable-candidate failure path.
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

    let auditorFailure: unknown;
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
          && opened.streamFailure === undefined && delivery.nextAction() === "request-delivery") {
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
        if (!decisionSubmitted && opened.streamFailure === undefined
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
        if (opened.streamFailure !== undefined) throw opened.streamFailure;
        throw error;
      }
      if (options.signal?.aborted) throw options.signal.reason;
      if (opened.streamFailure !== undefined) throw opened.streamFailure;
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
            ...(projected.hasTestimony && response.provider ? { provider: response.provider } : {}),
            ...(projected.hasTestimony && response.model ? { model: response.model } : {}),
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
    } catch (error) {
      auditorFailure = error;
      throw error;
    } finally {
      options.signal?.removeEventListener("abort", abort);
      await runChildCleanup([() => unsubscribe(), () => handle.close()], auditorFailure, options.roleLabel);
    }
  });
}
