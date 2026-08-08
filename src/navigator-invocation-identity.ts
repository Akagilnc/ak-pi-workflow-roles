/**
 * Exact current-invocation principal for Navigator attendance correlation.
 * Shared role lifecycle owns one opaque uuidv7 per Role invocation and persists
 * it on the role session via Pi's guaranteed `pi.appendEntry` boundary.
 *
 * session_start is process/session activation, not a new Role invocation:
 * unfinished exact-session resume reuses the latest valid marker; a packaged
 * role terminal completing that marker starts the next invocation (fresh mint).
 * Terminal settlement reads the nearest independent marker strictly before the
 * current packaged role terminal and compares equality — never attendance
 * self-shape, markers after the terminal, or stale older markers behind a
 * malformed nearest. Non-UUIDv7 principals are never accepted.
 *
 * One shared typed terminal classifier owns durable completion for lifecycle,
 * publicNavigatorSettlement, and every public CLI Receipt extractor:
 *   - accepted/human: isError exactly false and no infrastructure-failure fact
 *   - infrastructure: isError exactly true plus exact closed infrastructure fact
 *   - retryable/missing/nonboolean/contradictory/malformed: nonterminal
 */

import { PACKAGED_ROLE_REGISTRY } from "./packaged-role-registry.ts";
import { isUuidV7, uuidv7 } from "./uuidv7.ts";

export const NAVIGATOR_INVOCATION_ENTRY = "ak-navigator-invocation" as const;

/** Typed durable infrastructure-failure fact on a packaged role output toolResult. */
export const NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND = "role_infrastructure_failure" as const;

/** Closed fact keys — extras/missing/wrong keys fail closed. */
const NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS = [
  "kind",
  "source",
  "reasonCode",
] as const;

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
 * Exact closed infrastructure-failure fact.
 * Rejects extras, missing keys, wrong values/types, and non-objects.
 */
export function isNavigatorInfrastructureFailureFact(
  value: unknown,
): value is NavigatorInfrastructureFailureFact {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS.length) return false;
  for (const key of NAVIGATOR_INFRASTRUCTURE_FAILURE_KEYS) {
    if (!Object.hasOwn(record, key)) return false;
  }
  return (
    record.kind === NAVIGATOR_INFRASTRUCTURE_FAILURE_KIND &&
    record.source === "shared-role-lifecycle" &&
    record.reasonCode === "host_failure"
  );
}

const PACKAGED_ROLE_OUTPUT_TOOLS: ReadonlySet<string> = new Set(
  PACKAGED_ROLE_REGISTRY.map((entry) => entry.outputTool),
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

function invocationIdFromData(data: unknown): string | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  const invocationId = (data as { invocationId?: unknown }).invocationId;
  if (typeof invocationId !== "string") return undefined;
  const trimmed = invocationId.trim();
  // Opaque principal must be uuidv7 — reject caller-overwrite / legacy spellings.
  return isUuidV7(trimmed) ? trimmed : undefined;
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

  const infraFact = isNavigatorInfrastructureFailureFact(message.details)
    ? message.details
    : undefined;

  // Infrastructure completion: exact isError === true + exact closed infra fact.
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

function isPackagedRoleTerminalEntry(entry: NavigatorInvocationEntryLike | undefined): boolean {
  if (entry?.type !== "message") return false;
  const message = entry.message;
  if (message?.role !== "toolResult") return false;
  return isDurablePackagedRoleTerminalResult(message);
}

function latestInvocationMarkerIndex(
  entries: readonly NavigatorInvocationEntryLike[],
): number {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom") continue;
    if (entry.customType !== NAVIGATOR_INVOCATION_ENTRY) continue;
    return i;
  }
  return -1;
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
 * - Latest marker is valid uuidv7 and no packaged role terminal follows it → resume.
 * - Latest marker is valid and a packaged role terminal already completed it → mint.
 * - Missing or malformed latest marker → mint; never fall back to a stale older marker.
 */
export function resolveLifecycleInvocationPrincipal(
  entries: readonly NavigatorInvocationEntryLike[],
): LifecycleInvocationPrincipal {
  const markerIndex = latestInvocationMarkerIndex(entries);
  if (markerIndex < 0) {
    return { invocationId: mintNavigatorInvocationId(), resume: false };
  }

  const principal = invocationIdFromData(entries[markerIndex]?.data);
  if (principal === undefined) {
    // Malformed nearest marker: honest new principal, no stale fallback.
    return { invocationId: mintNavigatorInvocationId(), resume: false };
  }

  for (let i = markerIndex + 1; i < entries.length; i += 1) {
    if (isPackagedRoleTerminalEntry(entries[i])) {
      return { invocationId: mintNavigatorInvocationId(), resume: false };
    }
  }

  return { invocationId: principal, resume: true };
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
  const limit = Math.min(Math.max(beforeIndex, 0), entries.length);
  for (let i = limit - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type !== "custom") continue;
    if (entry.customType !== NAVIGATOR_INVOCATION_ENTRY) continue;
    // Nearest marker only — parse or fail closed; do not scan older entries.
    return invocationIdFromData(entry.data);
  }
  return undefined;
}
