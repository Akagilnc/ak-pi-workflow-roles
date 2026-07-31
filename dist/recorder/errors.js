export const RECORDER_FAILURE_CODES = [
    "invalid-argv", "invalid-config", "invalid-archive", "invalid-path",
    "destination-exists", "spawn-failed", "scan-failed", "admission-failed",
    "reference-failed", "extraction-failed", "cleanup-failed", "promotion-failed",
    "opaque-content", "internal-error",
];
export const RECORDER_STAGES = [
    "argv", "config-read", "config-structure", "config-metadata-scan", "config-state",
    "destination", "stage-allocation", "admission", "spawn", "extraction",
    "generated-artifacts", "manifest", "cleanup", "promotion", "launcher",
];
export const RECORDER_DIAGNOSTIC_CATEGORIES = [
    "filesystem-missing", "filesystem-inaccessible", "filesystem-not-file",
    "filesystem", "process", "platform-error", "error", "non-error-throw",
];
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
    "extraction-failed": "receipt extraction failed",
    "cleanup-failed": "required raw scratch cleanup failed",
    "promotion-failed": "atomic promotion failed",
    "opaque-content": "unsupported opaque content cannot be promoted",
    "internal-error": "internal Recorder failure",
};
/** Finite supported darwin/linux signal names for the failure wire. */
export const RECORDER_SUPPORTED_SIGNALS = [
    "SIGABRT", "SIGALRM", "SIGBUS", "SIGCHLD", "SIGCONT", "SIGFPE", "SIGHUP",
    "SIGILL", "SIGINT", "SIGIO", "SIGIOT", "SIGKILL", "SIGPIPE", "SIGPOLL",
    "SIGPROF", "SIGPWR", "SIGQUIT", "SIGSEGV", "SIGSTKFLT", "SIGSTOP", "SIGSYS",
    "SIGTERM", "SIGTRAP", "SIGTSTP", "SIGTTIN", "SIGTTOU", "SIGUNUSED", "SIGURG",
    "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGWINCH", "SIGXCPU", "SIGXFSZ",
];
/** Finite v1 location path segment vocabulary (string keys only). */
export const RECORDER_LOCATION_SEGMENTS = [
    "version", "archive", "repositoryRoot", "root", "docketId",
    "execution", "cwd", "environment", "inherit", "overrides", "unset", "stdin",
    "declarations", "gitReferences", "externalInputs", "exhibits",
    "id", "commit", "path", "blobOid", "sha256", "kind", "sourcePath",
    "provenance", "package", "model", "target",
];
const PUBLIC_MESSAGES = RECORDER_PUBLIC_MESSAGES;
function platformCode(value) {
    if (typeof value !== "object" || value === null || !("code" in value))
        return null;
    return typeof value.code === "string" ? value.code : null;
}
const FILESYSTEM_CODES = new Set(["EEXIST", "ENOTDIR", "ENOTEMPTY", "EROFS", "EXDEV", "ELOOP", "ENOSPC", "EMFILE", "ENFILE"]);
const PROCESS_CODES = new Set(["ECHILD", "ENOEXEC", "ESRCH"]);
export function safeDiagnostic(stage, cause) {
    const code = platformCode(cause);
    const category = code === "ENOENT" ? "filesystem-missing"
        : code === "EACCES" || code === "EPERM" ? "filesystem-inaccessible"
            : code === "EISDIR" ? "filesystem-not-file"
                : code !== null && FILESYSTEM_CODES.has(code) ? "filesystem"
                    : code !== null && PROCESS_CODES.has(code) ? "process"
                        : code !== null ? "platform-error"
                            : cause instanceof Error ? "error" : "non-error-throw";
    return { stage, category };
}
export class RecorderError extends Error {
    code;
    childDiagnostic;
    location;
    diagnostic;
    constructor(code, message, options) {
        super(message ?? PUBLIC_MESSAGES[code], options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = "RecorderError";
        this.code = code;
        this.childDiagnostic = options?.childDiagnostic ?? null;
        if (code === "invalid-config" && options?.location === undefined)
            throw new Error("invalid-config requires an explicit schema location");
        this.location = options?.location ?? null;
        this.diagnostic = options?.diagnostic ?? null;
    }
    get publicMessage() { return PUBLIC_MESSAGES[this.code]; }
}
export const RECORDER_FAILURE_EXIT = 125;
export function internalRecorderError(stage, cause) {
    return new RecorderError("internal-error", undefined, { cause, diagnostic: safeDiagnostic(stage, cause) });
}
export function toPublicFailure(error, child) {
    const diagnostic = error.diagnostic ??
        (error.code === "internal-error" && error.cause !== undefined
            ? safeDiagnostic("launcher", error.cause)
            : error.diagnostic);
    // internal-error always carries a diagnostic on the public wire.
    const publicDiagnostic = error.code === "internal-error"
        ? (diagnostic ?? { stage: "launcher", category: "error" })
        : diagnostic;
    return {
        recorder: {
            status: "failed",
            code: error.code,
            message: error.publicMessage,
            location: error.location,
            diagnostic: publicDiagnostic,
        },
        child,
    };
}
export function serializePublicFailure(error, child) {
    return `${JSON.stringify(toPublicFailure(error, child))}\n`;
}
