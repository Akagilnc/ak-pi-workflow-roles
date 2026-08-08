export const AUDIT_ESCALATION_KIND = "audit_escalation";
// Live Navigator settlement may consume only the projection produced by this
// owner. Its private object prototype is process-local and cannot be authored
// by role output; persisted/replayed records are re-authenticated by the
// retained audit evidence binder instead.
const AUDIT_ESCALATION_PROJECTION_BRAND = Object.freeze(Object.create(null));
/**
 * Build the escalation delivery face.
 * Role-delivered fields ride under the escalation discriminator (ADR 0055).
 * `kind` always wins so the discriminator cannot be laundered.
 * `conflicts` always come from the audit (why we escalated).
 * `auditDecisionGate` is always the audit's own gate — one fixed home.
 * A role `decisionGate`, when present, stays at its own key via spread and is
 * never overwritten (not folded, not dropped, not swapped into the audit home).
 */
export function buildAuditEscalationResult(decision, deliveredOutput) {
    const auditOwned = {
        kind: AUDIT_ESCALATION_KIND,
        conflicts: [...decision.conflicts],
        auditDecisionGate: {
            question: decision.decisionGate.question,
            options: [...decision.decisionGate.options],
        },
    };
    if (deliveredOutput !== undefined &&
        deliveredOutput !== null &&
        typeof deliveredOutput === "object" &&
        !Array.isArray(deliveredOutput)) {
        const result = {
            ...deliveredOutput,
            ...auditOwned,
        };
        Object.setPrototypeOf(result, AUDIT_ESCALATION_PROJECTION_BRAND);
        return result;
    }
    const result = auditOwned;
    Object.setPrototypeOf(result, AUDIT_ESCALATION_PROJECTION_BRAND);
    return result;
}
/** True only for the audit-owned live projection, never for role-shaped data. */
export function isAuditEscalationProjection(value) {
    if (!isAuditEscalationResult(value))
        return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype !== Object.prototype &&
        prototype !== null &&
        Object.getPrototypeOf(prototype) === null &&
        Reflect.ownKeys(prototype).length === 0 &&
        Object.isFrozen(prototype);
}
function humanDecisionText(result) {
    // Read only the audit-owned, fixed-shape gate. Role payload is not assumed
    // to be a {question, options} object — that assumption is what threw.
    return [
        "Human decision required: compliance audit escalation.",
        "Conflicts:",
        ...result.conflicts.map((conflict) => `- ${conflict}`),
        `Question: ${result.auditDecisionGate.question}`,
        "Options:",
        ...result.auditDecisionGate.options.map((option) => `- ${option}`),
    ].join("\n");
}
export function projectAuditEscalation(decision, deliveredOutput) {
    const details = buildAuditEscalationResult(decision, deliveredOutput);
    return {
        content: [{ type: "text", text: humanDecisionText(details) }],
        details,
        terminate: true,
        ...(decision.usage === undefined ? {} : { usage: decision.usage }),
    };
}
export function projectAuditIncomplete(decision) {
    return {
        content: [{ type: "text", text: "Compliance audit incomplete; no role receipt was formed." }],
        details: decision,
        terminate: true,
        ...(decision.usage === undefined ? {} : { usage: decision.usage }),
    };
}
/**
 * Discriminator-only recognition (ADR 0040). Shape of conflicts/options/gate
 * is not a reject gate — element types and cardinality are delivery content.
 */
export function isAuditEscalationResult(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    return value.kind === AUDIT_ESCALATION_KIND;
}
/**
 * Dispose a parsed audit decision without repeating status handling in roles.
 * Role output already delivered is preserved on the escalate face (ADR 0055).
 */
export async function disposeComplianceDecision(decision, handlers, deliveredOutput) {
    switch (decision.status) {
        case "pass":
            return await handlers.pass(decision.usage);
        case "revise":
            return await handlers.revise(decision.violations);
        case "escalate":
            return await handlers.escalate(projectAuditEscalation(decision, deliveredOutput));
        case "audit-incomplete":
            if (handlers.auditIncomplete === undefined) {
                throw new Error("Compliance audit-incomplete handler is unavailable");
            }
            return await handlers.auditIncomplete(projectAuditIncomplete(decision));
    }
}
