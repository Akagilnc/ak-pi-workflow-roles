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
 */

import { PACKAGED_ROLE_REGISTRY } from "./packaged-role-registry.ts";
import { isUuidV7, uuidv7 } from "./uuidv7.ts";

export const NAVIGATOR_INVOCATION_ENTRY = "ak-navigator-invocation" as const;

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

function isPackagedRoleTerminalEntry(entry: NavigatorInvocationEntryLike | undefined): boolean {
  if (entry?.type !== "message") return false;
  const message = entry.message;
  if (message?.role !== "toolResult") return false;
  if (typeof message.toolName !== "string") return false;
  return PACKAGED_ROLE_OUTPUT_TOOLS.has(message.toolName as string);
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
