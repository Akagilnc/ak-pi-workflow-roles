/**
 * Public Countersign (给事中) terminating receipt contracts.
 * Lawful verdicts: converged (署) | continue (封驳) | escalate (上呈).
 * (#572 / ADR 0074) — 原卷保真: the verdict is recognized read-only; no field
 * is defaulted, rewritten, or dropped (ADR 0055).
 */
export const COUNTERSIGN_OUTPUT_TOOL_NAME = "ak_countersign_output";
export const COUNTERSIGN_ACCEPTED_TEXT = "给事中回执已接受";
export function validateRecordedCountersignOutput(verdict) {
    if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict)) {
        throw new Error("Countersign verdict has no execution discriminator");
    }
    let countersignStatus;
    try {
        countersignStatus = verdict.countersignStatus;
    }
    catch {
        throw new Error("Countersign verdict has no execution discriminator");
    }
    if (typeof countersignStatus !== "string") {
        throw new Error("Countersign verdict has no execution discriminator");
    }
    if (["converged", "continue", "escalate"].includes(countersignStatus)) {
        return verdict;
    }
    throw new Error("Countersign verdict has no execution discriminator");
}
