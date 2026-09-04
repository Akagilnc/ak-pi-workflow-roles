/**
 * Lowest-layer error identity and process liveness helpers.
 * Shared by Sitian identity claims and role-run writer leases (#629 / #648).
 * True error identity — name/code/message as-is, never a guessed label.
 */

export function errorCodeOf(error: unknown): unknown {
  return (error as { code?: unknown }).code;
}

/** True error identity for diagnostics — name/code/message as-is. */
export function describeErrorIdentity(error: unknown): string {
  const candidate = error as { name?: unknown; code?: unknown; message?: unknown };
  const name =
    typeof candidate?.name === "string" && candidate.name !== ""
      ? candidate.name
      : typeof error;
  const code =
    typeof candidate?.code === "string" || typeof candidate?.code === "number"
      ? ` code=${String(candidate.code)}`
      : "";
  const message =
    typeof candidate?.message === "string" && candidate.message !== ""
      ? `: ${candidate.message}`
      : "";
  return `${name}${code}${message}`;
}

/**
 * Signal-0 liveness probe. Only ESRCH proves absence; any other refusal
 * (e.g. EPERM) means the holder process exists.
 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCodeOf(error) !== "ESRCH";
  }
}
