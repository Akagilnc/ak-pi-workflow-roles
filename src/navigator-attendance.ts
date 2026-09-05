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
import { PACKAGED_ROLE_REGISTRY, type PackagedRole, packagedRoleMetadata } from "./packaged-role-registry.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";
import type { HostContext } from "./host-contracts.ts";
import { createNativeNavigatorSessionFactory } from "./navigator-public-session.ts";
import {
  NAVIGATOR_DEFAULT_MODEL,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NavigatorUnavailableError,
  navigatorModelSettingPath,
  navigatorProviderFailure,
  navigatorProviderFailureFromDiagnostics,
  navigatorProviderFailureFromError,
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
  NAVIGATOR_DEFAULT_MODEL,
  NAVIGATOR_PREPARE_TOOL_NAME,
  NavigatorUnavailableError,
  navigatorModelSettingPath,
  navigatorProviderFailure,
  navigatorProviderFailureFromDiagnostics,
  navigatorProviderFailureFromError,
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
import { renderPublicAkRoleCommand } from "./public-command-renderer.ts";
import { issueRoot, subjectPath } from "./work-subject-identity.ts";
import { createReceiptDeliveryPolicy, NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, RECEIPT_DELIVERY_PROMPT } from "./receipt-delivery-policy.ts";

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

/** Workflow-route seats only — nested summon seats stay public but are not route targets. */
const NAVIGATOR_ROUTE_EXCLUSIONS = new Set(["auditor", "evidence-child"]);
export const NAVIGATOR_TARGETS = PACKAGED_ROLE_REGISTRY
  .filter(({ role }) => !NAVIGATOR_ROUTE_EXCLUSIONS.has(role))
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

export type NavigatorRouteTarget = { role: NavigatorTargetRole; phase: NavigatorPhase };
/** Normalized preparation advice. v1 success needs machine-usable next only. */
export type NavigatorCandidate = {
  id?: string;
  matches?: { role: string; phase: NavigatorPhase; kind: "accepted"; statuses?: string[] };
  route?: NavigatorRouteTarget[];
  next?: NavigatorRouteTarget;
  reason?: string;
};

export type NavigatorReport = {
  /** Affirmative attendance only. Lawful no-advice is typed, never inferred from absence. */
  disposition: "recommendation" | "no-advice" | "unavailable" | "arrival";
  route?: NavigatorRouteTarget[];
  next?: NavigatorRouteTarget;
  reason?: string;
  command?: string;
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
  route?: NavigatorRouteTarget[];
  next?: NavigatorRouteTarget;
  reason?: string;
  command?: string;
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
  /** Present only on settlement-bound prepare; speculative prepare omits it. */
  currentSettlement?: NavigatorSettlement;
  priorRoute: NavigatorRouteTarget[] | null;
  publicSettlementHistory: NavigatorSettlementFact[];
  liveRoleHelp: Array<{ role: NavigatorTargetRole; help: string }>;
};

// Provider admission is ADR 0060 object root only. Nested advisory shape
// (candidates/next/route/matches/reason/command) is never a gate — every object
// root reaches the unique execute/normalize path exactly once.
// Field guidance only — candidates shape is never an acceptance gate (Rule 0).
const prepareSchema = Type.Object({
  candidates: Type.Optional(Type.Unknown({
    description:
      "方向候选；candidates[].next.role 必填，phase 可选，route/matches/reason/command 可选上下文，非受理闸",
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

const ROUTE_ENTRY = "ak-navigator-route";
const CONTEXT_ENTRY = "ak-navigator-context";
const INVOCATION_ENTRY = NAVIGATOR_INVOCATION_ENTRY;
const SETTLEMENT_ENTRY = "ak-navigator-settlement";
const targetRoles = new Set<string>(NAVIGATOR_TARGETS.map(({ role }) => role));
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
function targetIsValid(value: unknown): value is NavigatorRouteTarget {
  if (!exactRecord(value) || !targetRoles.has(String(value.role))) return false;
  const metadata = packagedRoleMetadata(String(value.role));
  return metadata !== undefined && metadata.phases.includes(value.phase as never);
}

/** Normalize one advice target. Phase is kept only when present and meaningful; bare role stays usable. */
function normalizeTarget(value: unknown): NavigatorRouteTarget | undefined {
  if (!exactRecord(value)) return undefined;
  const role = typeof value.role === "string" ? value.role.trim() : "";
  if (!targetRoles.has(role)) return undefined;
  const metadata = packagedRoleMetadata(role);
  if (metadata === undefined) return undefined;
  if (value.phase === undefined || value.phase === null) {
    return { role: role as NavigatorTargetRole, phase: null };
  }
  if (value.phase === "plan" || value.phase === "apply") {
    if (metadata.phases.includes(value.phase as never)) {
      return { role: role as NavigatorTargetRole, phase: value.phase };
    }
    // Present but not meaningful for this role → drop to bare role direction.
    return { role: role as NavigatorTargetRole, phase: null };
  }
  return undefined;
}

function normalizeMatches(value: unknown): NavigatorCandidate["matches"] | undefined {
  if (!exactRecord(value)) return undefined;
  if (typeof value.role !== "string" || value.role.trim() === "") return undefined;
  if (value.kind !== "accepted") return undefined;
  let phase: NavigatorPhase;
  if (value.phase === undefined || value.phase === null) phase = null;
  else if (value.phase === "plan" || value.phase === "apply") phase = value.phase;
  else return undefined;
  if (value.statuses !== undefined) {
    if (!Array.isArray(value.statuses) || value.statuses.some((status) => typeof status !== "string" || status.trim() === "")) {
      return undefined;
    }
    return {
      role: value.role,
      phase,
      kind: "accepted",
      statuses: [...value.statuses],
    };
  }
  return { role: value.role, phase, kind: "accepted" };
}

/** Normalize one submitted candidate. Broken ancillary fields are dropped, never a rejection. */
function normalizeCandidate(value: unknown): NavigatorCandidate | undefined {
  if (!exactRecord(value)) return undefined;
  const next = normalizeTarget(value.next);
  const route = Array.isArray(value.route)
    ? value.route.map(normalizeTarget).filter((target): target is NavigatorRouteTarget => target !== undefined)
    : undefined;
  const matches = normalizeMatches(value.matches);
  const id = typeof value.id === "string" && value.id.trim() !== "" ? value.id : undefined;
  const reason = typeof value.reason === "string" && value.reason.trim() !== "" ? value.reason : undefined;
  // Model command prose is never execution authority; omit from normalized advice.
  return {
    ...(id === undefined ? {} : { id }),
    ...(matches === undefined ? {} : { matches }),
    ...(route === undefined || route.length === 0 ? {} : { route }),
    ...(next === undefined ? {} : { next }),
    ...(reason === undefined ? {} : { reason }),
  };
}

/** Accept any prepare submission shape; missing/malformed candidates become empty advice. */
function normalizePrepareOutput(value: unknown): NavigatorCandidate[] {
  if (!exactRecord(value) || !Array.isArray(value.candidates)) return [];
  return value.candidates
    .map(normalizeCandidate)
    .filter((candidate): candidate is NavigatorCandidate => candidate !== undefined);
}

function routeEqual(a: readonly NavigatorRouteTarget[] | undefined, b: readonly NavigatorRouteTarget[]): boolean {
  return a !== undefined && a.length === b.length && a.every((target, index) => target.role === b[index]!.role && target.phase === b[index]!.phase);
}
function routeText(route: readonly NavigatorRouteTarget[]): string {
  return route.map((target) => target.phase === null ? target.role : `${target.role} ${target.phase}`).join(" → ");
}
function targetText(target: NavigatorRouteTarget): string {
  return target.phase === null ? target.role : `${target.role} ${target.phase}`;
}
function oneLine(value: string): string {
  return value.split(/\r?\n/, 1)[0]!.trim();
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
    description: "提交游奕使方向建议。",
    parameters: prepareSchema,
    async execute(_id, value) {
      // Rule 0: the unique prepare submission is accepted once. Ancillary shape is
      // normalized later; never open a format-correction retry loop here.
      onOutput(value as PrepareOutput);
      return { content: [{ type: "text" as const, text: NAVIGATOR_PREPARE_ACCEPTED_TEXT }], details: value, terminate: true as const };
    },
  };
}

/**
 * Candidate pick plus whether matches keyed it to this settlement.
 * Single owner for role/phase/status match truth (selection ranking + stale-context rebind).
 * Structural only — never inspects next.role for routing legality.
 */
export type NavigatorCandidateSelection = {
  readonly candidate: NavigatorCandidate;
  /** True when matches keyed this candidate to the settlement (no stale-context rebind). */
  readonly matchedToSettlement: boolean;
};

export function selectNavigatorCandidate(
  candidates: readonly NavigatorCandidate[],
  settlement: NavigatorSettlement,
): NavigatorCandidateSelection | undefined {
  if (settlement.kind !== "accepted") return undefined;
  const usable = candidates.filter((candidate) => candidate.next !== undefined);
  if (usable.length === 0) return undefined;
  const rolePhaseMatched = usable.filter((candidate) =>
    candidate.matches !== undefined
    && candidate.matches.role === settlement.role
    && candidate.matches.phase === settlement.phase,
  );
  // Status-specific candidates outrank role/phase generics regardless of declaration order.
  if (rolePhaseMatched.length > 0) {
    if (settlement.status !== undefined) {
      const statusSpecific = rolePhaseMatched.find(
        (candidate) =>
          candidate.matches?.statuses !== undefined &&
          candidate.matches.statuses.includes(settlement.status!),
      );
      if (statusSpecific !== undefined) {
        return { candidate: statusSpecific, matchedToSettlement: true };
      }
    }
    const rolePhaseGeneric = rolePhaseMatched.find(
      (candidate) => candidate.matches?.statuses === undefined,
    );
    if (rolePhaseGeneric !== undefined) {
      return { candidate: rolePhaseGeneric, matchedToSettlement: true };
    }
    return undefined;
  }
  // v1 direction-only / broken matches: absent match metadata must not drop a usable next.
  // Not settlement-keyed → caller may run one stale-context rebind.
  const unbound = usable.find((candidate) => candidate.matches === undefined);
  if (unbound === undefined) return undefined;
  return { candidate: unbound, matchedToSettlement: false };
}

export function formatNavigatorReport(report: NavigatorReport): string {
  const playbookFailure = report.routePlaybookReadFailure === undefined
    ? []
    : [`路书读取失败：${oneLine(report.routePlaybookReadFailure)}`];
  if (report.disposition === "no-advice") return playbookFailure.join("\n");
  if (report.disposition === "unavailable") return [...playbookFailure, `导航不可用：${oneLine(report.unavailableReason ?? "未能完成导航准备")}`].join("\n");
  if (report.disposition === "arrival") return [...playbookFailure, oneLine(report.arrivalMessage ?? "已到达目的地")].join("\n");
  return [
    ...playbookFailure,
    ...(report.route === undefined ? [] : [`路线：${routeText(report.route)}`]),
    `下一步：${targetText(report.next!)}`,
    ...(report.reason === undefined || report.reason.trim() === "" ? [] : [`理由：${oneLine(report.reason)}`]),
    ...(report.command === undefined || report.command.trim() === "" ? [] : [`命令：${oneLine(report.command)}`]),
  ].join("\n");
}

export type SettlementNavigation = {
  disposition: "recommendation";
  route?: NavigatorRouteTarget[];
  next: NavigatorRouteTarget;
  reason?: string;
  command?: string;
};

/** Recommendation essentials for the one mandatory last-ak_*_output extraction. */
export function settlementNavigationFromEvent(event: NavigatorEvent): SettlementNavigation | undefined {
  if (event.disposition !== "recommendation") return undefined;
  if (event.next === undefined) return undefined;
  return {
    disposition: "recommendation",
    ...(event.route === undefined ? {} : { route: event.route }),
    next: event.next,
    ...(event.reason === undefined ? {} : { reason: event.reason }),
    ...(event.command === undefined ? {} : { command: event.command }),
  };
}

type SettlementTextPart = { type: "text"; text: string };

function appendNavigatorReportToContent<T extends { type: string }>(
  content: readonly T[],
  reportText: string,
): Array<T | SettlementTextPart> {
  if (reportText === "") return content.slice();
  const parts: Array<T | SettlementTextPart> = content.slice();
  for (let index = parts.length - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part !== undefined && part.type === "text" && typeof (part as SettlementTextPart).text === "string") {
      parts[index] = { ...(part as object), type: "text", text: `${(part as SettlementTextPart).text}\n${reportText}` } as SettlementTextPart;
      return parts;
    }
  }
  return [...parts, { type: "text", text: reportText }];
}

/**
 * Decorate an accepted role-output tool result so the one mandatory settlement
 * extraction (last ak_*_output toolResult) carries recommendation essentials in
 * content text. Receipt details stay byte-identical to the terminating-tool
 * contract — unavailable and affirmative no-advice leave the settlement untouched.
 */
export function decorateSettlementWithNavigation<T extends { type: string }>(
  event: { content: readonly T[]; details: unknown },
  presentation: { event: NavigatorEvent; report: NavigatorReport } | undefined,
): { content: Array<T | SettlementTextPart>; details: unknown } | undefined {
  if (presentation === undefined) return undefined;
  if (settlementNavigationFromEvent(presentation.event) === undefined) return undefined;
  const { routePlaybookReadFailure: _advisoryFailure, ...receiptReport } = presentation.report;
  const reportText = formatNavigatorReport(receiptReport);
  if (reportText === "") return undefined;
  return {
    content: appendNavigatorReportToContent(event.content, reportText),
    details: event.details,
  };
}

export function createNavigatorAttendance(options: NavigatorAttendanceOptions) {
  let preparation: Promise<NavigatorCandidate[]> | undefined;
  let sessionReady: Promise<NavigatorPreparationSession> | undefined;
  let session: NavigatorPreparationSession | undefined;
  let subjectKey = options.subjectKey;
  let subject = options.subject;
  let authority = options.authority;
  let contextError = options.contextError;
  let candidates: NavigatorCandidate[] | undefined;
  // Shared lifecycle owns the principal when supplied; otherwise mint once per attendance.
  const invocationPrincipal = options.invocationId ?? mintNavigatorInvocationId();
  let activeInvocationId: string | undefined = invocationPrincipal;
  let previousRoute: NavigatorRouteTarget[] | undefined;
  let outputSink: ((value: PrepareOutput) => void) | undefined;
  let settlementTail: Promise<void> = Promise.resolve();
  let settlementFailure: unknown;
  let preparationFailure: unknown;
  let preparationNoReceipt = false;
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
  /** Settlement-bound prepare only; cleared at the start of each prepare body. */
  let prepareBoundSettlement: NavigatorSettlement | undefined;
  const prepare = async (): Promise<NavigatorCandidate[]> => {
    // Exact principal is owned by shared lifecycle (or one mint per attendance).
    // Model/tool/advice paths cannot override it; role-session persistence is
    // pi.appendEntry at lifecycle start — not optional sessionManager probing.
    const boundSettlement = prepareBoundSettlement;
    prepareBoundSettlement = undefined;
    // Each prepare owns the no-receipt flag; a later settlement-bound rebind must
    // not inherit a speculative no-receipt outcome.
    preparationNoReceipt = false;
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
          const resolved = await resolveNavigatorSeatSelection(
            options.context,
            options.modelSettingPath,
            options.modelSettingPath ?? navigatorModelSettingPath(),
          );
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
        if (prepareBatchRejected || output !== undefined) {
          // Tool executions in one assistant response are provisional until the
          // whole response is known to contain exactly one submission. A
          // duplicate invalidates the batch, including its first call.
          output = undefined;
          prepareBatchRejected = true;
          throw new Error("Navigator preparation must submit exactly one typed candidate batch");
        }
        output = value;
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
            if (created.getThinkingLevel?.() !== undefined && created.getThinkingLevel() !== model.thinkingLevel) {
              throw new NavigatorUnavailableError("thinking", `Navigator thinking level ${model.thinkingLevel} is unavailable for ${modelSetting}`);
            }
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
          if (session.getThinkingLevel?.() !== undefined && session.getThinkingLevel() !== model.thinkingLevel) {
            throw new NavigatorUnavailableError("thinking", `Navigator thinking level ${model.thinkingLevel} is unavailable for ${modelSetting}`);
          }
        } catch (error) {
          // Contract: README.md#Navigator-attendance — resumed-session configuration failures remain typed unavailable and retain the original cause.
          throw error instanceof NavigatorUnavailableError ? error : navigatorUnavailableError("session", error);
        }
        session.appendEntry(INVOCATION_ENTRY, { invocationId, role: options.role, phase: options.phase, subjectKey });
      }
      if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
      const activeSession = session;
      if (activeSession === undefined) throw new Error("Navigator session was not created");
      const prior = activeSession.entries().filter((entry): entry is { type: "custom"; customType: string; data?: unknown } => exactRecord(entry) && entry.type === "custom" && entry.customType === ROUTE_ENTRY && exactRecord(entry.data) && entry.data.subjectKey === subjectKey).at(-1)?.data;
      if (exactRecord(prior) && Array.isArray(prior.route) && prior.route.every((target) => targetIsValid(target))) {
        previousRoute = prior.route.map((target) => ({ role: target.role as NavigatorTargetRole, phase: target.phase as NavigatorPhase }));
      }
      const publicSettlementHistory = activeSession.entries()
        .filter((entry): entry is { type: "custom"; customType: string; data?: unknown } => exactRecord(entry) && entry.type === "custom" && entry.customType === SETTLEMENT_ENTRY && exactRecord(entry.data))
        .slice(-8)
        .map((entry) => entry.data as NavigatorSettlementFact);
      const projection: NavigatorContextProjection = {
        subjectKey,
        subject,
        authority,
        currentRole: { role: options.role, phase: options.phase },
        ...(boundSettlement === undefined ? {} : { currentSettlement: boundSettlement }),
        priorRoute: exactRecord(prior) && Array.isArray(prior.route) && prior.route.every((target) => targetIsValid(target))
          ? prior.route.map((target) => ({ role: target.role as NavigatorTargetRole, phase: target.phase as NavigatorPhase }))
          : null,
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
        ...(boundSettlement === undefined
          ? []
          : [`<current_settlement>\n${JSON.stringify(boundSettlement)}\n</current_settlement>`]),
        `<prior_route>\n${JSON.stringify(prior ?? null)}\n</prior_route>`,
        `<public_settlement_history>\n${JSON.stringify(projection.publicSettlementHistory)}\n</public_settlement_history>`,
        `<live_role_help>\n${helpContext}\n</live_role_help>`,
      ].join("\n\n");
      try {
        try {
          if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
          const delivery = createReceiptDeliveryPolicy();
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
            if (deliveryRequest && output === undefined) delivery.recordDeliveryRequest();
          };
          await promptAllowingRejectedPrepare(request, false);
          while (output === undefined && delivery.nextAction() === "request-delivery") {
            await promptAllowingRejectedPrepare(RECEIPT_DELIVERY_PROMPT, true);
          }
          if (output === undefined && delivery.nextAction() === "no-receipt" && activeSession.providerFailure?.() === undefined) {
            const facts = delivery.facts({ runPointer: activeSession.recordPointer(), attemptPointer: invocationId });
            activeSession.appendEntry(NO_RECEIPT_LIFECYCLE_ENTRY_TYPE, facts);
            preparationNoReceipt = true;
            candidates = [];
            return candidates;
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
        candidates = normalizePrepareOutput(output);
        return candidates;
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
        previousRoute = undefined;
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
      if (settlement.kind === "human_decision" || settlement.kind === "role_infrastructure_failure") {
        // Contract: lawful human/role outcomes emit affirmative typed no-advice when
        // preparation completed; rejected preparation remains typed unavailable.
        // Drain the in-flight work so the next driver input cannot start a second prompt on the same native session.
        if (sessionReady !== undefined) {
          try { await sessionReady; } catch (error) { preparationFailure ??= error; }
        }
        if (preparation !== undefined) {
          try { await preparation; } catch (error) { preparationFailure ??= error; }
        }
        session?.appendEntry(SETTLEMENT_ENTRY, { invocationId, subjectKey, role: settlement.role, phase: settlement.phase, kind: settlement.kind, ...(settlement.kind === "human_decision" ? { status: settlement.status } : {}) });
        if (preparationFailure !== undefined) {
          report = unavailable(invocationId, preparationFailure);
        } else {
          // Affirmative no-advice attendance — never inferred later from absence.
          report = { disposition: "no-advice" };
        }
      } else if (settlement.kind === "arrival") {
        // Contract: README.md#Navigator-attendance — failed attendance is reported as typed unavailable rather than silently discarded.
        if (sessionReady !== undefined) {
          try { await sessionReady; } catch (error) { preparationFailure ??= error; }
        }
        if (preparation !== undefined) {
          try { await preparation; } catch (error) { preparationFailure ??= error; }
        }
        report = preparationFailure === undefined
          ? { disposition: "arrival", arrivalMessage: settlement.message ?? "已到达目的地" }
          : unavailable(invocationId, preparationFailure);
      } else if (preparation === undefined) {
        report = unavailable(invocationId, "Navigator preparation did not start");
      } else {
        try {
          if (sessionReady !== undefined) await sessionReady;
          let prepared = await preparation;
          session?.appendEntry(SETTLEMENT_ENTRY, { invocationId, subjectKey, role: settlement.role, phase: settlement.phase, kind: settlement.kind, ...(settlement.status === undefined ? {} : { status: settlement.status }) });
          let selected = selectNavigatorCandidate(prepared, settlement);
          // Speculative prepare runs before this terminal exists and may treat prior
          // history as decisive. When selection provenance says matches did not key
          // this candidate to the settlement, rebind once with currentSettlement.
          // Stale-context repair only — reachable without any next.role legality
          // table. After selection (speculative or rebound), advice is passed
          // through as-is (ADR 0010 / ADR 0061: caller may ignore).
          if (selected?.candidate.next !== undefined && !selected.matchedToSettlement) {
            if (disposed) return;
            prepareBoundSettlement = settlement;
            prepared = await prepare();
            if (disposed) return;
            selected = selectNavigatorCandidate(prepared, settlement);
          }
          // Budget exhaustion is affirmative typed no-advice; malformed submitted
          // advice remains the existing unavailable path.
          const selectedCandidate = selected?.candidate;
          if (selectedCandidate?.next === undefined && preparationNoReceipt) {
            report = { disposition: "no-advice" };
          } else if (selectedCandidate?.next === undefined) {
            throw new Error("Navigator prepared no machine-usable next direction");
          } else {
          const selectedRoute = selectedCandidate.route;
          const routeChanged = selectedRoute !== undefined && !routeEqual(previousRoute, selectedRoute);
          // Single owner: public registry renderer (ADR 0052). Model command prose is never authority.
          const command = renderPublicAkRoleCommand(selectedCandidate.next);
          report = {
            disposition: "recommendation",
            ...(routeChanged ? { route: selectedRoute } : {}),
            next: selectedCandidate.next,
            ...(selectedCandidate.reason === undefined ? {} : { reason: oneLine(selectedCandidate.reason) }),
            ...(command === undefined ? {} : { command }),
          };
          if (selectedRoute !== undefined) {
            previousRoute = selectedRoute;
            session?.appendEntry(ROUTE_ENTRY, { invocationId, subjectKey, route: selectedRoute });
          }
          }
        // Contract: README.md#Navigator-attendance — Navigator failures become typed unavailable without invalidating the role Receipt; retain the original cause in the unavailable report.
        } catch (error) {
          report = unavailable(invocationId, error);
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
        ...(report.route === undefined ? {} : { route: report.route }),
        ...(report.next === undefined ? {} : { next: report.next }),
        ...(report.reason === undefined ? {} : { reason: report.reason }),
        ...(report.command === undefined ? {} : { command: report.command }),
        ...(report.unavailableReason === undefined ? {} : { unavailableReason: report.unavailableReason }),
        ...(report.unavailableSource === undefined ? {} : { unavailableSource: report.unavailableSource }),
        ...(report.unavailableCause === undefined ? {} : { unavailableCause: report.unavailableCause }),
        ...(report.routePlaybookReadFailure === undefined ? {} : { routePlaybookReadFailure: report.routePlaybookReadFailure }),
        ...(report.arrivalMessage === undefined ? {} : { arrivalMessage: report.arrivalMessage }),
      };
      // Dispose during post-role grace must ignore late completion (ADR 0052 / #106 / #675).
      // Every settled disposition (recommendation | no-advice | unavailable | arrival) is affirmative.
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
      candidates = undefined;
      preparationFailure = undefined;
      preparationNoReceipt = false;
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
