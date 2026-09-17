import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  NAVIGATOR_INVOCATION_ENTRY,
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
import { createReceiptDeliveryPolicy, NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, RECEIPT_DELIVERY_PROMPT } from "./receipt-delivery-policy.ts";
import { navigatorProseFromUnknown } from "./package-contracts/navigator-output.ts";

export const NAVIGATOR_EVENT_TYPE = "ak-navigator-attendance" as const;
export const NAVIGATOR_PREPARE_ACCEPTED_TEXT = "游奕使准备已接受";

/**
 * Role-input document bytes win verbatim over work-root file authority when non-empty.
 * Absent or whitespace-only input yields to fileAuthority; neither remains undefined.
 */
export function resolveNavigatorAuthorityMaterial(
  roleInput: string | undefined,
  fileAuthority: string | undefined,
): string | undefined {
  if (roleInput !== undefined && roleInput.trim() !== "") return roleInput;
  if (fileAuthority !== undefined && fileAuthority.trim() !== "") return fileAuthority;
  return undefined;
}

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

export type NavigatorWorkContext = {
  subjectKey: string;
  subject: string;
  authority: string;
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

export type NavigatorSettlementFact = NavigatorSettlement & { invocationId: string; subjectKey: string };
export type NavigatorContextProjection = {
  subjectKey: string;
  subject: string;
  authority: string;
  currentRole: { role: string; phase: NavigatorPhase };
  /** Present on the unique settlement-bound advice prompt. */
  currentSettlement?: NavigatorSettlement;
  /** Opaque prior advice prose for this subject — pass-through only; never parsed. */
  priorAdvice: string[];
  publicSettlementHistory: NavigatorSettlementFact[];
  liveRoleHelp: Array<{ role: NavigatorTargetRole; help: string }>;
};

// #959: prepare is a prose vehicle. Object root only (ADR 0060); nested shape is
// never a gate — every object root reaches execute exactly once (Rule 0).
const prepareSchema = Type.Object({
  prose: Type.Optional(Type.Unknown({
    description: "游奕使散文建议，原样呈现。不要求 candidates/next 结构。非受理闸",
  })),
}, { additionalProperties: true });
type PrepareOutput = Static<typeof prepareSchema>;

export type NavigatorAttendanceOptions = {
  context: HostContext;
  role: string;
  phase: NavigatorPhase;
  subjectKey: string;
  loadSoul: () => Promise<string>;
  loadRoutePlaybook?: () => Promise<string>;
  loadRoleHelp: (role: NavigatorTargetRole) => Promise<string>;
  createSession: NavigatorSessionFactory;
  modelSettingPath?: string;
  subject: string;
  authority: string;
  contextError?: unknown;
  /** Exact principal owned by shared role lifecycle; attendance never overrides it. */
  invocationId?: string;
  onEvent: (event: NavigatorEvent, report: NavigatorReport) => void | Promise<void>;
};

const CONTEXT_ENTRY = "ak-navigator-context";
const INVOCATION_ENTRY = NAVIGATOR_INVOCATION_ENTRY;
const SETTLEMENT_ENTRY = "ak-navigator-settlement";
/** Opaque prior advice bytes for the same subject — not a route ledger. */
const PRIOR_ADVICE_ENTRY = "ak-navigator-prior-advice";
const unavailableKeys = new Set<NavigatorUnavailableKey>(["context", "session", "model", "thinking", "auth", "quota", "transport", "unknown"]);

function unavailableKey(value: unknown): NavigatorUnavailableKey | undefined {
  return typeof value === "string" && unavailableKeys.has(value as NavigatorUnavailableKey)
    ? value as NavigatorUnavailableKey
    : undefined;
}

function exactRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Correlate one rejected prepare call/result inside the just-finished prompt. */
function rejectedPrepareReason(entries: readonly unknown[], start: number): string | undefined {
  const recent = entries.slice(start);
  const prepareCalls = new Set<string>();
  for (const entry of recent) {
    if (!exactRecord(entry) || entry.type !== "message" || !exactRecord(entry.message)
      || entry.message.role !== "assistant" || !Array.isArray(entry.message.content)) continue;
    for (const part of entry.message.content) {
      if (exactRecord(part) && part.type === "toolCall" && part.name === NAVIGATOR_PREPARE_TOOL_NAME
        && typeof part.id === "string") prepareCalls.add(part.id);
    }
  }
  let reason: string | undefined;
  for (const entry of recent) {
    if (!exactRecord(entry) || entry.type !== "message" || !exactRecord(entry.message)
      || entry.message.role !== "toolResult" || entry.message.isError !== true) continue;
    const callId = entry.message.toolCallId;
    if (entry.message.toolName !== NAVIGATOR_PREPARE_TOOL_NAME
      || typeof callId !== "string" || !prepareCalls.has(callId)) {
      return undefined;
    }
    const content = entry.message.content;
    const text = Array.isArray(content)
      ? content.flatMap((part) => exactRecord(part) && typeof part.text === "string" ? [part.text] : []).join("")
      : typeof content === "string" ? content : "";
    if (text.trim() !== "") reason = text.trim();
  }
  return reason;
}

/**
 * #959: extract prose from any prepare submission shape. Missing/empty → undefined.
 * Never a rejection — shape is not an admission gate.
 * Production prose arrives via nested public summon → prepare tool.execute only;
 * archivist entries() never carries assistant message text, so no parallel harvest.
 */
function normalizePrepareProse(value: unknown): string | undefined {
  return navigatorProseFromUnknown(value);
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
  return `${subjectRoot}#${createHash("sha256").update(normalized).digest("hex").slice(0, 32)}`;
}

/**
 * Role inputs for one ad-hoc work item live below role-specific run folders.
 * The folder and filename are transport, not identity: the shared work root
 * keeps task.md, fix-packet.json, and other natural inputs on one subject.
 */
export function navigatorSubjectKeyForInput(subjectRoot: string, reference: string, cwd = process.cwd()): string {
  if (issueRoot(subjectRoot) !== undefined || !subjectRoot.includes("/.ak/work/")) return subjectRoot;
  const resolvedReference = resolve(cwd, reference);
  const marker = "/runs/";
  if (resolvedReference.includes(marker)) {
    // The work root, not task.md/fix-packet.json/etc., is the stable subject.
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
      return { content: [{ type: "text" as const, text: NAVIGATOR_PREPARE_ACCEPTED_TEXT }], details: value, terminate: true as const };
    },
  };
}

export function formatNavigatorReport(report: NavigatorReport): string {
  const playbookFailure = report.routePlaybookReadFailure === undefined
    ? []
    : [`路书读取失败：${report.routePlaybookReadFailure}`];
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
  let preparation: Promise<string | undefined> | undefined;
  let sessionReady: Promise<NavigatorPreparationSession> | undefined;
  let session: NavigatorPreparationSession | undefined;
  let subjectKey = options.subjectKey;
  let subject = options.subject;
  let authority = options.authority;
  let contextError = options.contextError;
  let preparedProse: string | undefined;
  // Shared lifecycle owns the principal when supplied; otherwise mint once per attendance.
  const invocationPrincipal = options.invocationId ?? mintNavigatorInvocationId();
  let activeInvocationId: string | undefined = invocationPrincipal;
  let outputSink: ((value: PrepareOutput) => void) | undefined;
  let settlementTail: Promise<void> = Promise.resolve();
  let settlementFailure: unknown;
  let preparationFailure: unknown;
  let routePlaybookReadFailure: string | undefined;
  let disposed = false;
  /** One-shot live-help warm; consumed by the next prepare so later prepares reread live help. */
  let warmedHelp: Promise<Array<{ role: NavigatorTargetRole; help: string }>> | undefined;

  const loadLiveHelp = async (): Promise<Array<{ role: NavigatorTargetRole; help: string }>> => {
    try {
      return await Promise.all(
        NAVIGATOR_TARGETS.map(async ({ role }) => ({
          role,
          help: await options.loadRoleHelp(role),
        })),
      );
    } catch (error) {
      throw navigatorUnavailableError("transport", error);
    }
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
  let routePlaybookSettlement: Promise<void> | undefined;
  /**
   * Settlement that the unique advice prompt must see. Early prepare() warms
   * session/materials only; settleOnce sets this and runs one bound prompt.
   * No speculative advice, no candidates/next parse, no second rebind ranking.
   */
  let prepareBoundSettlement: NavigatorSettlement | undefined;
  const prepare = async (): Promise<string | undefined> => {
    // Exact principal is owned by shared lifecycle (or one mint per attendance).
    // Model/tool/advice paths cannot override it; role-session persistence is
    // pi.appendEntry at lifecycle start — not optional sessionManager probing.
    const boundSettlement = prepareBoundSettlement;
    prepareBoundSettlement = undefined;
    const invocationId = invocationPrincipal;
    activeInvocationId = invocationId;
    if (contextError !== undefined) throw navigatorUnavailableError("context", contextError);
    if (typeof authority !== "string" || authority.trim() === "") {
      throw navigatorUnavailableError(
        "context",
        new Error("controlling authority content was not supplied as typed work context"),
      );
    }

      // Load soul / model setting / live help in parallel. Live help is N pi --help
      // subprocesses; serializing it behind session create made the post-role 10s
      // grace cover help-boot under load (ENOENT / unavailable flake). Session
      // create still follows context load so tool registration and prompt stay
      // one readiness step for callers.
      let soul: string;
      let modelSetting: string;
      let help: Array<{ role: NavigatorTargetRole; help: string }>;
      let routePlaybook = "";
      routePlaybookReadFailure = undefined;
      const soulPromise = (async () => {
        try {
          const text = (await options.loadSoul()).trim();
          if (!text) throw new Error("Navigator soul is empty");
          return text;
        } catch (error) {
          // Contract: README.md#Navigator-attendance — context-loading failures become typed unavailable reports while retaining the original cause.
          throw navigatorUnavailableError("context", error);
        }
      })();
      const routePlaybookPromise = (async () => {
        if (options.loadRoutePlaybook === undefined) return "";
        try {
          return await options.loadRoutePlaybook();
        } catch (error) {
          routePlaybookReadFailure = error instanceof Error ? error.message : String(error);
          return "";
        }
      })();
      // Preparation is fail-fast for its primary dependencies, but settlement
      // independently drains this optional diagnostic before emitting attendance.
      routePlaybookSettlement = routePlaybookPromise.then(() => undefined);
      const modelPromise = (async () => {
        try {
          // Same resolution authority as createNativeNavigatorSessionFactory (#590).
          const resolved = await resolveNavigatorSeatSelection(options.context);
          return resolved.configuredLabel;
        } catch (error) {
          if (error instanceof NavigatorUnavailableError) throw error;
          throw navigatorUnavailableError("model", error);
        }
      })();
      // Prefer one-shot warm from session_start; clear so the next prepare reloads live.
      const helpPromise = warmedHelp ?? loadLiveHelp();
      warmedHelp = undefined;
      [soul, routePlaybook, modelSetting, help] = await Promise.all([
        soulPromise,
        routePlaybookPromise,
        modelPromise,
        helpPromise,
      ]);

      let model: ReturnType<typeof parseNavigatorModelSetting>;
      try {
        model = parseNavigatorModelSetting(modelSetting);
      } catch (error) {
        throw navigatorUnavailableError("model", error);
      }
      const helpContext = help.map(({ role, help: text }) => `<role_help role="${role}">\n${text}\n</role_help>`).join("\n");
      let output: PrepareOutput | undefined;
      let prepareBatchRejected = false;
      outputSink = (value) => {
        // #836: extra prepare calls keep the first prose; later calls append as more prose.
        if (output === undefined) {
          output = value;
          return;
        }
        const prior = normalizePrepareProse(output) ?? "";
        const next = normalizePrepareProse(value) ?? "";
        const merged = [prior, next].filter((part) => part.trim() !== "").join("\n\n");
        output = { prose: merged };
      };
      const tool = createNavigatorPrepareTool((value) => { outputSink?.(value); });
      if (session === undefined) {
        sessionReady = (async () => {
          let created: NavigatorPreparationSession;
          try {
            created = await options.createSession({ context: options.context, subject: subjectKey, ...(options.modelSettingPath === undefined ? {} : { modelSettingPath: options.modelSettingPath }), tool });
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
          // Contract: README.md#Navigator-attendance — resumed-session configuration failures remain typed unavailable and retain the original cause.
          throw error instanceof NavigatorUnavailableError ? error : navigatorUnavailableError("session", error);
        }
        session.appendEntry(INVOCATION_ENTRY, { invocationId, role: options.role, phase: options.phase, subjectKey });
      }
      if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
      const activeSession = session;
      if (activeSession === undefined) throw new Error("Navigator session was not created");
      // #959: early prepare() warms session/materials only. Unique advice runs once
      // after settleOnce binds the just-completed settlement — no speculative prose.
      if (boundSettlement === undefined) {
        outputSink = undefined;
        preparedProse = undefined;
        return undefined;
      }
      const publicSettlementHistory = activeSession.entries()
        .filter((entry): entry is { type: "custom"; customType: string; data?: unknown } => exactRecord(entry) && entry.type === "custom" && entry.customType === SETTLEMENT_ENTRY && exactRecord(entry.data))
        .map((entry) => entry.data as NavigatorSettlementFact);
      // Opaque prior advice only — never parse, compare, or branch on content.
      const priorAdvice = activeSession.entries()
        .filter((entry): entry is { type: "custom"; customType: string; data?: unknown } => (
          exactRecord(entry)
          && entry.type === "custom"
          && entry.customType === PRIOR_ADVICE_ENTRY
          && exactRecord(entry.data)
          && entry.data.subjectKey === subjectKey
          && typeof entry.data.prose === "string"
          && entry.data.prose.trim() !== ""
        ))
        .map((entry) => (entry.data as { prose: string }).prose);
      const projection: NavigatorContextProjection = {
        subjectKey,
        subject,
        authority,
        currentRole: { role: options.role, phase: options.phase },
        currentSettlement: boundSettlement,
        priorAdvice,
        publicSettlementHistory,
        liveRoleHelp: help,
      };
      activeSession.appendEntry(CONTEXT_ENTRY, projection);
      const request = [
        "本次导航材料如下：",
        `<navigator_soul>\n${soul}\n</navigator_soul>`,
        ...(routePlaybookReadFailure === undefined
          ? [`<route_playbook>\n${routePlaybook}\n</route_playbook>`]
          : ["可选路线手册未能读取。"]),
        `<work_subject>\n${subject}\n</work_subject>`,
        `<controlling_authority>\n${authority}\n</controlling_authority>`,
        `<current_role>\n${JSON.stringify({ role: options.role, phase: options.phase })}\n</current_role>`,
        `<current_settlement>\n${JSON.stringify(boundSettlement)}\n</current_settlement>`,
        `<prior_advice>\n${JSON.stringify(priorAdvice)}\n</prior_advice>`,
        `<public_settlement_history>\n${JSON.stringify(projection.publicSettlementHistory)}\n</public_settlement_history>`,
        `<live_role_help>\n${helpContext}\n</live_role_help>`,
      ].join("\n\n");
      try {
        try {
          if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
          const delivery = createReceiptDeliveryPolicy();
          // Production prose arrives only via nested summon → prepare tool.execute
          // (navigator-public-session). No assistant-entry harvest — entries() is
          // archivist custom-only on the wired factory (#959).
          const promptAllowingRejectedPrepare = async (text: string, deliveryRequest: boolean) => {
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
              delivery.recordRejected(rejectedReason);
              return;
            }
            if (promptFailure !== undefined) throw promptFailure;
            const sessionNoReceipt = activeSession.noReceipt?.();
            if (sessionNoReceipt !== undefined) {
              // This session already settled without an accepted receipt on its own
              // budget; one more prompt opens an independent summon, not a delivery
              // request on the settled session (#675).
              delivery.recordNestedNoReceipt(sessionNoReceipt);
              return;
            }
            if (deliveryRequest && output === undefined) delivery.recordDeliveryRequest();
          };
          await promptAllowingRejectedPrepare(request, false);
          // #959: no typed-tool 催交 for missing prose. Continue only after a
          // rejected prepare while budget remains (correction).
          while (output === undefined && prepareBatchRejected && delivery.nextAction() === "request-delivery") {
            await promptAllowingRejectedPrepare(RECEIPT_DELIVERY_PROMPT, true);
          }
          // No prepare tool output: exhaust budget silently (no 催交 prompt) so
          // no_receipt facts stay lawful — mirrors role-runtime navigator exit.
          if (output === undefined && delivery.nextAction() === "request-delivery") {
            while (delivery.nextAction() === "request-delivery") {
              delivery.recordDeliveryRequest();
            }
          }
          if (output === undefined && delivery.nextAction() === "no-receipt" && activeSession.providerFailure?.() === undefined) {
            const facts = delivery.facts({ runPointer: activeSession.recordPointer(), attemptPointer: invocationId });
            activeSession.appendEntry(NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, facts);
            preparedProse = undefined;
            return undefined;
          }
        } catch (error) {
          throw error instanceof NavigatorUnavailableError ? error : navigatorUnavailableError("transport", error);
        }
        if (output === undefined) {
          const nativeFailure = [...activeSession.entries()].reverse().find((entry: unknown) => {
            if (!exactRecord(entry) || entry.type !== "message" || !exactRecord(entry.message)) return false;
            return entry.message.role === "assistant" && typeof entry.message.errorMessage === "string" && entry.message.errorMessage.trim() !== "";
          });
          const nativeMessage = exactRecord(nativeFailure) && exactRecord(nativeFailure.message) ? nativeFailure.message : undefined;
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
        preparedProse = normalizePrepareProse(output);
        return preparedProse;
      } finally {
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
      subject = next.subject;
      authority = next.authority;
      contextError = next.contextError;
      return closing;
    },
    /**
     * Start live-help subprocesses during activation without beginning full
     * preparation. Next prepare() consumes the warm result; a later prepare
     * reloads so live help edits remain visible.
     */
    warmHelp(): void {
      if (disposed || warmedHelp !== undefined || preparation !== undefined) return;
      warmedHelp = loadLiveHelp();
      // Prevent unhandled rejection if attendance is disposed before prepare.
      void warmedHelp.catch(() => undefined);
    },
    prepare(): void {
      if (disposed || preparation !== undefined) return;
      preparationFailure = undefined;
      preparation = prepare();
      // Contract: README.md#Navigator-attendance — background preparation rejection is drained so the later typed settlement can report unavailable; retain the exact cause until settlement.
      void preparation.catch((error) => { preparationFailure = error; });
    },
    isPreparing(): boolean {
      return preparation !== undefined || sessionReady !== undefined;
    },
    knownRoutePlaybookReadFailure(): string | undefined {
      return routePlaybookReadFailure;
    },
    settle(settlement: NavigatorSettlement): Promise<void> {
      const next = settlementTail.then(() => settleOnce(settlement));
      // Contract: README.md#Navigator-attendance — rejected attendance settlements are drained only to serialize later attendance; retain the exact rejection for the caller/audit path.
      settlementTail = next.catch((error) => { settlementFailure = error; });
      return next;
    },
    dispose(): void | Promise<void> {
      disposed = true;
      // Leave sessionReady so an in-flight createSession observes disposed and drains exactly once.
      // Late settleOnce completion observes disposed and skips onEvent.
      const current = session;
      session = undefined;
      activeInvocationId = undefined;
      return current?.dispose();
    },
  };

  async function settleOnce(settlement: NavigatorSettlement): Promise<void> {
      // Dispose during post-role grace must ignore late completion entirely (#675).
      if (disposed) return;
      const invocationId = activeInvocationId ?? invocationPrincipal;
      let report: NavigatorReport;
      // Drain in-flight warm prepare so the next driver cannot start a second
      // session create on the same attendance. Warm returns no prose.
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
      // Every settlement kind books the nest (including arrival) so history stays complete.
      // Arrival still does not run the advice prompt.
      if (session === undefined && preparationFailure === undefined) {
        preparation = prepare();
        try { await preparation; } catch (error) { preparationFailure ??= error; }
        preparation = undefined;
      }
      session?.appendEntry(SETTLEMENT_ENTRY, settlementFact);
      let drainedProse: string | undefined;
      if (settlement.kind === "arrival") {
        if (preparationFailure !== undefined) {
          report = unavailable(invocationId, preparationFailure);
        } else {
          report = {
            disposition: "arrival",
            ...(settlement.message === undefined ? {} : { arrivalMessage: settlement.message }),
          };
        }
      } else {
        // Unique advice after the current settlement is known. Clear warm-path
        // failure only when a session already exists so bound prepare can run;
        // hard warm failures (no session) stay typed unavailable.
        if (session !== undefined) preparationFailure = undefined;
        if (preparationFailure === undefined) {
          prepareBoundSettlement = settlement;
          preparation = prepare();
          void preparation.catch((error) => { preparationFailure = error; });
          try {
            drainedProse = await preparation;
          } catch (error) {
            preparationFailure ??= error;
          }
          preparation = undefined;
        }
        if (preparationFailure !== undefined) {
          // Contract: README.md#Navigator-attendance — failed attendance is typed
          // unavailable without invalidating the role Receipt; retain the cause.
          report = unavailable(invocationId, preparationFailure);
        } else if (typeof drainedProse === "string" && drainedProse.trim() !== "") {
          // #959: present prose as-is on every parent outcome — including
          // human_decision / escalate. Old path wiped prose on escalate and left
          // auto-attendance looking empty after a successful nested summon.
          report = { disposition: "advice", prose: drainedProse };
          // Opaque memory only — model may use it later; code never parses it.
          session?.appendEntry(PRIOR_ADVICE_ENTRY, {
            invocationId,
            subjectKey,
            prose: drainedProse,
          });
        } else {
          // Empty/no-receipt prepare → affirmative no-advice (never inferred later).
          report = { disposition: "no-advice" };
        }
      }
      // A primary preparation failure may reject Promise.all before the optional
      // routebook read finishes. Preserve that primary unavailable cause while
      // waiting for, and independently attaching, the routebook diagnostic.
      await routePlaybookSettlement;
      if (routePlaybookReadFailure !== undefined) {
        report = { ...report, routePlaybookReadFailure };
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
      preparedProse = undefined;
      preparationFailure = undefined;
      routePlaybookSettlement = undefined;
      routePlaybookReadFailure = undefined;
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
