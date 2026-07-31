export const RECORDER_FAILURE_CODES = [
  "invalid-argv", "invalid-config", "invalid-archive", "invalid-path",
  "destination-exists", "spawn-failed", "scan-failed", "admission-failed",
  "reference-failed", "extraction-failed", "cleanup-failed", "promotion-failed",
  "opaque-content", "internal-error",
] as const;
export type RecorderFailureCode = typeof RECORDER_FAILURE_CODES[number];

export const RECORDER_STAGES = [
  "argv", "config-read", "config-structure", "config-metadata-scan", "config-state",
  "destination", "git-state", "stage-allocation", "admission", "spawn", "extraction",
  "generated-artifacts", "manifest", "cleanup", "promotion",
] as const;
export type RecorderStage = typeof RECORDER_STAGES[number];

export const RECORDER_DIAGNOSTIC_CATEGORIES = [
  "filesystem-missing", "filesystem-inaccessible", "filesystem-not-file",
  "filesystem", "process", "platform-error", "error", "non-error-throw",
] as const;
export type RecorderDiagnosticCategory = typeof RECORDER_DIAGNOSTIC_CATEGORIES[number];

const PUBLIC_MESSAGES: Record<RecorderFailureCode, string> = {
  "invalid-argv": "invalid Recorder argv", "invalid-config": "invalid Recorder config",
  "invalid-archive": "invalid archive worktree", "invalid-path": "invalid path",
  "destination-exists": "archive destination already exists", "spawn-failed": "failed to spawn child process",
  "scan-failed": "credential scan failed", "admission-failed": "declaration admission failed",
  "reference-failed": "git reference verification failed", "extraction-failed": "receipt extraction failed",
  "cleanup-failed": "required raw scratch cleanup failed", "promotion-failed": "atomic promotion failed",
  "opaque-content": "unsupported opaque content cannot be promoted", "internal-error": "internal Recorder failure",
};

export type SchemaLocation = Array<string | number>;
export type SafeDiagnostic = { stage: RecorderStage; category: RecorderDiagnosticCategory };

function platformCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("code" in value)) return null;
  return typeof (value as { code?: unknown }).code === "string" ? (value as { code: string }).code : null;
}
export function safeDiagnostic(stage: RecorderStage, cause: unknown): SafeDiagnostic {
  const code = platformCode(cause);
  const category: RecorderDiagnosticCategory = code === "ENOENT" ? "filesystem-missing"
    : code === "EACCES" || code === "EPERM" ? "filesystem-inaccessible"
    : code === "EISDIR" ? "filesystem-not-file"
    : code !== null && code.startsWith("E") ? "filesystem"
    : code !== null ? "platform-error"
    : cause instanceof Error ? "error" : "non-error-throw";
  return { stage, category };
}

export class RecorderError extends Error {
  readonly code: RecorderFailureCode; readonly childDiagnostic: string | null;
  readonly location: SchemaLocation | null; readonly diagnostic: SafeDiagnostic | null;
  constructor(code: RecorderFailureCode, message?: string, options?: { childDiagnostic?: string | null; cause?: unknown; location?: SchemaLocation | null; diagnostic?: SafeDiagnostic }) {
    super(message ?? PUBLIC_MESSAGES[code], options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "RecorderError"; this.code = code; this.childDiagnostic = options?.childDiagnostic ?? null;
    if (code === "invalid-config" && options?.location === undefined) throw new Error("invalid-config requires an explicit schema location");
    this.location = options?.location ?? null; this.diagnostic = options?.diagnostic ?? null;
  }
  get publicMessage(): string { return PUBLIC_MESSAGES[this.code]; }
}
export type ChildOutcome =
  | { status: "not-spawned"; exitCode: null; signal: null; diagnostic: null }
  | { status: "exited"; exitCode: number; signal: null; diagnostic: string | null }
  | { status: "signaled"; exitCode: null; signal: string; diagnostic: string | null };
export type PublicFailure = { recorder: { status: "failed"; code: RecorderFailureCode; message: string; location: SchemaLocation | null; diagnostic: SafeDiagnostic | null }; child: ChildOutcome };
export const RECORDER_FAILURE_EXIT = 125;
export function internalRecorderError(stage: RecorderStage, cause: unknown): RecorderError { return new RecorderError("internal-error", undefined, { cause, diagnostic: safeDiagnostic(stage, cause) }); }
export function toPublicFailure(error: RecorderError, child: ChildOutcome): PublicFailure { return { recorder: { status: "failed", code: error.code, message: error.publicMessage, location: error.location, diagnostic: error.diagnostic }, child }; }
export function serializePublicFailure(error: RecorderError, child: ChildOutcome): string { return `${JSON.stringify(toPublicFailure(error, child))}\n`; }
