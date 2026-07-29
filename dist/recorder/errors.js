/** Fixed non-secret public messages keyed by code. Never interpolate attacker text. */
const PUBLIC_MESSAGES = {
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
};
export class RecorderError extends Error {
    code;
    childDiagnostic;
    constructor(code, 
    /** Internal detail — never interpolated into public JSON. */
    message, options) {
        super(message ?? PUBLIC_MESSAGES[code], options?.cause === undefined ? undefined : { cause: options.cause });
        this.name = "RecorderError";
        this.code = code;
        this.childDiagnostic = options?.childDiagnostic ?? null;
    }
    get publicMessage() {
        return PUBLIC_MESSAGES[this.code];
    }
}
export const RECORDER_FAILURE_EXIT = 125;
export function toPublicFailure(error, child) {
    return {
        recorder: {
            status: "failed",
            code: error.code,
            // Fixed literal only — never error.message which may carry internal detail.
            message: error.publicMessage,
        },
        child: {
            status: child.status,
            exitCode: child.exitCode,
            signal: child.signal,
            // Caller must pre-scan diagnostic; this field is already bounded.
            diagnostic: child.diagnostic,
        },
    };
}
/** Serialize one public failure JSON line from fixed literals + pre-scanned child fields. */
export function serializePublicFailure(error, child) {
    return `${JSON.stringify(toPublicFailure(error, child))}\n`;
}
