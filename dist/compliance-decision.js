export const COMPLIANCE_RESPONSE_ENTRY_TYPE = "ak_compliance_response";
export const DOCTOR_AUDIT_TOOL_NAME = "ak_doctor_audit_decision";
export const FIXER_AUDIT_TOOL_NAME = "ak_fixer_audit_decision";
export const JUDGE_AUDIT_TOOL_NAME = "ak_soul_audit_decision";
export const REVIEWER_AUDIT_TOOL_NAME = "ak_reviewer_audit_decision";
function readListField(value) { return Array.isArray(value) ? value : value === undefined ? [] : [value]; }
export function readComplianceCandidate(arguments_, usage) {
    if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_))
        return { status: "audit-incomplete", observation: { kind: "non-object-arguments", type: arguments_ === null ? "null" : Array.isArray(arguments_) ? "array" : typeof arguments_ }, candidate: arguments_, ...(usage === undefined ? {} : { usage }) };
    const args = arguments_;
    const status = args.status;
    if (status === "pass")
        return { status, ...(usage === undefined ? {} : { usage }) };
    if (status === "revise")
        return { status, violations: readListField(args.violations), ...(usage === undefined ? {} : { usage }) };
    if (status === "escalate")
        return { status, ...(Object.hasOwn(args, "conflicts") ? { conflicts: args.conflicts } : {}), ...(Object.hasOwn(args, "decisionGate") ? { decisionGate: args.decisionGate } : {}), ...(usage === undefined ? {} : { usage }) };
    return { status: "audit-incomplete", observation: { kind: "object-status-unreadable", status: status === undefined ? "missing" : "unknown" }, candidate: arguments_, ...(usage === undefined ? {} : { usage }) };
}
