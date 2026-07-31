export const RECORDER_FAILURE_CODES = [
  "invalid-argv", "invalid-config", "invalid-archive", "invalid-path",
  "destination-exists", "spawn-failed", "scan-failed", "admission-failed",
  "reference-failed", "session-collision", "session-missing", "session-ambiguous", "session-corrupt", "session-modified", "acceptance-missing", "acceptance-invalid", "extraction-failed", "promotion-failed",
  "opaque-content", "internal-error",
] as const;
export type RecorderFailureCode = typeof RECORDER_FAILURE_CODES[number];

export const RECORDER_STAGES = [
  "argv", "config-read", "config-structure", "config-metadata-scan", "config-state",
  "destination", "stage-allocation", "admission", "session", "spawn", "extraction",
  "generated-artifacts", "manifest", "promotion", "launcher",
] as const;
export type RecorderStage = typeof RECORDER_STAGES[number];

export const RECORDER_DIAGNOSTIC_CATEGORIES = [
  "filesystem-missing", "filesystem-inaccessible", "filesystem-not-file",
  "filesystem", "process", "platform-error", "error", "non-error-throw",
] as const;
export type RecorderDiagnosticCategory = typeof RECORDER_DIAGNOSTIC_CATEGORIES[number];

/** Fixed public messages — one per code; schema must enumerate the same pairs. */
export const RECORDER_PUBLIC_MESSAGES = {
  "invalid-argv": "invalid Recorder argv",
  "invalid-config": "invalid Recorder config",
  "invalid-archive": "invalid archive worktree",
  "invalid-path": "invalid path",
  "destination-exists": "archive destination already exists",
  "spawn-failed": "failed to spawn child process",
  "scan-failed": "credential scan failed",
  "admission-failed": "declaration admission failed",
  "reference-failed": "git reference verification failed",
  "session-collision": "session directory already exists",
  "session-missing": "native session is missing",
  "session-ambiguous": "native session inventory is ambiguous",
  "session-corrupt": "native session is corrupt",
  "session-modified": "native session changed while sealing",
  "acceptance-missing": "accepted package result is missing",
  "acceptance-invalid": "package acceptance lifecycle is invalid",
  "extraction-failed": "receipt extraction failed",
  "promotion-failed": "atomic promotion failed",
  "opaque-content": "unsupported opaque content cannot be promoted",
  "internal-error": "internal Recorder failure",
} as const satisfies Record<RecorderFailureCode, string>;

/** Finite supported darwin/linux signal names for the failure wire. */
export const RECORDER_SUPPORTED_SIGNALS = [
  "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP",
  "SIGILL", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL",
  "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT", "SIGSTOP", "SIGSYS",
  "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGUNUSED", "SIGURG",
  "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ",
] as const;
export type RecorderSupportedSignal = typeof RECORDER_SUPPORTED_SIGNALS[number];

/** Finite v1 location path segment vocabulary (string keys only). */
export const RECORDER_LOCATION_SEGMENTS = [
  "version", "archive", "repositoryRoot", "root", "docketId", "session", "directory",
  "execution", "cwd", "environment", "inherit", "overrides", "unset", "stdin",
  "declarations", "gitReferences", "externalInputs", "exhibits",
  "id", "commit", "path", "blobOid", "sha256", "kind", "sourcePath",
  "provenance", "package", "model", "target",
] as const;
export type RecorderLocationSegment = typeof RECORDER_LOCATION_SEGMENTS[number];

const PUBLIC_MESSAGES = RECORDER_PUBLIC_MESSAGES;

export type SchemaLocation = Array<string | number>;
export type SafeDiagnostic = { stage: RecorderStage; category: RecorderDiagnosticCategory };
export type CleanupFailure = { status: "failed"; category: RecorderDiagnosticCategory };

function platformCode(value: unknown): string | null {
  if (typeof value !== "object" || value === null || !("code" in value)) return null;
  return typeof (value as { code?: unknown }).code === "string" ? (value as { code: string }).code : null;
}
const FILESYSTEM_CODES = new Set(["EEXIST", "ENOTDIR", "ENOTEMPTY", "EROFS", "EXDEV", "ELOOP", "ENOSPC", "EMFILE", "ENFILE"]);
const PROCESS_CODES = new Set(["ECHILD", "ENOEXEC", "ESRCH"]);
export function safeDiagnostic(stage: RecorderStage, cause: unknown): SafeDiagnostic {
  const code = platformCode(cause);
  const category: RecorderDiagnosticCategory = code === "ENOENT" ? "filesystem-missing"
    : code === "EACCES" || code === "EPERM" ? "filesystem-inaccessible"
    : code === "EISDIR" ? "filesystem-not-file"
    : code !== null && FILESYSTEM_CODES.has(code) ? "filesystem"
    : code !== null && PROCESS_CODES.has(code) ? "process"
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
export type PublicFailure = { recorder: { status: "failed"; code: RecorderFailureCode; message: string; location: SchemaLocation | null; diagnostic: SafeDiagnostic | null; cleanup: CleanupFailure | null }; child: ChildOutcome };
export const RECORDER_FAILURE_EXIT = 125;
export function internalRecorderError(stage: RecorderStage, cause: unknown): RecorderError {
  return new RecorderError("internal-error", undefined, { cause, diagnostic: safeDiagnostic(stage, cause) });
}
export function toPublicFailure(error: RecorderError, child: ChildOutcome, cleanup: CleanupFailure | null = null): PublicFailure {
  const diagnostic =
    error.diagnostic ??
    (error.code === "internal-error" && error.cause !== undefined
      ? safeDiagnostic("launcher", error.cause)
      : error.diagnostic);
  // internal-error always carries a diagnostic on the public wire.
  const publicDiagnostic =
    error.code === "internal-error"
      ? (diagnostic ?? { stage: "launcher" as const, category: "error" as const })
      : diagnostic;
  return {
    recorder: {
      status: "failed",
      code: error.code,
      message: error.publicMessage,
      location: error.location,
      diagnostic: publicDiagnostic,
      cleanup,
    },
    child,
  };
}
export function serializePublicFailure(error: RecorderError, child: ChildOutcome, cleanup: CleanupFailure | null = null): string {
  return `${JSON.stringify(toPublicFailure(error, child, cleanup))}\n`;
}
