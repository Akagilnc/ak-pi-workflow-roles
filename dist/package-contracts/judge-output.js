/** Package-owned Judge output leaf — no role registration surface. */
import { seatFallbackBaseStatus } from "../engine-labor-fallback.js";
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
    if (["converged", "continue", "escalate"].includes(seatFallbackBaseStatus(String(judgeStatus)))) {
        return verdict;
    }
    throw new Error("Judge verdict has no execution discriminator");
}
