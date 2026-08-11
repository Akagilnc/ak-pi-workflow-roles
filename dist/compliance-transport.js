import { Type } from "typebox";
import { executeAuditorChild, } from "./evidence-child-executor.js";
/** Zero-projection kickoff — soul already carries dossier-fetch duty; no hand-delivered materials. */
export const AUDITOR_DOSSIER_PROMPT = "Audit the current run dossier.";
const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({ question: nonblank, options: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false });
// Transport must retain malformed candidates so they can settle as typed
// audit-incomplete outcomes; status values are guidance, not a schema gate.
export const complianceDecisionSchema = Type.Object({ status: Type.Unknown({ description: "Auditor decision status." }), violations: Type.Array(nonblank, { description: "Observed compliance violations." }), conflicts: Type.Array(nonblank, { description: "Unresolved authority or execution conflicts." }), decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "Escalation question and available options." }) }, { additionalProperties: true, required: [] });
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
    const env = auth.env ?? resolution.env;
    return { model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model, auth: { ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }), ...(auth.headers === undefined ? {} : { headers: auth.headers }), ...(env === undefined ? {} : { env }) } };
}
export const COMPLIANCE_RESPONSE_ENTRY_TYPE = "ak_compliance_response";
export const AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE = "ak_auditor_parent_attempt_binding";
export const AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE = "ak_auditor_compliance_failure";
export class ComplianceResponseRetentionError extends Error {
    constructor(message, options) { super(message, options); this.name = "ComplianceResponseRetentionError"; }
}
/** Unique owner for session custom-entry append with availability check and typed failure. */
export function appendActiveSessionCustomEntry(context, customType, data, labels = {}) {
    const manager = context.sessionManager;
    if (typeof manager?.appendCustomEntry !== "function") {
        throw new ComplianceResponseRetentionError(labels.unavailable ?? "session custom entry append is unavailable");
    }
    try {
        return manager.appendCustomEntry(customType, data);
    }
    catch (error) {
        throw new ComplianceResponseRetentionError(labels.failed ?? "session custom entry append failed", { cause: error });
    }
}
function retainComplianceResponse(context, response) {
    appendActiveSessionCustomEntry(context, COMPLIANCE_RESPONSE_ENTRY_TYPE, { version: 1, response }, {
        unavailable: "compliance response retention is unavailable",
        failed: "compliance response retention failed",
    });
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
    const prompt = options.serializedInput ?? AUDITOR_DOSSIER_PROMPT;
    // The injected completion seam is deterministic unit infrastructure; the
    // ordinary provider path below still crosses the independent Pi role.
    if (options.runCompletion !== undefined) {
        const model = options.context.model;
        if (model === undefined)
            throw new Error(`${options.roleLabel} requires an active model`);
        const dispatch = await prepareComplianceDispatch(model, options.context, options.roleLabel);
        const context = { systemPrompt: options.systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }], tools: [options.tool] };
        const response = await options.runCompletion(dispatch.model, context, { ...dispatch.auth, ...(options.signal === undefined ? {} : { signal: options.signal }) });
        retainComplianceResponse(options.context, response);
        const call = [...response.content].reverse().find((part) => part.type === "toolCall" && part.name === options.tool.name);
        if (call === undefined || call.type !== "toolCall")
            throw new Error(`${options.roleLabel} exited without a readable decision receipt`);
        return readComplianceCandidate(call.arguments, response.usage);
    }
    const receipt = await executeAuditorChild({
        tool: options.tool,
        systemPrompt: options.systemPrompt,
        prompt,
        roleLabel: options.roleLabel,
        context: options.context,
        retainResponse: (response) => retainComplianceResponse(options.context, response),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return readComplianceCandidate(receipt.decision, receipt.response.usage);
}
