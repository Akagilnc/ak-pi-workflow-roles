/**
 * Sitian (司天台) canonical contracts, Layout schema, and pointer definitions.
 * ADR 0065 single record entry + ADR 0068 Taishi analysis.
 */
/** Lift direct-cause fs errno onto a wrap error (no chain walk). */
export function attachDirectErrnoCode(error, cause) {
    if (cause === null || typeof cause !== "object" || !("code" in cause))
        return;
    const code = cause.code;
    if (typeof code === "string")
        error.code = code;
}
/** Typed infrastructure error for real ledger persistence / IO failures. */
export class SitianInfrastructureError extends Error {
    knownCause = "session";
    constructor(message, options) {
        super(message, options);
        this.name = "SitianInfrastructureError";
        attachDirectErrnoCode(this, options?.cause);
    }
}
