import { Type } from "typebox";
import { executeAuditorChild } from "./evidence-child-executor.js";
import { openToolObject } from "./open-tool-schema.js";
import { loadGatekeeperSessionMaterials } from "./session-opening-materials.js";
export const GATEKEEPER_OUTPUT_TOOL = "ak_gatekeeper_output";
export const INSPECTOR_OUTPUT_TOOL = "ak_inspector_output";
export const NOTARY_OUTPUT_TOOL = "ak_notary_output";
const SUBJECT_TOOL = "ak_gatekeeper_subject";
function gateSeatLabel(stage) {
    switch (stage) {
        case "gatekeeper":
            return "门下省";
        case "inspector":
            return "给事中";
        case "notary":
            return "符宝郎";
    }
}
function nonPassMessage(result) {
    // Message text is what pi-agent-core createErrorToolResult exposes to the model.
    if (result.status === "bounce") {
        const findings = result.findings.length === 0 ? "（无 findings）" : result.findings.join("; ");
        return `门下省打回重写，findings：${findings}`;
    }
    return `门下省 ${result.status}（${result.stage}）：${result.reason}`;
}
/** Structured non-pass; `.result` is session-projected via tool_result, message feeds the model. */
export class GatekeeperDecisionError extends Error {
    result;
    constructor(result) {
        super(nonPassMessage(result));
        this.name = "GatekeeperDecisionError";
        this.result = result;
    }
}
// Unknown fields so wrong types/spellings still reach projection (ADR 0055/0057; 仓第 0 条).
// Opening goes through the sole openToolObject owner — no parallel transport helper.
const officerDecisionSchema = openToolObject(Type.Object({
    status: Type.Unknown({ description: "pass | bounce — 形状指引，非 schema 闸" }),
    findings: Type.Unknown({ description: "string[] findings，随 pass 或 bounce 留存" }),
}));
const gatekeeperDecisionSchema = openToolObject(Type.Object({
    status: Type.Unknown({ description: "dispatch — 形状指引，非 schema 闸" }),
    officer: Type.Unknown({ description: "status 为 dispatch 时为 inspector | notary" }),
}));
function result(content, details) {
    return { content: [{ type: "text", text: content }], details };
}
function subjectTool(subject) {
    return {
        name: SUBJECT_TOOL,
        description: "读取已受理卷宗；只供取阅，不评判不改动。",
        parameters: Type.Object({}, { additionalProperties: false }),
        async execute() { return result(JSON.stringify(subject), subject); },
    };
}
/** Shared officer decision tool — open transport; projection owns legality. */
export function createOfficerDecisionTool(name) {
    return {
        name,
        description: "提交一份 typed pass/bounce 决议。",
        parameters: officerDecisionSchema,
        async execute(_id, args) { return result(`已收 ${String(args?.status)}`, args); },
    };
}
/** Gatekeeper province decision tool — open transport; projection owns legality. */
export function createGatekeeperOutputTool() {
    return {
        name: GATEKEEPER_OUTPUT_TOOL,
        description: "提交门下省派官决定。",
        parameters: gatekeeperDecisionSchema,
        async execute(_id, args) { return result(`已收 ${String(args?.status)}`, args); },
    };
}
async function defaultLoadSoul(role) {
    return loadGatekeeperSessionMaterials(role);
}
function failureReason(error) {
    if (error instanceof AggregateError)
        return error.errors.map(failureReason).join("; ");
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}
function asStringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => typeof item === "string");
}
/** Serializable stand-in when the child tool call had no arguments object. */
export const MISSING_ARGUMENTS_SUBMISSION = Object.freeze({ missing: "arguments" });
/** Keep original decision bytes for the next reader; undefined becomes a serializable missing-args fact. */
function retainedSubmission(decision) {
    // undefined must not be stored: JSON drops it and the missing-args fact vanishes.
    return decision === undefined ? MISSING_ARGUMENTS_SUBMISSION : decision;
}
/**
 * No usable explicit release is infrastructure failure, not a judgment status.
 * Original submission is retained for the failure channel (#475).
 */
function noUsableReleaseFailure(stage, decision) {
    return {
        status: "transport_failure",
        stage,
        reason: stage === "gatekeeper" ? "decision 无显式 dispatch" : "decision 无显式 pass/bounce",
        submission: retainedSubmission(decision),
    };
}
function readRecord(value) {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        return undefined;
    return value;
}
function projectProvinceDecision(decision) {
    const record = readRecord(decision);
    if (record === undefined)
        return noUsableReleaseFailure("gatekeeper", decision);
    if (record.status === "dispatch" && (record.officer === "inspector" || record.officer === "notary")) {
        return { status: "dispatch", officer: record.officer };
    }
    return noUsableReleaseFailure("gatekeeper", decision);
}
function projectOfficerDecision(officer, decision) {
    const record = readRecord(decision);
    if (record === undefined)
        return noUsableReleaseFailure(officer, decision);
    if (record.status === "bounce") {
        return {
            status: "bounce",
            officer,
            disposition: "rewrite",
            findings: asStringArray(record.findings),
            submission: retainedSubmission(decision),
        };
    }
    if (record.status === "pass") {
        return {
            status: "pass",
            officer,
            findings: asStringArray(record.findings),
        };
    }
    return noUsableReleaseFailure(officer, decision);
}
export async function runGatekeeper(options) {
    const loadSoul = options.loadSoul ?? defaultLoadSoul;
    let provinceRun;
    try {
        // Seat identity only — shared executor owns model config/registry/auth (#453 / ADR 0018).
        provinceRun = await executeAuditorChild({
            context: options.context,
            roleLabel: "Gatekeeper",
            gateSeat: "gatekeeper",
            systemPrompt: await loadSoul("gatekeeper"),
            prompt: "卷宗已受理。",
            tool: createGatekeeperOutputTool(),
            dossierTool: subjectTool(options.subject),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
        });
    }
    catch (error) {
        return { status: "transport_failure", stage: "gatekeeper", reason: failureReason(error) };
    }
    if (provinceRun.noReceiptLifecycle !== undefined) {
        return { status: "no_receipt", stage: "gatekeeper", reason: `${gateSeatLabel("gatekeeper")}未产生已接受回执即散局`, facts: provinceRun.noReceiptLifecycle };
    }
    const province = projectProvinceDecision(provinceRun.decision);
    if (province.status !== "dispatch")
        return province;
    const officer = province.officer;
    try {
        const roleLabel = officer === "inspector" ? "Inspector" : "Notary";
        const officerRun = await executeAuditorChild({
            context: options.context,
            roleLabel,
            gateSeat: officer,
            systemPrompt: await loadSoul(officer),
            prompt: "卷宗已受理。",
            tool: createOfficerDecisionTool(officer === "inspector" ? INSPECTOR_OUTPUT_TOOL : NOTARY_OUTPUT_TOOL),
            dossierTool: subjectTool(options.subject),
            ...(options.signal === undefined ? {} : { signal: options.signal }),
            ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
        });
        if (officerRun.noReceiptLifecycle !== undefined) {
            return { status: "no_receipt", stage: officer, reason: `${gateSeatLabel(officer)}未产生已接受回执即散局`, facts: officerRun.noReceiptLifecycle };
        }
        return projectOfficerDecision(officer, officerRun.decision);
    }
    catch (error) {
        return { status: "transport_failure", stage: officer, reason: failureReason(error) };
    }
}
/** Project GatekeeperResult onto a submit path: transport→failInfrastructure; bounce/no_receipt→typed throw; pass silent. */
export async function requireGatekeeperPass(options) {
    const gatekeeper = await runGatekeeper({
        context: options.context,
        subject: options.subject,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (gatekeeper.status === "pass")
        return;
    if (gatekeeper.status === "transport_failure") {
        // Typed stage/reason/submission ride failInfrastructure → durable tool_result (#475).
        const error = new Error(`门下省 transport_failure（${gatekeeper.stage}）：${gatekeeper.reason}`);
        error.stage = gatekeeper.stage;
        error.reason = gatekeeper.reason;
        if (gatekeeper.submission !== undefined)
            error.submission = gatekeeper.submission;
        options.hostActions.failInfrastructure(error, options.context, options.toolCallId);
    }
    // Envelope owns the execute→tool_result bridge; this module only projects + throws.
    options.hostActions.bindGatekeeperNonPass(options.toolCallId, gatekeeper);
    throw new GatekeeperDecisionError(gatekeeper);
}
