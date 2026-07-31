export const REVIEWER_CORRECTABLE_PREFLIGHT_CODES = [
    "base-invalid",
    "range-invalid",
    "material-invalid",
];
/** Closed policy error shared by concrete Git reads and dispatch compilation. */
export class ReviewerCorrectablePreflightError extends Error {
    code;
    constructor(code) {
        super(code);
        this.code = code;
        this.name = "ReviewerCorrectablePreflightError";
    }
}
