/** Package-owned Judge output leaf — no role registration surface. */
import { seatFallbackBaseStatus, seatFallbackStatusHasLawfulEvidence, } from "../engine-labor-fallback.js";
export const JUDGE_OUTPUT_TOOL_NAME = "ak_judge_output";
export const JUDGE_ACCEPTED_TEXT = "Judge verdict accepted";
export function validateAcceptedJudgeDetails(verdict) {
    if (verdict === null || typeof verdict !== "object" || Array.isArray(verdict))
        throw new Error("Judge verdict has no execution discriminator");
    let judgeStatus;
    try {
        judgeStatus = verdict.judgeStatus;
    }
    catch {
        throw new Error("Judge verdict has no execution discriminator");
    }
    if (typeof judgeStatus !== "string") {
        throw new Error("Judge verdict has no execution discriminator");
    }
    const base = seatFallbackBaseStatus(judgeStatus);
    if (["converged", "continue", "escalate"].includes(base) &&
        seatFallbackStatusHasLawfulEvidence(judgeStatus, verdict)) {
        return verdict;
    }
    throw new Error("Judge verdict has no execution discriminator");
}
