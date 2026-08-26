/**
 * Exact current-invocation principal for Navigator attendance correlation.
 * Shared role lifecycle owns one opaque uuidv7 per Role invocation and persists
 * it on the role session via Pi's guaranteed `pi.appendEntry` boundary.
 *
 * session_start is process/session activation, not a new Role invocation:
 * unfinished exact-session resume reuses the latest valid marker only when its
 * role/phase/subjectKey still match the expected identity; a packaged role
 * terminal completing that marker starts the next invocation (fresh mint).
 * Terminal settlement binds the nearest independent marker strictly before the
 * current durable packaged role terminal and compares equality — never attendance
 * self-shape, markers after the terminal, or stale older markers behind a
 * malformed nearest. Non-UUIDv7 principals are never accepted.
 *
 * One shared typed terminal classifier owns durable completion for lifecycle,
 * publicNavigatorSettlement, and every public CLI Receipt extractor:
 *   - accepted/human: isError exactly false and no infrastructure-failure fact
 *   - infrastructure: isError exactly true plus exact closed infrastructure fact
 *   - retryable/missing/nonboolean/contradictory/malformed: nonterminal
 *
 * One truth table also owns marker↔terminal cardinality:
 *   - a marker binds exactly one durable packaged role terminal
 *   - multiple durable terminals after the same marker → ambiguous / fail-closed
 *   - marker role/phase/subjectKey must match the terminal + independent expected
 */

import { PACKAGED_ROLE_REGISTRY } from "./packaged-role-registry.ts";
import { isUuidV7, uuidv7 } from "./uuidv7.ts";
import { workSubjectKeysEqual } from "./work-subject-identity.ts";

export const NAVIGATOR_INVOCATION_ENTRY = "ak-navigator-invocation" as const;

/** Typed durable infrastructure-failure fact on a packaged role output toolResult. */
export const NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND = "role_infrastructure_failure" as const;

/** Required base identity keys for infrastructure-failure recognition. */
const NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS = [
  "kind",
  "source",
  "reasonCode",
] as const;

/**
 * Typed failure evidence keys that may ride durable infrastructure details (#475).
 * Unknown extras keep classification nonterminal (closed identity + whitelist only).
 */
export const NAVIGATOR_INFRASTRUCTURE_FAILURE_EVIDENCE_KEYS = [
  "observation",
  "candidate",
  "submission",
  "stage",
  "reason",
] as const;

const NAVIGATOR_INFRASTRUCTURE_FAILURE_ALLOWED_KEYS = new Set<string>([
  ...NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS,
  ...NAVIGATOR_INFRASTRUCTURE_FAILURE_EVIDENCE_KEYS,
]);

export type NavigatorInfrastructureFailureFact = {
  kind: typeof NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND;
  source: "shared-role-lifecycle";
  reasonCode: "host_failure";
};

export function buildNavigatorInfrastructureFailureFact(): NavigatorInfrastructureFailureFact {
  return {
    kind: NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND,
    source: "shared-role-lifecycle",
    reasonCode: "host_failure",
  };
}

/**
 * Infrastructure-failure identity on durable details.
 * Base keys must match exactly; only typed evidence whitelist keys may extend;
 * any unknown key fails closed.
 */
export function hasNavigatorInfrastructureFailureBase(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  for (const key of NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS) {
    if (!Object.hasOwn(record, key)) return false;
  }
  if (
    record.kind !== NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND
    || record.source !== "shared-role-lifecycle"
    || record.reasonCode !== "host_failure"
  ) {
    return false;
  }
  for (const key of Object.keys(record)) {
    if (!NAVIGATOR_INFRASTRUCTURE_FAILURE_ALLOWED_KEYS.has(key)) return false;
  }
  return true;
}

/**
 * Exact closed infrastructure-failure fact (no evidence extensions).
 * Classifier uses {@link hasNavigatorInfrastructureFailureBase} so whitelist-enriched
 * durable details still complete as infrastructure (#475).
 */
export function isNavigatorInfrastructureFailureFact(
  value: unknown,
): value is NavigatorInfrastructureFailureFact {
  if (!hasNavigatorInfrastructureFailureBase(value)) return false;
  return Object.keys(value as object).length === NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS.length;
}

const PACKAGED_ROLE_OUTPUT_TOOLS: ReadonlyMap<string, string> = new Map(
  PACKAGED_ROLE_REGISTRY.map((entry) => [entry.outputTool, entry.role]),
);

export type NavigatorInvocationEntryLike = {
  readonly type?: string;
  readonly customType?: string;
  readonly data?: unknown;
  readonly message?: {
    readonly role?: unknown;
    readonly toolName?: unknown;
    readonly isError?: unknown;
    readonly details?: unknown;
  };
};

/** Mint one globally unique opaque invocation principal. */
export function mintNavigatorInvocationId(): string {
  return uuidv7();
}

/** Phase carried on the durable invocation marker / expected identity. */
export type InvocationPhase = "plan" | "apply" | null;

/** Full exact-invocation marker identity persisted on the role session. */
export type InvocationMarkerIdentity = {
  readonly invocationId: string;
  readonly role: string;
  readonly phase: InvocationPhase;
  readonly subjectKey: string;
};

/** Independently admitted / registry / cwd expected identity for resume and correlation. */
export type ExpectedInvocationIdentity = {
  readonly role: string;
  readonly phase?: InvocationPhase;
  readonly allowedPhases?: readonly InvocationPhase[];
  readonly subjectKey?: string;
};

function invocationPhaseFromUnknown(value: unknown): InvocationPhase | undefined {
  if (value === null || value === "plan" || value === "apply") return value;
  return undefined;
}

/**
 * Parse a full invocation marker payload. All identity fields are required;
 * non-UUIDv7 principals and partial shapes fail closed.
 */
export function parseInvocationMarkerIdentity(
  data: unknown,
): InvocationMarkerIdentity | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const record = data as Record<string, unknown>;
  const invocationId = record.invocationId;
  if (typeof invocationId !== "string") return undefined;
  const trimmedId = invocationId.trim();
  if (!isUuidV7(trimmedId)) return undefined;
  if (typeof record.role !== "string" || record.role.trim() === "") return undefined;
  const phase = invocationPhaseFromUnknown(record.phase);
  if (phase === undefined) return undefined;
  if (typeof record.subjectKey !== "string" || record.subjectKey.trim() === "") return undefined;
  return {
    invocationId: trimmedId,
    role: record.role,
    phase,
    subjectKey: record.subjectKey,
  };
}

/**
 * Marker identity agrees with independently expected role/phase/subject.
 * Role is mandatory. Phase and subject apply when the expected side knows them.
 */
export function markerMatchesExpectedIdentity(
  marker: InvocationMarkerIdentity,
  expected: ExpectedInvocationIdentity,
): boolean {
  if (marker.role !== expected.role) return false;
  if (expected.phase !== undefined) {
    if (marker.phase !== expected.phase) return false;
  } else if (expected.allowedPhases !== undefined) {
    if (!expected.allowedPhases.includes(marker.phase)) return false;
  }
  if (expected.subjectKey !== undefined) {
    if (!workSubjectKeysEqual(marker.subjectKey, expected.subjectKey)) return false;
  }
  return true;
}

/** Shared terminal discriminant owned by one classifier. */
export type PackagedRoleTerminalClassification =
  | { readonly kind: "accepted" }
  | {
      readonly kind: "infrastructure";
      readonly fact: NavigatorInfrastructureFailureFact;
    }
  | { readonly kind: "nonterminal" };

export type PackagedRoleTerminalMessage = {
  readonly toolName?: unknown;
  readonly isError?: unknown;
  readonly details?: unknown;
};

/**
 * One shared typed terminal classifier for packaged role output toolResults.
 * Consumed by lifecycle principal completion, publicNavigatorSettlement, and
 * every public CLI role Receipt extractor. No second classifier.
 */
export function classifyPackagedRoleTerminalResult(
  message: PackagedRoleTerminalMessage,
): PackagedRoleTerminalClassification {
  if (typeof message.toolName !== "string") return { kind: "nonterminal" };
  if (!PACKAGED_ROLE_OUTPUT_TOOLS.has(message.toolName)) return { kind: "nonterminal" };

  // Base identity is enough; durable details may carry typed failure evidence (#475).
  const hasInfraBase = hasNavigatorInfrastructureFailureBase(message.details);
  const infraFact = hasInfraBase ? buildNavigatorInfrastructureFailureFact() : undefined;

  // Infrastructure completion: exact isError === true + infra base identity.
  if (message.isError === true) {
    if (infraFact === undefined) return { kind: "nonterminal" };
    return { kind: "infrastructure", fact: infraFact };
  }
  // Accepted/human completion: exact isError === false and must not carry infra fact.
  if (message.isError === false) {
    if (infraFact !== undefined) return { kind: "nonterminal" };
    return { kind: "accepted" };
  }
  // Missing, non-boolean, contradictory, or malformed shapes fail closed.
  return { kind: "nonterminal" };
}

/**
 * Durable-completion boolean over the shared classifier
 * (accepted/human or infrastructure terminal).
 */
export function isDurablePackagedRoleTerminalResult(
  message: PackagedRoleTerminalMessage,
): boolean {
  const classification = classifyPackagedRoleTerminalResult(message);
  return classification.kind === "accepted" || classification.kind === "infrastructure";
}

/** Receipt extractors admit only exact accepted/human terminals. */
export function isAcceptedPackagedRoleTerminalResult(
  message: PackagedRoleTerminalMessage,
): boolean {
  return classifyPackagedRoleTerminalResult(message).kind === "accepted";
}

export type DurablePackagedRoleTerminalRef = {
  readonly index: number;
  readonly role: string;
  readonly toolName: string;
  readonly classification: "accepted" | "infrastructure";
  readonly message: PackagedRoleTerminalMessage;
};

function durableTerminalAt(
  entries: readonly NavigatorInvocationEntryLike[],
  index: number,
): DurablePackagedRoleTerminalRef | undefined {
  const entry = entries[index];
  if (entry?.type !== "message") return undefined;
  const message = entry.message;
  if (message?.role !== "toolResult") return undefined;
  if (typeof message.toolName !== "string") return undefined;
  const role = PACKAGED_ROLE_OUTPUT_TOOLS.get(message.toolName);
  if (role === undefined) return undefined;
  const classification = classifyPackagedRoleTerminalResult(message);
  if (classification.kind !== "accepted" && classification.kind !== "infrastructure") {
    return undefined;
  }
  return {
    index,
    role,
    toolName: message.toolName,
    classification: classification.kind,
    message,
  };
}

function isPackagedRoleTerminalEntry(entry: NavigatorInvocationEntryLike | undefined): boolean {
  if (entry?.type !== "message") return false;
  const message = entry.message;
  if (message?.role !== "toolResult") return false;
  return isDurablePackagedRoleTerminalResult(message);
}

function isInvocationMarkerEntry(entry: NavigatorInvocationEntryLike | undefined): boolean {
  return entry?.type === "custom" && entry.customType === NAVIGATOR_INVOCATION_ENTRY;
}

function latestInvocationMarkerIndex(
  entries: readonly NavigatorInvocationEntryLike[],
): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (isInvocationMarkerEntry(entries[i])) return i;
  }
  return -1;
}

/** Latest durable packaged role terminal in session order. */
export function findLatestDurablePackagedRoleTerminal(
  entries: readonly NavigatorInvocationEntryLike[],
): DurablePackagedRoleTerminalRef | undefined {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const terminal = durableTerminalAt(entries, i);
    if (terminal !== undefined) return terminal;
  }
  return undefined;
}

/**
 * Truth-table binding of the current durable packaged role terminal to its
 * owning invocation marker. Singleton cardinality: multiple durable terminals
 * after the same marker are ambiguous and fail closed.
 */
export type DurableTerminalMarkerBinding =
  | {
      readonly kind: "bound";
      readonly terminal: DurablePackagedRoleTerminalRef;
      readonly marker: InvocationMarkerIdentity & { readonly index: number };
    }
  | {
      readonly kind: "unbound";
      readonly terminal: DurablePackagedRoleTerminalRef;
    }
  | { readonly kind: "absent" }
  | { readonly kind: "ambiguous" };

export function bindCurrentDurableTerminalToMarker(
  entries: readonly NavigatorInvocationEntryLike[],
): DurableTerminalMarkerBinding {
  const terminal = findLatestDurablePackagedRoleTerminal(entries);
  if (terminal === undefined) return { kind: "absent" };

  let markerIndex = -1;
  for (let i = terminal.index - 1; i >= 0; i -= 1) {
    if (isInvocationMarkerEntry(entries[i])) {
      markerIndex = i;
      break;
    }
  }
  if (markerIndex < 0) {
    return { kind: "unbound", terminal };
  }

  const marker = parseInvocationMarkerIdentity(entries[markerIndex]?.data);
  if (marker === undefined) {
    // Malformed nearest marker: no stale fallback; terminal exists but is unbound.
    return { kind: "unbound", terminal };
  }

  let windowEnd = entries.length;
  for (let i = markerIndex + 1; i < entries.length; i += 1) {
    if (isInvocationMarkerEntry(entries[i])) {
      windowEnd = i;
      break;
    }
  }

  let durableCount = 0;
  for (let i = markerIndex + 1; i < windowEnd; i += 1) {
    if (durableTerminalAt(entries, i) !== undefined) durableCount += 1;
  }
  if (durableCount !== 1) return { kind: "ambiguous" };
  // Current terminal must be the singleton inside this marker window.
  if (terminal.index <= markerIndex || terminal.index >= windowEnd) {
    return { kind: "ambiguous" };
  }

  return {
    kind: "bound",
    terminal,
    marker: { ...marker, index: markerIndex },
  };
}

/**
 * Whether public Receipt settlement may proceed for the current durable terminal.
 * Only ambiguous multi-terminal bindings fail closed; attendance mismatch does not
 * pollute an otherwise legal single Receipt.
 */
export function isReceiptSettlementBindingClear(
  entries: readonly NavigatorInvocationEntryLike[],
): boolean {
  return bindCurrentDurableTerminalToMarker(entries).kind !== "ambiguous";
}

export type LifecycleInvocationPrincipal = {
  readonly invocationId: string;
  /** True when the principal is already on the admitted session (resume; do not re-append). */
  readonly resume: boolean;
};

/**
 * Resolve the exact-invocation principal at shared role lifecycle start from the
 * admitted session's typed entries only.
 *
 * - Latest marker is valid full identity, matches expected (when supplied), and no
 *   packaged role terminal follows it → resume.
 * - Contradictory marker role/phase/subjectKey vs expected → mint (do not resume).
 * - Latest marker is valid and a packaged role terminal already completed it → mint.
 * - Missing or malformed latest marker → mint; never fall back to a stale older marker.
 */
export function resolveLifecycleInvocationPrincipal(
  entries: readonly NavigatorInvocationEntryLike[],
  expected?: ExpectedInvocationIdentity,
): LifecycleInvocationPrincipal {
  const markerIndex = latestInvocationMarkerIndex(entries);
  if (markerIndex < 0) {
    return { invocationId: mintNavigatorInvocationId(), resume: false };
  }

  const marker = parseInvocationMarkerIdentity(entries[markerIndex]?.data);
  if (marker === undefined) {
    // Malformed nearest marker: honest new principal, no stale fallback.
    return { invocationId: mintNavigatorInvocationId(), resume: false };
  }

  if (expected !== undefined && !markerMatchesExpectedIdentity(marker, expected)) {
    // Contradictory marker must not resume a different role/phase/subject invocation.
    return { invocationId: mintNavigatorInvocationId(), resume: false };
  }

  for (let i = markerIndex + 1; i < entries.length; i += 1) {
    if (isPackagedRoleTerminalEntry(entries[i])) {
      return { invocationId: mintNavigatorInvocationId(), resume: false };
    }
  }

  return { invocationId: marker.invocationId, resume: true };
}

/**
 * Exact current invocation principal already present on the role session.
 * `beforeIndex` is the current packaged role terminal index: only the nearest
 * marker strictly before that bound is applicable. A malformed nearest marker
 * fails closed (undefined) — never falls back to a stale older valid marker.
 * Markers at/after the terminal (future prepare/event) are never considered.
 * Non-UUIDv7 values are rejected.
 */
export function currentInvocationPrincipalFromSession(
  entries: readonly NavigatorInvocationEntryLike[],
  beforeIndex: number = entries.length,
): string | undefined {
  return currentInvocationMarkerFromSession(entries, beforeIndex)?.invocationId;
}

/**
 * Full marker identity nearest before `beforeIndex` (current durable terminal).
 * Malformed nearest fails closed — no stale older fallback.
 */
export function currentInvocationMarkerFromSession(
  entries: readonly NavigatorInvocationEntryLike[],
  beforeIndex: number = entries.length,
): InvocationMarkerIdentity | undefined {
  const limit = Math.min(Math.max(beforeIndex, 0), entries.length);
  for (let i = limit - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (!isInvocationMarkerEntry(entry)) continue;
    // Nearest marker only — parse full identity or fail closed.
    return parseInvocationMarkerIdentity(entry?.data);
  }
  return undefined;
}
