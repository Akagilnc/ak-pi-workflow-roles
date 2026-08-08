/**
 * Exact current-invocation principal for Navigator attendance correlation.
 * Shared role lifecycle mints one globally unique opaque token and persists it
 * on the role session via Pi's guaranteed `pi.appendEntry` boundary. Terminal
 * settlement reads the nearest independent marker strictly before the current
 * packaged role terminal and compares equality — never attendance self-shape,
 * markers after the terminal, or stale older markers behind a malformed nearest.
 */

import { uuidv7 } from "./uuidv7.ts";

export const NAVIGATOR_INVOCATION_ENTRY = "ak-navigator-invocation" as const;

export type NavigatorInvocationEntryLike = {
  readonly type?: string;
  readonly customType?: string;
  readonly data?: unknown;
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
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Exact current invocation principal already present on the role session.
 * `beforeIndex` is the current packaged role terminal index: only the nearest
 * marker strictly before that bound is applicable. A malformed nearest marker
 * fails closed (undefined) — never falls back to a stale older valid marker.
 * Markers at/after the terminal (future prepare/event) are never considered.
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
