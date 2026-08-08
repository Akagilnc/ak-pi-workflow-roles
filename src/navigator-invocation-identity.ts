/**
 * Exact current-invocation principal for Navigator attendance correlation.
 * Lifecycle mints and records the token on the role session; Terminal settlement
 * reads that independent fact and compares equality — never attendance self-shape
 * or a bare session-id prefix that admits stale/future same-session suffixes.
 */

export const NAVIGATOR_INVOCATION_ENTRY = "ak-navigator-invocation" as const;

export type NavigatorInvocationEntryLike = {
  readonly type?: string;
  readonly customType?: string;
  readonly data?: unknown;
};

/** Mint one invocation token bound to the role session principal + sequence. */
export function mintNavigatorInvocationId(
  sessionId: string,
  sequence: number,
): string {
  return `${sessionId}:${sequence}`;
}

function invocationIdFromData(data: unknown): string | undefined {
  if (data === null || typeof data !== "object") return undefined;
  const invocationId = (data as { invocationId?: unknown }).invocationId;
  if (typeof invocationId !== "string") return undefined;
  const trimmed = invocationId.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Exact current invocation principal already present on the role session.
 * Scans entries strictly before `beforeIndex` (attendance index) so a later
 * prepare cannot supply a future token for an earlier attendance event.
 * Missing independent principal → undefined (caller projects typed unavailable).
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
    const id = invocationIdFromData(entry.data);
    if (id !== undefined) return id;
  }
  return undefined;
}
