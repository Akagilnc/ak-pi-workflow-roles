/** Package-owned Judge output leaf — no role registration surface. */
export const JUDGE_OUTPUT_TOOL_NAME = "ak_judge_output";
export const JUDGE_ACCEPTED_TEXT = "大理寺回执已接受";
export const JUDGE_ACCEPTED_AUDIT_NO_RECEIPT_TEXT = "大理寺回执已接受；审计无回执";
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
    if (["converged", "continue", "escalate"].includes(judgeStatus)) {
        return verdict;
    }
    throw new Error("Judge verdict has no execution discriminator");
}
