import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { createAgentSession, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext, type ExtensionAPI, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import {
  NAVIGATOR_INVOCATION_ENTRY,
  mintNavigatorInvocationId,
} from "./navigator-invocation-identity.ts";
import { PACKAGED_ROLE_REGISTRY, type PackagedRole, packagedRoleMetadata } from "./packaged-role-registry.ts";
import { renderPublicAkRoleCommand } from "./public-command-renderer.ts";
import { subjectPath } from "./work-subject-identity.ts";

export const NAVIGATOR_EVENT_TYPE = "ak-navigator-attendance" as const;
export const NAVIGATOR_PREPARE_TOOL_NAME = "ak_navigator_prepare" as const;
export const NAVIGATOR_DEFAULT_MODEL = "openai-codex/gpt-5.6-luna:max" as const;

export const NAVIGATOR_TARGETS = PACKAGED_ROLE_REGISTRY.map(({ role, phases }) => ({ role, phases }));

export type NavigatorTargetRole = PackagedRole;
export type NavigatorPhase = "plan" | "apply" | null;
export type NavigatorUnavailableKey = "context" | "session" | "model" | "thinking" | "auth" | "quota" | "transport" | "unknown";

export class NavigatorUnavailableError extends Error {
  readonly unavailableSource: NavigatorUnavailableKey;
  readonly unavailableCause: NavigatorUnavailableKey;
  readonly originalCause: unknown;

  constructor(source: NavigatorUnavailableKey, message: string, cause: NavigatorUnavailableKey = source, originalCause?: unknown) {
    super(message);
    this.name = "NavigatorUnavailableError";
    this.unavailableSource = source;
    this.unavailableCause = cause;
    this.originalCause = originalCause;
  }
}

export type NavigatorProviderFailureFact = {
  source: NavigatorUnavailableKey;
  cause: NavigatorUnavailableKey;
};

export type NavigatorProviderErrorShape = {
  statusCode?: number;
  status?: number;
  code?: string;
};

function navigatorProviderFailureFromStatus(status: number | undefined): NavigatorProviderFailureFact | undefined {
  if (status === 401 || status === 403) return { source: "auth", cause: "auth" };
  if (status === 429) return { source: "quota", cause: "quota" };
  return undefined;
}

function navigatorProviderFailureFromCode(code: unknown): NavigatorProviderFailureFact | undefined {
  if (typeof code === "number") {
    return navigatorProviderFailureFromStatus(code);
  }
  if (typeof code !== "string") return undefined;
  if (code === "unauthorized" || code === "authentication_failed") return { source: "auth", cause: "auth" };
  if (code === "insufficient_quota" || code === "quota_exhausted") return { source: "quota", cause: "quota" };
  if (code === "transport_error") return { source: "transport", cause: "transport" };
  return undefined;
}

export function navigatorProviderFailureFromError(error: unknown): NavigatorProviderFailureFact | undefined {
  if (!exactRecord(error)) return undefined;
  const statusCode = typeof error.statusCode === "number"
    ? error.statusCode
    : typeof error.status === "number"
      ? error.status
      : undefined;
  return navigatorProviderFailureFromStatus(statusCode) ?? navigatorProviderFailureFromCode(error.code);
}

function navigatorProviderFailureFromDiagnostics(diagnostics: unknown): NavigatorProviderFailureFact | undefined {
  if (!Array.isArray(diagnostics)) return undefined;
  for (const diagnostic of diagnostics) {
    if (!exactRecord(diagnostic)) continue;
    if (diagnostic.type === "provider_transport_failure") return { source: "transport", cause: "transport" };
    if (exactRecord(diagnostic.error)) {
      const fromCode = navigatorProviderFailureFromCode(diagnostic.error.code);
      if (fromCode !== undefined) return fromCode;
    }
    if (exactRecord(diagnostic.details)) {
      const status = typeof diagnostic.details.status === "number"
        ? diagnostic.details.status
        : typeof diagnostic.details.statusCode === "number"
          ? diagnostic.details.statusCode
          : undefined;
      const fromStatus = navigatorProviderFailureFromStatus(status);
      if (fromStatus !== undefined) return fromStatus;
      const fromCode = navigatorProviderFailureFromCode(diagnostic.details.code);
      if (fromCode !== undefined) return fromCode;
    }
  }
  return undefined;
}

const navigatorProviderFailureSchema = Type.Object({
  source: Type.Union([Type.Literal("context"), Type.Literal("session"), Type.Literal("model"), Type.Literal("thinking"), Type.Literal("auth"), Type.Literal("quota"), Type.Literal("transport"), Type.Literal("unknown")]),
  cause: Type.Union([Type.Literal("context"), Type.Literal("session"), Type.Literal("model"), Type.Literal("thinking"), Type.Literal("auth"), Type.Literal("quota"), Type.Literal("transport"), Type.Literal("unknown")]),
}, { additionalProperties: false });

export function navigatorProviderFailure<T extends object>(message: T, source: NavigatorUnavailableKey, cause: NavigatorUnavailableKey = source): T & { navigatorFailure: NavigatorProviderFailureFact } {
  const fact = { source, cause } satisfies NavigatorProviderFailureFact;
  if (!Value.Check(navigatorProviderFailureSchema, fact)) throw new TypeError("Navigator provider failure fact is not typed");
  return Object.assign(message, { navigatorFailure: fact });
}

export function navigatorUnavailableError(source: NavigatorUnavailableKey, error: unknown, cause: NavigatorUnavailableKey = source): NavigatorUnavailableError {
  const message = error instanceof Error ? error.message : String(error);
  return error instanceof NavigatorUnavailableError ? error : new NavigatorUnavailableError(source, message, cause, error);
}
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
  arrivalMessage?: string;
};

export type NavigatorSettlementFact = NavigatorSettlement & { invocationId: string; subjectKey: string };
export type NavigatorContextProjection = {
  subjectKey: string;
  subject: string;
  authority: string;
  currentRole: { role: string; phase: NavigatorPhase };
  priorRoute: NavigatorRouteTarget[] | null;
  publicSettlementHistory: NavigatorSettlementFact[];
  liveRoleHelp: Array<{ role: NavigatorTargetRole; help: string }>;
};

// Provider admission is ADR 0060 object root only. Nested advisory shape
// (candidates/next/route/matches/reason/command) is never a gate — every object
// root reaches the unique execute/normalize path exactly once.
const prepareSchema = Type.Object({}, { additionalProperties: true });
type PrepareOutput = Static<typeof prepareSchema>;

export type NavigatorPreparationSession = {
  prompt(text: string): Promise<void>;
  appendEntry(customType: string, data: unknown): void;
  entries(): readonly unknown[];
  providerFailure?(): NavigatorProviderFailureFact | undefined;
  setModel?(model: string, thinkingLevel: "off" | "max"): Promise<void>;
  getThinkingLevel?(): string;
  dispose(): void;
};

export type NavigatorSessionFactory = (options: {
  context: ExtensionContext;
  sessionDir: string;
  modelSettingPath?: string;
  tool: ToolDefinition;
}) => Promise<NavigatorPreparationSession>;

export type NavigatorAttendanceOptions = {
  context: ExtensionContext;
  role: string;
  phase: NavigatorPhase;
  subjectKey: string;
  sessionDir: string;
  loadSoul: () => Promise<string>;
  loadRoleHelp: (role: NavigatorTargetRole) => Promise<string>;
  createSession: NavigatorSessionFactory;
  modelSettingPath?: string;
  subject: string;
  authority: string;
  contextError?: unknown;
  sessionDirectory?: (subjectKey: string) => string;
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
function issueRoot(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  const marker = ".ak/work/issues/";
  const index = normalized.indexOf(marker);
  if (index < 0) return undefined;
  const issue = normalized.slice(index + marker.length).split("/")[0]?.split("#")[0];
  return issue === undefined || issue === "" ? undefined : normalized.slice(0, index + marker.length) + issue;
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

function subjectDirectory(cwd: string, subjectKey: string): string {
  const issue = issueRoot(subjectKey);
  if (issue !== undefined) {
    const base = join(issue, "runs", "navigator");
    if (subjectKey === issue) return base;
    const digest = createHash("sha256").update(subjectKey).digest("hex").slice(0, 32);
    return join(base, digest);
  }
  const digest = createHash("sha256").update(subjectKey).digest("hex").slice(0, 32);
  return join(resolve(cwd, ".ak", "work", "navigator"), digest);
}

export function navigatorModelSettingPath(): string {
  return join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "navigator-model.json");
}
export async function readNavigatorModelSetting(path = navigatorModelSettingPath()): Promise<string> {
  try {
    const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!exactRecord(raw) || typeof raw.model !== "string" || raw.model.trim() === "") throw new Error("Navigator model setting is malformed");
    return raw.model;
  } catch (error) {
    // Contract: README.md#Navigator-attendance — the absent optional persistent setting uses the documented default; all other causes propagate.
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") return NAVIGATOR_DEFAULT_MODEL;
    throw error;
  }
}
export async function writeNavigatorModelSetting(model: string, path = navigatorModelSettingPath()): Promise<void> {
  const normalized = model.trim();
  parseNavigatorModelSetting(normalized);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ model: normalized }) + "\n", "utf8");
}
export function parseNavigatorModelSetting(value: string): { provider: string; model: string; thinkingLevel: "off" | "max" } {
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) throw new Error("Navigator model setting must be provider/model[:max]");
  const provider = value.slice(0, slash);
  const modelWithThinking = value.slice(slash + 1);
  const colon = modelWithThinking.lastIndexOf(":");
  const suffix = colon < 0 ? undefined : modelWithThinking.slice(colon + 1);
  if (suffix !== undefined && suffix !== "max") throw new Error("Navigator model setting must use :max or omit the thinking suffix");
  const model = colon < 0 ? modelWithThinking : modelWithThinking.slice(0, colon);
  if (model === "") throw new Error("Navigator model setting must include a model");
  return { provider, model, thinkingLevel: suffix === "max" ? "max" : "off" };
}

export function createNavigatorPrepareTool(onOutput: (value: PrepareOutput) => void): ToolDefinition {
  return {
    name: NAVIGATOR_PREPARE_TOOL_NAME,
    label: "Navigator preparation",
    description: "Submit Navigator direction advice. Provide candidates with next.role (phase when meaningful). route/matches/reason/command are optional context, not acceptance gates.",
    parameters: prepareSchema,
    async execute(_id, value) {
      // Rule 0: the unique prepare submission is accepted once. Ancillary shape is
      // normalized later; never open a format-correction retry loop here.
      onOutput(value as PrepareOutput);
      return { content: [{ type: "text" as const, text: "Navigator preparation accepted" }], details: value, terminate: true as const };
    },
  };
}

export function selectNavigatorCandidate(candidates: readonly NavigatorCandidate[], settlement: NavigatorSettlement): NavigatorCandidate | undefined {
  if (settlement.kind !== "accepted") return undefined;
  const usable = candidates.filter((candidate) => candidate.next !== undefined);
  if (usable.length === 0) return undefined;
  const matched = usable.filter((candidate) =>
    candidate.matches !== undefined
    && candidate.matches.role === settlement.role
    && candidate.matches.phase === settlement.phase,
  );
  // Status-specific candidates outrank role/phase generics regardless of declaration order.
  if (matched.length > 0) {
    if (settlement.status !== undefined) {
      const statusSpecific = matched.find((candidate) => candidate.matches?.statuses?.includes(settlement.status!) === true);
      if (statusSpecific !== undefined) return statusSpecific;
    }
    return matched.find((candidate) => candidate.matches?.statuses === undefined);
  }
  // v1 direction-only / broken matches: absent match metadata must not drop a usable next.
  return usable.find((candidate) => candidate.matches === undefined);
}

export function formatNavigatorReport(report: NavigatorReport): string {
  if (report.disposition === "no-advice") return "";
  if (report.disposition === "unavailable") return `导航不可用：${oneLine(report.unavailableReason ?? "未能完成导航准备")}`;
  if (report.disposition === "arrival") return oneLine(report.arrivalMessage ?? "已到达目的地");
  return [
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
  const reportText = formatNavigatorReport(presentation.report);
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
  let sessionDir = options.sessionDir;
  let candidates: NavigatorCandidate[] | undefined;
  // Shared lifecycle owns the principal when supplied; otherwise mint once per attendance.
  const invocationPrincipal = options.invocationId ?? mintNavigatorInvocationId();
  let activeInvocationId: string | undefined = invocationPrincipal;
  let previousRoute: NavigatorRouteTarget[] | undefined;
  let outputSink: ((value: PrepareOutput) => void) | undefined;
  let settlementTail: Promise<void> = Promise.resolve();
  let settlementFailure: unknown;
  let preparationFailure: unknown;
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
  const prepare = async (): Promise<NavigatorCandidate[]> => {
    // Exact principal is owned by shared lifecycle (or one mint per attendance).
    // Model/tool/advice paths cannot override it; role-session persistence is
    // pi.appendEntry at lifecycle start — not optional sessionManager probing.
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
      // subprocesses; serializing it behind session create made the post-role 3s
      // grace cover help-boot under load (ENOENT / unavailable flake). Session
      // create still follows context load so tool registration and prompt stay
      // one readiness step for callers.
      let soul: string;
      let modelSetting: string;
      let help: Array<{ role: NavigatorTargetRole; help: string }>;
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
      const modelPromise = (async () => {
        try {
          return await readNavigatorModelSetting(options.modelSettingPath);
        } catch (error) {
          throw navigatorUnavailableError("model", error);
        }
      })();
      // Prefer one-shot warm from session_start; clear so the next prepare reloads live.
      const helpPromise = warmedHelp ?? loadLiveHelp();
      warmedHelp = undefined;
      [soul, modelSetting, help] = await Promise.all([
        soulPromise,
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
      outputSink = (value) => {
        if (output !== undefined) throw new Error("Navigator preparation must submit exactly one typed candidate batch");
        output = value;
      };
      const tool = createNavigatorPrepareTool((value) => { outputSink?.(value); });
      if (session === undefined) {
        sessionReady = (async () => {
          let created: NavigatorPreparationSession;
          try {
            created = await options.createSession({ context: options.context, sessionDir, ...(options.modelSettingPath === undefined ? {} : { modelSettingPath: options.modelSettingPath }), tool });
          } catch (error) {
            throw navigatorUnavailableError("session", error);
          }
          if (disposed) {
            created.dispose();
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
            if (session !== created) created.dispose();
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
        priorRoute: exactRecord(prior) && Array.isArray(prior.route) && prior.route.every((target) => targetIsValid(target))
          ? prior.route.map((target) => ({ role: target.role as NavigatorTargetRole, phase: target.phase as NavigatorPhase }))
          : null,
        publicSettlementHistory,
        liveRoleHelp: help,
      };
      activeSession.appendEntry(CONTEXT_ENTRY, projection);
      const request = [
        "Act as the Navigator direction advisor. Submit one next-step advice batch; do not execute or invoke any role.",
        `<navigator_soul>\n${soul}\n</navigator_soul>`,
        `<work_subject>\n${subject}\n</work_subject>`,
        `<controlling_authority>\n${authority}\n</controlling_authority>`,
        `<current_role>\n${JSON.stringify({ role: options.role, phase: options.phase })}\n</current_role>`,
        `<prior_route>\n${JSON.stringify(prior ?? null)}\n</prior_route>`,
        `<public_settlement_history>\n${JSON.stringify(projection.publicSettlementHistory)}\n</public_settlement_history>`,
        `<live_role_help>\n${helpContext}\n</live_role_help>`,
        `Use model setting ${JSON.stringify(modelSetting)} for this call. Return exactly one ${NAVIGATOR_PREPARE_TOOL_NAME} call.`,
        "v1 requires a usable next direction: candidates[].next.role, with phase only when present and meaningful. route, matches, id, reason, and command are optional context — never retry to satisfy optional shape.",
        "Do not put task-specific paths, prompts, packets, or Skill bindings in any field. Command display is rendered by the host from next, not from model prose.",
      ].join("\n\n");
      try {
        try {
          if (disposed) throw navigatorUnavailableError("session", new Error("Navigator attendance was disposed"));
          await activeSession.prompt(request);
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
    setWorkContext(next: NavigatorWorkContext): void {
      if (next.subjectKey !== subjectKey && session !== undefined) {
        session.dispose();
        session = undefined;
        previousRoute = undefined;
      }
      subjectKey = next.subjectKey;
      subject = next.subject;
      authority = next.authority;
      contextError = next.contextError;
      sessionDir = options.sessionDirectory?.(next.subjectKey) ?? options.sessionDir;
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
    settle(settlement: NavigatorSettlement): Promise<void> {
      const next = settlementTail.then(() => settleOnce(settlement));
      // Contract: README.md#Navigator-attendance — rejected attendance settlements are drained only to serialize later attendance; retain the exact rejection for the caller/audit path.
      settlementTail = next.catch((error) => { settlementFailure = error; });
      return next;
    },
    dispose(): void {
      disposed = true;
      // Leave sessionReady so an in-flight createSession observes disposed and drains exactly once.
      // Late settleOnce completion observes disposed and skips onEvent.
      session?.dispose();
      session = undefined;
      activeInvocationId = undefined;
    },
  };

  async function settleOnce(settlement: NavigatorSettlement): Promise<void> {
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
          const prepared = await preparation;
          session?.appendEntry(SETTLEMENT_ENTRY, { invocationId, subjectKey, role: settlement.role, phase: settlement.phase, kind: settlement.kind, ...(settlement.status === undefined ? {} : { status: settlement.status }) });
          const selected = selectNavigatorCandidate(prepared, settlement);
          // Usable model/authority next only — never invent from settlement role/status, prior absence, or prose.
          if (selected?.next === undefined) {
            throw new Error("Navigator prepared no machine-usable next direction");
          }
          const selectedRoute = selected.route;
          const routeChanged = selectedRoute !== undefined && !routeEqual(previousRoute, selectedRoute);
          // Single owner: public registry renderer (ADR 0052). Model command prose is never authority.
          const command = renderPublicAkRoleCommand(selected.next);
          report = {
            disposition: "recommendation",
            ...(routeChanged ? { route: selectedRoute } : {}),
            next: selected.next,
            ...(selected.reason === undefined ? {} : { reason: oneLine(selected.reason) }),
            ...(command === undefined ? {} : { command }),
          };
          if (selectedRoute !== undefined) {
            previousRoute = selectedRoute;
            session?.appendEntry(ROUTE_ENTRY, { invocationId, subjectKey, route: selectedRoute });
          }
        // Contract: README.md#Navigator-attendance — Navigator failures become typed unavailable without invalidating the role Receipt; retain the original cause in the unavailable report.
        } catch (error) {
          report = unavailable(invocationId, error);
        }
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
        ...(report.arrivalMessage === undefined ? {} : { arrivalMessage: report.arrivalMessage }),
      };
      // Dispose during post-role grace must ignore late completion (ADR 0052 / #106).
      // Every settled disposition (recommendation | no-advice | unavailable | arrival) is affirmative.
      if (!disposed) {
        await options.onEvent(event, report);
      }
      preparation = undefined;
      sessionReady = undefined;
      candidates = undefined;
      preparationFailure = undefined;
  }
}

export type NavigatorAttendance = ReturnType<typeof createNavigatorAttendance>;

export function createNativeNavigatorSessionFactory(defaultModelSettingPath = navigatorModelSettingPath()): NavigatorSessionFactory {
  // Pre-warm once per factory (per process). Concurrent prepares share the same
  // runtime construction rather than each paying ModelRuntime.create under load.
  const sharedModelRuntime = ModelRuntime.create({ allowModelNetwork: false });
  return async ({ context, sessionDir, modelSettingPath, tool }) => {
    let configured: string;
    try {
      configured = await readNavigatorModelSetting(modelSettingPath ?? defaultModelSettingPath);
    } catch (error) {
      throw navigatorUnavailableError("model", error);
    }
    let parsed: ReturnType<typeof parseNavigatorModelSetting>;
    try {
      parsed = parseNavigatorModelSetting(configured);
    } catch (error) {
      throw navigatorUnavailableError("model", error);
    }
    const model = context.modelRegistry.find(parsed.provider, parsed.model);
    const provider = context.modelRegistry.getProvider(parsed.provider);
    if (model === undefined || provider === undefined) throw new NavigatorUnavailableError("model", `Navigator model is unavailable: ${configured}`);
    let auth: Awaited<ReturnType<typeof context.modelRegistry.getApiKeyAndHeaders>>;
    try {
      auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    } catch (error) {
      throw navigatorUnavailableError("auth", error);
    }
    if (!auth.ok) throw new NavigatorUnavailableError("auth", auth.error);
    try {
      const sessionInfo = await stat(sessionDir);
      if (!sessionInfo.isDirectory()) throw new NavigatorUnavailableError("session", `Navigator session path is not a directory: ${sessionDir}`);
    } catch (error) {
      if (error instanceof NavigatorUnavailableError) throw error;
      // Contract: README.md#Navigator-attendance — the resumable session directory may be created by session setup; retain and classify every other filesystem cause.
      if (!(error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT")) {
        throw navigatorUnavailableError("session", error);
      }
    }
    let providerFailure: NavigatorProviderFailureFact | undefined;
    const assignProviderFailure = (fact: NavigatorProviderFailureFact | undefined): void => {
      if (fact !== undefined) providerFailure = fact;
    };
    const classifyProviderStreamError = (error: unknown): void => {
      if (!exactRecord(error)) {
        assignProviderFailure(navigatorProviderFailureFromError(error));
        return;
      }
      // Contract-shaped AssistantMessage facts only: diagnostics carry typed transport/auth/quota codes.
      // Non-contract message metadata (statusCode/code/navigatorFailure) is never an acceptance oracle.
      assignProviderFailure(navigatorProviderFailureFromDiagnostics(error.diagnostics));
      if (providerFailure !== undefined) return;
      // Thrown Error-shaped provider failures may still carry SDK status/code fields.
      if (error.role !== "assistant") assignProviderFailure(navigatorProviderFailureFromError(error));
    };
    const classifyProviderResponseStatus = (status: number): void => {
      if (status >= 200 && status < 300) {
        // A later successful attempt clears auth/quota facts recorded from earlier retry responses.
        if (providerFailure?.source === "auth" || providerFailure?.source === "quota") {
          providerFailure = undefined;
        }
        return;
      }
      assignProviderFailure(navigatorProviderFailureFromStatus(status));
    };
    const humanProviderError = <T extends Record<string, unknown>>(error: T): T => {
      const human = { ...error };
      delete human.statusCode;
      delete human.code;
      delete human.navigatorFailure;
      return human;
    };
    let providerFailureEvidenceNumber = 0;
    let providerFailureEvidence: { id: string; error: unknown } | undefined;
    const retainProviderFailure = (error: unknown): string => {
      const id = `navigator-provider-failure-${++providerFailureEvidenceNumber}`;
      providerFailureEvidence = { id, error };
      return id;
    };
    const setupFailureMessage = (error: unknown) => ({
      role: "assistant" as const,
      content: [] as [],
      api: "unknown" as const,
      provider: "unknown",
      model: "unknown",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "error" as const,
      errorMessage: error instanceof Error ? error.message : String(error),
      navigatorFailureEvidenceId: retainProviderFailure(error),
      timestamp: Date.now(),
    });
    const instrumentProvider = <TProvider extends NonNullable<typeof provider>>(sourceProvider: TProvider): TProvider => {
      type StreamFn = TProvider["stream"];
      type StreamSimpleFn = TProvider["streamSimple"];
      type StreamOptionsArg = Parameters<StreamFn>[2];
      type StreamSimpleOptionsArg = Parameters<StreamSimpleFn>[2];
      const instrumentStreamOptions = <TOptions>(options: TOptions): TOptions => {
        const record = (exactRecord(options) ? options : {}) as Record<string, unknown>;
        const previous = typeof record.onResponse === "function"
          ? record.onResponse as (response: { status: number; headers: Record<string, string> }, model: unknown) => void | Promise<void>
          : undefined;
        return {
          ...record,
          onResponse: async (response: { status: number; headers: Record<string, string> }, model: unknown) => {
            classifyProviderResponseStatus(response.status);
            await previous?.(response, model);
          },
        } as TOptions;
      };
      const wrapProviderStream = (source: ReturnType<StreamFn>): ReturnType<StreamFn> => {
        const wrapped = createAssistantMessageEventStream();
        void (async () => {
          let result: Awaited<ReturnType<typeof source.result>> | undefined;
          let sawTerminal = false;
          try {
            for await (const event of source) {
              if (event.type === "done" || event.type === "error") {
                sawTerminal = true;
                if (event.type === "done" && exactRecord(event.message)) {
                  assignProviderFailure(navigatorProviderFailureFromDiagnostics(event.message.diagnostics));
                  result = humanProviderError(event.message) as typeof event.message;
                  wrapped.push({ ...event, message: result });
                  continue;
                }
                if (event.type === "error" && exactRecord(event.error)) {
                  classifyProviderStreamError(event.error);
                  result = humanProviderError(event.error) as typeof event.error;
                  wrapped.push({ ...event, error: result });
                  continue;
                }
              }
              wrapped.push(event);
            }
            // Only await result after a terminal done/error event. end(undefined) leaves result() unresolved forever.
            if (sawTerminal) {
              const terminal = await source.result();
              if (result === undefined && exactRecord(terminal)) result = humanProviderError(terminal) as typeof terminal;
              else if (result === undefined) result = terminal;
            }
          } catch (error) {
            // Contract: README.md#Navigator-attendance — synthetic provider errors retain a stable pointer to the raw rejection while exposing only human-safe text.
            classifyProviderStreamError(error);
            if (providerFailure === undefined) providerFailure = { source: "transport", cause: "transport" };
            if (!sawTerminal) {
              const message = setupFailureMessage(error);
              wrapped.push({ type: "error", reason: "error", error: message });
              result = message;
              sawTerminal = true;
            }
          } finally {
            // No terminal stream event means the provider produced no response.
            // Emit a synthetic error so callers do not hang waiting for done/error, and never await an unresolved source.result().
            if (!sawTerminal) {
              if (providerFailure === undefined) providerFailure = { source: "transport", cause: "transport" };
              const message = setupFailureMessage(new Error("Navigator provider produced no response"));
              wrapped.push({ type: "error", reason: "error", error: message });
              result = message;
              sawTerminal = true;
            }
            wrapped.end(result);
          }
        })();
        return wrapped as ReturnType<StreamFn>;
      };
      const invokeInstrumentedStream = (invoke: () => ReturnType<StreamFn>): ReturnType<StreamFn> => {
        // Reset before invoking the selected provider so setup throws cannot leave a prior call's fact.
        providerFailure = undefined;
        try {
          return wrapProviderStream(invoke());
        } catch (error) {
          // Contract: README.md#Navigator-attendance — setup failures become terminal synthetic errors, with the raw rejection retained by stable evidence pointer.
          classifyProviderStreamError(error);
          if (providerFailure === undefined) providerFailure = { source: "transport", cause: "transport" };
          const wrapped = createAssistantMessageEventStream();
          const message = setupFailureMessage(error);
          queueMicrotask(() => {
            wrapped.push({ type: "error", reason: "error", error: message });
            wrapped.end(message);
          });
          return wrapped as ReturnType<StreamFn>;
        }
      };
      return {
        ...sourceProvider,
        stream(model: Parameters<StreamFn>[0], streamContext: Parameters<StreamFn>[1], options: StreamOptionsArg) {
          const instrumented = instrumentStreamOptions(options);
          return invokeInstrumentedStream(() => sourceProvider.stream(model, streamContext, instrumented) as ReturnType<StreamFn>) as ReturnType<StreamFn>;
        },
        streamSimple(model: Parameters<StreamSimpleFn>[0], streamContext: Parameters<StreamSimpleFn>[1], options: StreamSimpleOptionsArg) {
          const instrumented = instrumentStreamOptions(options);
          return invokeInstrumentedStream(() => sourceProvider.streamSimple(model, streamContext, instrumented) as ReturnType<StreamFn>) as ReturnType<StreamSimpleFn>;
        },
      } as TProvider;
    };
    let modelRuntime: Awaited<ReturnType<typeof ModelRuntime.create>>;
    try {
      modelRuntime = await sharedModelRuntime;
      modelRuntime.registerNativeProvider(instrumentProvider(provider));
    } catch (error) {
      throw navigatorUnavailableError("session", error);
    }
    let created: Awaited<ReturnType<typeof createAgentSession>>;
    try {
      created = await createAgentSession({
      cwd: context.cwd,
      model,
      modelRuntime,
      thinkingLevel: parsed.thinkingLevel,
      sessionManager: SessionManager.continueRecent(context.cwd, sessionDir),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      noTools: "all",
      tools: [NAVIGATOR_PREPARE_TOOL_NAME],
      customTools: [tool],
    });
    } catch (error) {
      throw navigatorUnavailableError("session", error);
    }
    if (created.session.thinkingLevel !== parsed.thinkingLevel) {
      created.session.dispose();
      throw new NavigatorUnavailableError("thinking", `Navigator thinking level ${parsed.thinkingLevel} is unavailable for ${configured}`);
    }
    return {
      prompt: async (text) => {
        try {
          await created.session.prompt(text);
        } catch (error) {
          throw navigatorUnavailableError("transport", error);
        }
      },
      providerFailure: () => providerFailure,
      appendEntry: (customType, data) => { created.session.sessionManager.appendCustomEntry(customType, data); },
      entries: () => created.session.sessionManager.getEntries(),
      setModel: async (next, thinkingLevel) => {
        let nextParsed: ReturnType<typeof parseNavigatorModelSetting>;
        try {
          nextParsed = parseNavigatorModelSetting(next);
        } catch (error) {
          throw navigatorUnavailableError("model", error);
        }
        const nextModel = context.modelRegistry.find(nextParsed.provider, nextParsed.model);
        const nextProvider = context.modelRegistry.getProvider(nextParsed.provider);
        if (nextModel === undefined || nextProvider === undefined) throw new NavigatorUnavailableError("model", `Navigator model is unavailable: ${next}`);
        let nextAuth: Awaited<ReturnType<typeof context.modelRegistry.getApiKeyAndHeaders>>;
        try {
          nextAuth = await context.modelRegistry.getApiKeyAndHeaders(nextModel);
        } catch (error) {
          throw navigatorUnavailableError("auth", error);
        }
        if (!nextAuth.ok) throw new NavigatorUnavailableError("auth", nextAuth.error);
        try {
          // setModel replaces the registered provider id; keep the stream seam instrumented.
          modelRuntime.registerNativeProvider(instrumentProvider(nextProvider));
          await created.session.setModel(nextModel);
          created.session.setThinkingLevel(thinkingLevel);
        } catch (error) {
          throw navigatorUnavailableError("session", error);
        }
        if (created.session.thinkingLevel !== nextParsed.thinkingLevel || created.session.thinkingLevel !== thinkingLevel) {
          throw new NavigatorUnavailableError("thinking", `Navigator thinking level ${thinkingLevel} is unavailable for ${next}`);
        }
      },
      getThinkingLevel: () => created.session.thinkingLevel,
      dispose: () => created.session.dispose(),
    };
  };
}

export function registerNavigatorModelCommand(pi: ExtensionAPI, path = navigatorModelSettingPath()): void {
  pi.registerCommand("navigator-model", {
    description: "Set the persistent Navigator model (provider/model[:max]).",
    handler: async (args) => {
      await writeNavigatorModelSetting(args.trim(), path);
    },
  });
}

export function navigatorSessionDirectory(context: ExtensionContext, subjectKey?: string): string {
  const current = context.sessionManager.getSessionDir();
  const key = subjectKey ?? subjectPath(current, context.cwd);
  return subjectDirectory(context.cwd, key);
}

export { subjectPath };
