import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static } from "typebox";

import {
  NAVIGATOR_INVOCATION_ENTRY,
  NAVIGATOR_ROUTE_PLAYBOOK_FAILURE_ENTRY,
  mintNavigatorInvocationId,
} from "./navigator-invocation-identity.ts";
import { PACKAGED_ROLE_REGISTRY, type PackagedRole } from "./packaged-role-registry.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";
import type { HostContext } from "./host-contracts.ts";
import { createNativeNavigatorSessionFactory } from "./navigator-public-session.ts";
import {
  NAVIGATOR_PREPARE_TOOL_NAME,
  NavigatorUnavailableError,
  navigatorModelSettingPath,
  navigatorProviderFailure,
  navigatorProviderFailureFromDiagnostics,
  navigatorProviderFailureFromError,
  navigatorProviderFailureFromPublicTerminal,
  navigatorProviderFailureFromStatus,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  resolveNavigatorSeatSelection,
  writeNavigatorModelSetting,
  type NavigatorPreparationSession,
  type NavigatorProviderFailureFact,
  type NavigatorSessionFactory,
  type NavigatorUnavailableKey,
} from "./navigator-session-contracts.ts";
import { sitianReport } from "./sitian-facade.ts";

export {
  NAVIGATOR_PREPARE_TOOL_NAME,
  NavigatorUnavailableError,
  navigatorModelSettingPath,
  navigatorProviderFailure,
  navigatorProviderFailureFromDiagnostics,
  navigatorProviderFailureFromError,
  navigatorProviderFailureFromPublicTerminal,
  navigatorProviderFailureFromStatus,
  navigatorUnavailableError,
  parseNavigatorModelSetting,
  readNavigatorModelSetting,
  writeNavigatorModelSetting,
  type NavigatorPreparationSession,
  type NavigatorProviderFailureFact,
  type NavigatorSessionFactory,
  type NavigatorUnavailableKey,
};
export { createNativeNavigatorSessionFactory };
export { resolveNavigatorSeatSelection };
import { issueRoot, subjectPath } from "./work-subject-identity.ts";
import { createReceiptDeliveryPolicy } from "./receipt-delivery-policy.ts";
import {
  byStatusToPlainObject,
  mergePreparedAdvice,
  navigatorAdviceBodySchema,
  pickPreparedProse,
  preparedAdviceFromUnknown,
  type PreparedNavigatorAdvice,
} from "./package-contracts/navigator-output.ts";
import { sha256Hex } from "./sha256.ts";
import { isRecord } from "./unknown-value.ts";

export const NAVIGATOR_EVENT_TYPE = "ak-navigator-attendance" as const;
export { NAVIGATOR_ROUTE_PLAYBOOK_FAILURE_ENTRY };

/** Every public role is a lawful navigator route target (#675 — no nested-only seats). */
export const NAVIGATOR_TARGETS = PACKAGED_ROLE_REGISTRY
  .map(({ role, phases }) => ({ role, phases }));

export type NavigatorTargetRole = PackagedRole;
export type NavigatorPhase = "plan" | "apply" | null;
export type NavigatorSettlement =
  | { kind: "accepted"; role: string; phase: NavigatorPhase; status?: string }
  | { kind: "human_decision"; role: string; phase: NavigatorPhase; status: string }
  | { kind: "role_infrastructure_failure"; role: string; phase: NavigatorPhase }
  | { kind: "arrival"; role: "lander"; phase: null; message?: string };

export type NavigatorSubjectProvenance = "placeholder" | "role_input" | "user_prompt";

/** #1187: auto prepare identity only — no subject/authority material fields. */
export type NavigatorWorkContext = {
  subjectKey: string;
  subjectProvenance: NavigatorSubjectProvenance;
  contextError?: unknown;
};

/**
 * #959: Navigator speaks free-form prose. Code does not parse, rank, or judge
 * the advice — only whether attendance itself failed (host/process).
 */
export type NavigatorReport = {
  /** Affirmative attendance only. Lawful no-advice is typed, never inferred from absence. */
  disposition: "advice" | "no-advice" | "unavailable" | "arrival";
  /** Present when disposition is advice — navigator words, presented as-is. */
  prose?: string;
  unavailableReason?: string;
  unavailableSource?: NavigatorUnavailableKey;
  unavailableCause?: NavigatorUnavailableKey;
  routePlaybookReadFailure?: string;
  arrivalMessage?: string;
};

export type NavigatorEvent = {
  version: 1;
  disposition: NavigatorReport["disposition"];
  invocationId: string;
  role: string;
  phase: NavigatorPhase;
  subjectKey: string;
  prose?: string;
  unavailableReason?: string;
  unavailableSource?: NavigatorUnavailableKey;
  unavailableCause?: NavigatorUnavailableKey;
  routePlaybookReadFailure?: string;
  arrivalMessage?: string;
};

// #959 / #1160: prepare reuses the single navigator advice field owner.
// Object root only (ADR 0060); nested shape is never a gate — every object root
// reaches execute exactly once (Rule 0).
const prepareSchema = navigatorAdviceBodySchema;
type PrepareOutput = Static<typeof prepareSchema>;

export type NavigatorAttendanceOptions = {
  context: HostContext;
  role: string;
  phase: NavigatorPhase;
  subjectKey: string;
  createSession: NavigatorSessionFactory;
  modelSettingPath?: string;
  contextError?: unknown;
  /** Exact principal owned by shared role lifecycle; attendance never overrides it. */
  invocationId?: string;
  /** Effective ceiling already resolved for this turn (#1132). */
  deliveryRequestLimit?: number;
  onEvent: (event: NavigatorEvent, report: NavigatorReport) => void | Promise<void>;
};

const INVOCATION_ENTRY = NAVIGATOR_INVOCATION_ENTRY;
const SETTLEMENT_ENTRY = "ak-navigator-settlement";
const unavailableKeys = new Set<NavigatorUnavailableKey>(["context", "session", "model", "thinking", "auth", "quota", "transport", "unknown"]);

function unavailableKey(value: unknown): NavigatorUnavailableKey | undefined {
  return typeof value === "string" && unavailableKeys.has(value as NavigatorUnavailableKey)
    ? value as NavigatorUnavailableKey
    : undefined;
}

/** Correlate one rejected prepare call/result inside the just-finished prompt. */
function rejectedPrepareReason(entries: readonly unknown[], start: number): string | undefined {
  const recent = entries.slice(start);
  const prepareCalls = new Set<string>();
  for (const entry of recent) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)
      || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const part of entry.message.content) {
      if (isRecord(part) && part.type === "toolCall" && part.name === NAVIGATOR_PREPARE_TOOL_NAME
        && typeof part.id === "string") prepareCalls.add(part.id);
    }
  }
  let reason: string | undefined;
  for (const entry of recent) {
    if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)
      || entry.message.role !== "toolResult" || entry.message.isError !== true) continue;
    const callId = entry.message.toolCallId;
    if (entry.message.toolName !== NAVIGATOR_PREPARE_TOOL_NAME
      || typeof callId !== "string" || !prepareCalls.has(callId)) {
      return undefined;
    }
    const content = entry.message.content;
    const text = Array.isArray(content)
      ? content.flatMap((part) => isRecord(part) && typeof part.text === "string" ? [part.text] : []).join("")
      : typeof content === "string" ? content : "";
    if (text.trim() !== "") reason = text.trim();
  }
  return reason;
}

/**
 * #959 / #1160: extract prepared advice from any prepare submission shape.
 * Missing/empty → undefined. Never a rejection — shape is not an admission gate.
 * Production payload arrives via nested public summon → prepare tool.execute only;
 * archivist entries() never carries assistant message text, so no parallel harvest.
 */
function normalizePreparedAdvice(value: unknown): PreparedNavigatorAdvice | undefined {
  return preparedAdviceFromUnknown(value);
}

export function navigatorSubjectKey(
  subjectRoot: string,
  subject: string,
  provenance: NavigatorSubjectProvenance = "role_input",
): string {
  if (issueRoot(subjectRoot) !== undefined || !subjectRoot.includes("/.ak/work/")) return subjectRoot;
  if (provenance === "placeholder") return subjectRoot;
  const normalized = subject.trim().replace(/\s+/g, " ");
  if (normalized === "") return subjectRoot;
  return `${subjectRoot}#${sha256Hex(normalized).slice(0, 32)}`;
}

/**
 * Role inputs for one ad-hoc work item live below role-specific run folders.
 * The folder and filename are transport, not identity: the shared work root
 * keeps natural inputs on one subject.
 */
export function navigatorSubjectKeyForInput(subjectRoot: string, reference: string, cwd = process.cwd()): string {
  if (issueRoot(subjectRoot) !== undefined || !subjectRoot.includes("/.ak/work/")) return subjectRoot;
  const resolvedReference = resolve(cwd, reference);
  const marker = "/runs/";
  if (resolvedReference.includes(marker)) {
    // The work root, not a role-input filename, is the stable subject.
    // Different roots remain isolated without inventing a filename convention.
    return subjectRoot;
  }
  return navigatorSubjectKey(subjectRoot, resolvedReference);
}

export function createNavigatorPrepareTool(onOutput: (value: PrepareOutput) => void): ToolDefinition {
  return {
    name: NAVIGATOR_PREPARE_TOOL_NAME,
    label: "游奕使准备",
    description: "提交游奕使散文建议。",
    parameters: prepareSchema,
    async execute(_id, value) {
      // Rule 0: the unique prepare submission is accepted once. Shape is never a gate.
      onOutput(value as PrepareOutput);
      return { content: [], details: value, terminate: true as const };
    },
  };
}

export function formatNavigatorReport(report: NavigatorReport): string {
  const playbookFailure = report.routePlaybookReadFailure === undefined
    ? []
    : [report.routePlaybookReadFailure];
  if (report.disposition === "no-advice") return playbookFailure.join("\n");
  if (report.disposition === "unavailable") {
    return [...playbookFailure, ...(report.unavailableReason ? [report.unavailableReason] : [])].join("\n");
  }
  if (report.disposition === "arrival") {
    return [...playbookFailure, ...(report.arrivalMessage ? [report.arrivalMessage] : [])].join("\n");
  }
  // advice — prose as-is
  return [...playbookFailure, ...(report.prose ? [report.prose] : [])].join("\n");
}

export function createNavigatorAttendance(options: NavigatorAttendanceOptions) {
  let preparation: Promise<PreparedNavigatorAdvice | undefined> | undefined;
  let preparationInFlight = false;
  let sessionReady: Promise<NavigatorPreparationSession> | undefined;
  let session: NavigatorPreparationSession | undefined;
  let subjectKey = options.subjectKey;
  // #1187: auto prepare is identity-only (role/phase/subjectKey).
  let contextError = options.contextError;
  /** Parallel-prepare result: status-keyed prose picked at settle (#1160). */
  let preparedAdvice: PreparedNavigatorAdvice | undefined;
  // Shared lifecycle owns the principal when supplied; otherwise mint once per attendance.
  const invocationPrincipal = options.invocationId ?? mintNavigatorInvocationId();
  let activeInvocationId: string | undefined = invocationPrincipal;
  let outputSink: ((value: PrepareOutput) => void) | undefined;
  let settlementTail: Promise<void> = Promise.resolve();
  let settlementFailure: unknown;
  let preparationFailure: unknown;
  let observedRoutePlaybookFailure: string | undefined;
  let disposed = false;
  /** In-flight session teardown; repeat dispose returns the same promise (#959 mutation proof). */
  let closing: Promise<void> | undefined;
  // Shared attendance seam owns nested summon cancel (ADR 0018 / #959).
  // Role session factory only forwards HostContext.signal — never its own controller.
  const nestCancel = new AbortController();
  const sessionHostContext = (): HostContext => {
    const parentSignal = options.context.signal;
    const signal = parentSignal === undefined
      ? nestCancel.signal
      : AbortSignal.any([nestCancel.signal, parentSignal]);
    return { ...options.context, signal };
  };

  const unavailable = (invocationId: string, reason: unknown): NavigatorReport => {
    const failure = reason instanceof NavigatorUnavailableError
      ? reason
      : navigatorUnavailableError("unknown", reason);
    return {
      disposition: "unavailable",
      unavailableReason: failure.message,
      unavailableSource: failure.unavailableSource,
      unavailableCause: failure.unavailableCause,
    };
  };
  /**
   * #1160: prepare runs the model in parallel from parent start and stores byStatus.
   * settle picks by settlement.status — no second model round.
   * Soul and route playbook stay on the navigator system prompt, not this user turn.
   */
  const loadMaterialsAndSession = async (invocationId: string): Promise<NavigatorPreparationSession> => {
    if (contextError !== undefined) throw navigatorUnavailableError("context", contextError);
    // #1187: prepare runs from identity (role/phase/subjectKey). Parent dispatch
    // and authority copies are not required materials for the auto prepare round.
    const modelPromise = (async () => {
      try {
        const resolved = await resolveNavigatorSeatSelection(options.context);
        return resolved.configuredLabel;
      } catch (error) {
        if (error instanceof NavigatorUnavailableError) throw error;
        throw navigatorUnavailableError("model", error);
      }
    })();
    const modelSetting = await modelPromise;
    let model: ReturnType<typeof parseNavigatorModelSetting>;
    try {
      model = parseNavigatorModelSetting(modelSetting);
    } catch (error) {
      throw navigatorUnavailableError("model", error);
    }
    const tool = createNavigatorPrepareTool((value) => { outputSink?.(value); });
    if (session === undefined) {
      sessionReady = (async () => {
        let created: NavigatorPreparationSession;
        try {
          created = await options.createSession({
            context: sessionHostContext(),
            subject: subjectKey,
            ...(options.modelSettingPath === undefined ? {} : { modelSettingPath: options.modelSettingPath }),
            tool,
          });
        } catch (error) {
          throw navigatorUnavailableError("session", error);
        }
        if (disposed) {
          await created.dispose();
          throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
        }
        try {
          await created.setModel?.(modelSetting, model.thinkingLevel);
          if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
          created.appendEntry(INVOCATION_ENTRY, { invocationId, role: options.role, phase: options.phase, subjectKey });
          if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
          session = created;
          return created;
        } catch (error) {
          if (session !== created) await created.dispose();
          throw error instanceof NavigatorUnavailableError ? error : navigatorUnavailableError("session", error);
        }
      })();
      await sessionReady;
      sessionReady = undefined;
    } else {
      try {
        await session.setModel?.(modelSetting, model.thinkingLevel);
      } catch (error) {
        throw error instanceof NavigatorUnavailableError ? error : navigatorUnavailableError("session", error);
      }
      session.appendEntry(INVOCATION_ENTRY, { invocationId, role: options.role, phase: options.phase, subjectKey });
    }
    if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
    if (session === undefined) throw new Error("Navigator session was not created");
    return session;
  };
  const prepare = async (): Promise<PreparedNavigatorAdvice | undefined> => {
    // Exact principal is owned by shared lifecycle (or one mint per attendance).
    // Model/tool/advice paths cannot override it; role-session persistence is
    // pi.appendEntry at lifecycle start — not optional sessionManager probing.
    const invocationId = invocationPrincipal;
    activeInvocationId = invocationId;
    let output: PrepareOutput | undefined;
    let prepareBatchRejected = false;
    outputSink = (value) => {
      // #836 / #1160: extra prepare calls merge byStatus (same key concatenates) and prose.
      const next = normalizePreparedAdvice(value);
      if (output === undefined) {
        output = value;
        return;
      }
      const merged = mergePreparedAdvice(normalizePreparedAdvice(output), next);
      output = {
        ...(merged?.prose === undefined ? {} : { prose: merged.prose }),
        ...(merged === undefined || merged.byStatus.size === 0
          ? {}
          : { byStatus: byStatusToPlainObject(merged.byStatus) }),
      };
    };
    const activeSession = await loadMaterialsAndSession(invocationId);
    // #1160: parallel prepare from parent start — model runs now; settle only picks.
    // #1187: identity only. Parent dispatch / authority copies stay off this wire;
    // navigator reads ticket and station records itself when needed.
    const request = JSON.stringify({
      kind: "prepare",
      role: options.role,
      phase: options.phase,
      invocationId,
      subjectKey,
    });
    try {
      try {
        if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
        // #1132: the ceiling this turn already resolved. Absent = package default.
        const delivery = createReceiptDeliveryPolicy(options.deliveryRequestLimit);
        // Production payload arrives only via nested summon → prepare tool.execute
        // (navigator-public-session). No assistant-entry harvest — entries() is
        // archivist custom-only on the wired factory (#959).
        const promptAllowingRejectedPrepare = async (text: string) => {
          const entryStart = activeSession.entries().length;
          prepareBatchRejected = false;
          let promptFailure: unknown;
          try {
            await activeSession.prompt(text);
          } catch (error) {
            promptFailure = error;
          }
          const providerFailure = activeSession.providerFailure?.();
          if (providerFailure !== undefined) {
            throw navigatorUnavailableError(providerFailure.source, promptFailure ?? "Navigator provider failure", providerFailure.cause);
          }
          const rejectedReason = rejectedPrepareReason(activeSession.entries(), entryStart);
          if (rejectedReason !== undefined) {
            // A rejected call makes every provisional output from this prompt
            // ineligible for publication before the correction turn starts.
            output = undefined;
            prepareBatchRejected = true;
            // The correction prompt below is the one spend for this rejection.
            delivery.recordRejected(rejectedReason);
            return;
          }
          if (promptFailure !== undefined) throw promptFailure;
          const sessionNoReceipt = activeSession.noReceipt?.();
          if (sessionNoReceipt !== undefined) {
            // This session already settled without an accepted receipt. Keep the
            // larger issued count and stop; a nested zero must not wipe prompts
            // this layer already sent (#675 / #1132).
            delivery.recordNestedNoReceipt(sessionNoReceipt);
            return;
          }
        };
        await promptAllowingRejectedPrepare(request);
        // Correction after rejected prepare on the sole model round (#1160).
        while (output === undefined && prepareBatchRejected && delivery.nextAction() === "request-delivery") {
          delivery.recordDeliveryRequest();
          await promptAllowingRejectedPrepare(JSON.stringify(delivery.deliveryState()));
        }
        if (output === undefined && delivery.nextAction() === "request-delivery") {
          delivery.closeBudget();
        }
        if (output === undefined && delivery.nextAction() === "no-receipt" && activeSession.providerFailure?.() === undefined) {
          // Nested @navigator run already holds lawful no_receipt + runPointer when
          // present. Do not write a parallel parent lifecycle off a dead side-branch
          // pointer (#1178). Honest empty prep → settle reports no-advice.
          preparedAdvice = undefined;
          return undefined;
        }
      } catch (error) {
        throw error instanceof NavigatorUnavailableError ? error : navigatorUnavailableError("transport", error);
      }
      if (output === undefined) {
        const nativeFailure = [...activeSession.entries()].reverse().find((entry: unknown) => {
          if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return false;
          return entry.message.role === "assistant" && typeof entry.message.errorMessage === "string" && entry.message.errorMessage.trim() !== "";
        });
        const nativeMessage = isRecord(nativeFailure) && isRecord(nativeFailure.message) ? nativeFailure.message : undefined;
        const errorMessage = nativeMessage !== undefined && typeof nativeMessage.errorMessage === "string"
          ? nativeMessage.errorMessage
          : "Navigator did not submit direction advice";
        // Classification originates only at the native provider stream seam.
        // AssistantMessage metadata is a human diagnostic surface, not an acceptance oracle.
        const providerFailure = activeSession.providerFailure?.();
        const source = providerFailure?.source ?? "unknown";
        const cause = providerFailure?.cause ?? source;
        throw navigatorUnavailableError(source, errorMessage, cause);
      }
      preparedAdvice = normalizePreparedAdvice(output);
      return preparedAdvice;
    } finally {
      const playbookFailure = activeSession.routePlaybookReadFailure?.();
      observedRoutePlaybookFailure = typeof playbookFailure === "string" && playbookFailure.trim() !== ""
        ? playbookFailure
        : undefined;
      outputSink = undefined;
    }
  };

  return {
    setWorkContext(next: NavigatorWorkContext): void | Promise<void> {
      let closing: void | Promise<void> | undefined;
      if (next.subjectKey !== subjectKey && session !== undefined) {
        const previous = session;
        session = undefined;
        closing = previous.dispose();
      }
      subjectKey = next.subjectKey;
      contextError = next.contextError;
      return closing;
    },
    prepare(): void {
      if (disposed || preparation !== undefined) return;
      preparationFailure = undefined;
      preparedAdvice = undefined;
      // Track live in-flight only — a resolved preparation still held until settle
      // drain must not read as preparing (test helpers release by this).
      preparationInFlight = true;
      preparation = prepare().finally(() => {
        preparationInFlight = false;
      });
      // Contract: README.md#Navigator-attendance — background preparation rejection is drained so the later typed settlement can report unavailable; retain the exact cause until settlement.
      void preparation.catch((error) => { preparationFailure = error; });
    },
    isPreparing(): boolean {
      return preparationInFlight;
    },
    settle(settlement: NavigatorSettlement): Promise<void> {
      const next = settlementTail.then(() => settleOnce(settlement));
      // Contract: README.md#Navigator-attendance — rejected attendance settlements are drained only to serialize later attendance; retain the exact rejection for the caller/audit path.
      settlementTail = next.catch((error) => { settlementFailure = error; });
      return next;
    },
    dispose(): void | Promise<void> {
      disposed = true;
      // Abort nested public summon via shared signal; callers may still await session
      // close. Parent grace/shutdown must choose not to await (#959 reopen).
      if (!nestCancel.signal.aborted) {
        nestCancel.abort(navigatorUnavailableError(
          "session",
          new Error("Navigator attendance was disposed"),
        ));
      }
      // Leave sessionReady so an in-flight createSession observes disposed and drains exactly once.
      // Late settleOnce completion observes disposed and skips onEvent.
      activeInvocationId = undefined;
      if (closing === undefined) {
        const current = session;
        session = undefined;
        // Preserve rejection for non-blocking recordDisposeFailure; resolve void on success.
        closing = Promise.resolve(current?.dispose()).then(() => undefined);
      }
      // Same in-flight teardown on repeat dispose — awaiting here re-blocks the parent court.
      return closing;
    },
  };

  async function settleOnce(settlement: NavigatorSettlement): Promise<void> {
      // Dispose during post-role grace must ignore late completion entirely (#675).
      if (disposed) return;
      // Keep playbook failure observed on the prepare round; settle does not re-prompt (#1160).
      const invocationId = activeInvocationId ?? invocationPrincipal;
      let report: NavigatorReport;
      const settlementFact = {
        invocationId,
        subjectKey,
        role: settlement.role,
        phase: settlement.phase,
        kind: settlement.kind,
        ...("status" in settlement && settlement.status !== undefined
          ? { status: settlement.status }
          : {}),
      };
      // Arrival is presentation-only: wait only for nest open, never for the model round.
      if (settlement.kind === "arrival") {
        if (sessionReady !== undefined) {
          try { await sessionReady; } catch (error) { preparationFailure ??= error; }
        }
        session?.appendEntry(SETTLEMENT_ENTRY, settlementFact);
        if (preparationFailure !== undefined) {
          report = unavailable(invocationId, preparationFailure);
        } else {
          report = {
            disposition: "arrival",
            ...(settlement.message === undefined ? {} : { arrivalMessage: settlement.message }),
          };
        }
      } else {
        // Drain in-flight parallel prepare, then pick by status — no second model round (#1160).
        if (sessionReady !== undefined) {
          try { await sessionReady; } catch (error) { preparationFailure ??= error; }
        }
        if (preparation !== undefined) {
          try {
            await preparation;
          } catch (error) {
            preparationFailure ??= error;
          }
          preparation = undefined;
        }
        session?.appendEntry(SETTLEMENT_ENTRY, settlementFact);
        if (preparationFailure !== undefined) {
          // Contract: README.md#Navigator-attendance — failed attendance is typed
          // unavailable without invalidating the role Receipt; retain the cause.
          report = unavailable(invocationId, preparationFailure);
        } else {
          const status = "status" in settlement ? settlement.status : undefined;
          const picked = pickPreparedProse(preparedAdvice, status);
          if (typeof picked === "string" && picked.trim() !== "") {
            // #959 / #1160: present the pre-written prose as-is on every parent outcome
            // including human_decision / escalate. No settlement model round.
            report = { disposition: "advice", prose: picked };
          } else {
            // Missing key / empty prepare / no prior prepare → affirmative no-advice.
            report = { disposition: "no-advice" };
          }
        }
      }
      if (observedRoutePlaybookFailure !== undefined) {
        report = { ...report, routePlaybookReadFailure: observedRoutePlaybookFailure };
      }
      const event: NavigatorEvent = {
        version: 1,
        disposition: report.disposition,
        invocationId,
        role: options.role,
        phase: options.phase,
        subjectKey,
        ...(report.prose === undefined ? {} : { prose: report.prose }),
        ...(report.unavailableReason === undefined ? {} : { unavailableReason: report.unavailableReason }),
        ...(report.unavailableSource === undefined ? {} : { unavailableSource: report.unavailableSource }),
        ...(report.unavailableCause === undefined ? {} : { unavailableCause: report.unavailableCause }),
        ...(report.routePlaybookReadFailure === undefined ? {} : { routePlaybookReadFailure: report.routePlaybookReadFailure }),
        ...(report.arrivalMessage === undefined ? {} : { arrivalMessage: report.arrivalMessage }),
      };
      // Dispose during post-role grace must ignore late completion (ADR 0052 / #106 / #675).
      // Every settled disposition (advice | no-advice | unavailable | arrival) is affirmative.
      // Only the disposed bit is typed authority to drop — never match free-text Error.message.
      if (disposed) return;
      try {
        await options.onEvent(event, report);
      } catch (error) {
        // Race: dispose landed between the check and onEvent; drop only then.
        if (disposed) return;
        throw error;
      }
      preparation = undefined;
      sessionReady = undefined;
      preparedAdvice = undefined;
      preparationFailure = undefined;
      observedRoutePlaybookFailure = undefined;
  }
}

export type NavigatorAttendance = ReturnType<typeof createNavigatorAttendance>;

export function registerNavigatorModelCommand(pi: ExtensionAPI, path = navigatorModelSettingPath()): void {
  pi.registerCommand("navigator-model", {
    description: "Set the persistent Navigator model (provider/model[:max]).",
    handler: async (args) => {
      await writeNavigatorModelSetting(args.trim(), path);
    },
  });
}

export { subjectPath };
