import { Type } from "typebox";
import { runAuditorRole } from "./auditor-role.js";
const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({ question: nonblank, options: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false });
export const complianceDecisionSchema = Type.Object({ status: Type.Union([Type.Literal("pass"), Type.Literal("revise"), Type.Literal("escalate")], { description: "Auditor decision status." }), violations: Type.Array(nonblank, { description: "Observed compliance violations." }), conflicts: Type.Array(nonblank, { description: "Unresolved authority or execution conflicts." }), decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "Escalation question and available options." }) }, { additionalProperties: true, required: [] });
export function createComplianceDecisionTool(name, description) {
    return { name, description, parameters: complianceDecisionSchema, async execute(_id, params) { return { content: [{ type: "text", text: "Compliance decision received" }], details: params, terminate: true }; } };
}
export async function prepareComplianceDispatch(model, context, label) {
    const resolution = await context.modelRegistry.getProviderAuth(model.provider).catch((error) => { throw new Error(`${label} authentication failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); });
    if (resolution === undefined)
        throw new Error(`${label} authentication failed: provider is not configured: ${model.provider}`);
    const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok)
        throw new Error(`${label} authentication failed: ${auth.error}`);
    return { model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model, auth: { ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }), ...(auth.headers === undefined ? {} : { headers: auth.headers }), ...(auth.env === undefined ? {} : { env: auth.env }) } };
}
export const COMPLIANCE_RESPONSE_ENTRY_TYPE = "ak_compliance_response";
export class ComplianceResponseRetentionError extends Error {
    constructor(message, options) { super(message, options); this.name = "ComplianceResponseRetentionError"; }
}
function retainComplianceResponse(context, response) {
    const manager = context.sessionManager;
    if (typeof manager?.appendCustomEntry !== "function")
        throw new ComplianceResponseRetentionError("compliance response retention is unavailable");
    try {
        manager.appendCustomEntry(COMPLIANCE_RESPONSE_ENTRY_TYPE, { version: 1, response });
    }
    catch (error) {
        throw new ComplianceResponseRetentionError("compliance response retention failed", { cause: error });
    }
}
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
export async function runComplianceAudit(options) {
    const receipt = await runAuditorRole({ tool: options.tool, systemPrompt: options.systemPrompt, serializedInput: options.serializedInput, roleLabel: options.roleLabel, context: options.context, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    retainComplianceResponse(options.context, receipt.response);
    return readComplianceCandidate(receipt.decision, receipt.response.usage);
}
