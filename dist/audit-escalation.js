export const AUDIT_ESCALATION_KIND = "audit_escalation";
export function buildAuditEscalationResult(decision) {
    return {
        kind: AUDIT_ESCALATION_KIND,
        conflicts: [...decision.conflicts],
        decisionGate: {
            question: decision.decisionGate.question,
            options: [...decision.decisionGate.options],
        },
    };
}
function humanDecisionText(result) {
    return [
        "Human decision required: compliance audit escalation.",
        "Conflicts:",
        ...result.conflicts.map((conflict) => `- ${conflict}`),
        `Question: ${result.decisionGate.question}`,
        "Options:",
        ...result.decisionGate.options.map((option) => `- ${option}`),
    ].join("\n");
}
export function projectAuditEscalation(decision) {
    const details = buildAuditEscalationResult(decision);
    return {
        content: [{ type: "text", text: humanDecisionText(details) }],
        details,
        terminate: true,
        ...(decision.usage === undefined ? {} : { usage: decision.usage }),
    };
}
export function isAuditEscalationResult(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const result = value;
    const gate = result.decisionGate;
    if (result.kind !== AUDIT_ESCALATION_KIND ||
        !Array.isArray(result.conflicts) ||
        result.conflicts.length === 0 ||
        !result.conflicts.every((conflict) => typeof conflict === "string" && conflict.trim().length > 0) ||
        typeof gate !== "object" ||
        gate === null ||
        Array.isArray(gate)) {
        return false;
    }
    const gateRecord = gate;
    return (typeof gateRecord.question === "string" &&
        gateRecord.question.trim().length > 0 &&
        Array.isArray(gateRecord.options) &&
        gateRecord.options.length > 0 &&
        gateRecord.options.every((option) => typeof option === "string" && option.trim().length > 0));
}
/** Dispose a parsed audit decision without repeating status handling in roles. */
export async function disposeComplianceDecision(decision, handlers) {
    switch (decision.status) {
        case "pass":
            return await handlers.pass(decision.usage);
        case "revise":
            return await handlers.revise(decision.violations);
        case "escalate":
            return await handlers.escalate(projectAuditEscalation(decision));
    }
}
