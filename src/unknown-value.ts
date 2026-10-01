/**
 * Sole readers for a plain object, a Node errno, and an Error message.
 * Callers choose which codes count; ENOTDIR is not ENOENT.
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errnoCode(error: unknown): string | undefined {
  return error !== null && typeof error === "object" && "code" in error
    && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : undefined;
}

/** `Error.message`, otherwise `String(value)`. */
export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** True only for ENOENT on an Error. ENOTDIR and every other code stay distinct. */
export function isEnoent(error: unknown): boolean {
  return error instanceof Error && errnoCode(error) === "ENOENT";
}

/** ENOENT or ENOTDIR on an Error. */
export function isMissingPathError(error: unknown): boolean {
  const code = errnoCode(error);
  return error instanceof Error && (code === "ENOENT" || code === "ENOTDIR");
}
