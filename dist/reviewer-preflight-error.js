export const REVIEWER_CORRECTABLE_PREFLIGHT_CODES = [
    "base-invalid",
    "range-invalid",
    "material-invalid",
];
/** Closed policy error shared by concrete Git reads and dispatch compilation. */
export class ReviewerCorrectablePreflightError extends Error {
    code;
    diagnostic;
    constructor(code, diagnostic = `${code} constraint failed`) {
        super(`${code}: ${diagnostic}`);
        this.code = code;
        this.diagnostic = diagnostic;
        this.name = "ReviewerCorrectablePreflightError";
    }
}
