import { Type } from "typebox";
import { executeAuditorChild, } from "./evidence-child-executor.js";
import { createAuditorDossierTool } from "./auditor-dossier-tool.js";
/** Unreadable compliance candidate — infrastructure failure, not a judgment status (#475). */
export class ComplianceCandidateUnreadableError extends Error {
    observation;
    candidate;
    usage;
    constructor(observation, candidate, usage) {
        const detail = observation.kind === "non-object-arguments"
            ? `${observation.kind}:${observation.type}`
            : observation.kind === "object-status-unreadable"
                ? `${observation.kind}:${observation.status}`
                : observation.kind === "missing-subject"
                    ? `${observation.kind}:${observation.subject}`
                    : observation.kind;
        super(`Compliance candidate unreadable: ${detail}`);
        this.name = "ComplianceCandidateUnreadableError";
        this.observation = observation;
        this.candidate = candidate;
        if (usage !== undefined)
            this.usage = usage;
    }
}
/** Zero-projection kickoff — soul already carries dossier-fetch duty; no hand-delivered materials. */
export const AUDITOR_DOSSIER_PROMPT = "本 run 卷宗已就绪。";
const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({ question: nonblank, options: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false });
// Transport retains malformed candidates on ComplianceCandidateUnreadableError so
// the existing failure channel can publish observation + candidate (#475).
// Status values are guidance, not a schema gate.
export const complianceDecisionSchema = Type.Object({ status: Type.Unknown({ description: "pass | revise | escalate — 形状指引，非 schema 闸" }), violations: Type.Array(nonblank, { description: "观察到的合规违规" }), conflicts: Type.Array(nonblank, { description: "未决权威或执行冲突" }), decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "升级问题与可选选项" }) }, { additionalProperties: true, required: [] });
export function createComplianceDecisionTool(name, description) {
    return { name, description, parameters: complianceDecisionSchema, async execute(_id, params) { return { content: [{ type: "text", text: "审计决议已收" }], details: params, terminate: true }; } };
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
    if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
        throw new ComplianceCandidateUnreadableError({ kind: "non-object-arguments", type: arguments_ === null ? "null" : Array.isArray(arguments_) ? "array" : typeof arguments_ }, arguments_, usage);
    }
    const args = arguments_;
    const status = args.status;
    if (status === "pass")
        return { status, ...(usage === undefined ? {} : { usage }) };
    if (status === "revise")
        return { status, violations: readListField(args.violations), ...(usage === undefined ? {} : { usage }) };
    if (status === "escalate")
        return { status, ...(Object.hasOwn(args, "conflicts") ? { conflicts: args.conflicts } : {}), ...(Object.hasOwn(args, "decisionGate") ? { decisionGate: args.decisionGate } : {}), ...(usage === undefined ? {} : { usage }) };
    throw new ComplianceCandidateUnreadableError({ kind: "object-status-unreadable", status: status === undefined ? "missing" : "unknown" }, arguments_, usage);
}
export async function runComplianceAudit(options) {
    const prompt = options.serializedInput ?? AUDITOR_DOSSIER_PROMPT;
    const receipt = await executeAuditorChild({
        tool: options.tool,
        dossierTool: createAuditorDossierTool(options.runDirectory),
        systemPrompt: options.systemPrompt,
        prompt,
        roleLabel: options.roleLabel,
        context: options.context,
        retainResponse: (response) => retainComplianceResponse(options.context, response),
        ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (receipt.noReceiptLifecycle !== undefined) {
        return {
            status: "no-receipt",
            ...receipt.noReceiptLifecycle,
            ...(receipt.response.usage === undefined ? {} : { usage: receipt.response.usage }),
        };
    }
    return readComplianceCandidate(receipt.decision, receipt.response.usage);
}
