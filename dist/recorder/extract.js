import { acceptedTextFor, carriesPackageAuditObservation, COLLECTOR_OUTPUT_TOOL, deepEqual, isTerminatingToolName, validateAcceptedDetails } from "../package-contracts/terminating-tools.js";
import { RecorderError } from "./errors.js";
import { combineReports, scanJsonValue } from "./scanner.js";
const empty = { hits: [], redacted: false };
const record = (v) => typeof v === "object" && v !== null && !Array.isArray(v);
const exact = (v, required, optional = []) => required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k));
function collectorProjection(args, details) {
    if (!record(args) || !exact(args, ["legs"]) || !Array.isArray(args.legs) || !record(details) || !Array.isArray(details.legs))
        return false;
    const projected = details.legs.map(leg => { if (!record(leg))
        return leg; const { unavailableScope: _drop, ...rest } = leg; return rest; });
    return deepEqual(args.legs, projected);
}
function usageOf(value) {
    if (!record(value))
        return undefined;
    const out = {};
    for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"]) {
        const n = value[key];
        if (typeof n === "number" && Number.isFinite(n) && n >= 0)
            out[key] = n;
    }
    return Object.keys(out).length ? out : undefined;
}
function kind(name) { return name === "ak_collector_output" ? "collector" : name === "ak_judge_output" ? "judge" : name === "ak_reviewer_output" ? "reviewer" : "worker"; }
/** Bind the closed direct Pi-v3 package lifecycle from already validated session rows. */
export function extractAcceptedReceipt(rows) {
    const packageOccurrences = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!record(row) || row.type !== "message" || !record(row.message))
            continue;
        const m = row.message;
        if (m.role === "assistant" && Array.isArray(m.content))
            for (const p of m.content)
                if (record(p) && p.type === "toolCall" && typeof p.name === "string" && isTerminatingToolName(p.name) && typeof p.id === "string" && p.id)
                    packageOccurrences.push({ i, role: "issue", id: p.id, name: p.name, args: p.arguments });
        if (m.role === "toolResult" && typeof m.toolName === "string" && isTerminatingToolName(m.toolName) && typeof m.toolCallId === "string" && m.toolCallId)
            packageOccurrences.push({ i, role: "result", id: m.toolCallId, name: m.toolName, result: m });
    }
    if (!packageOccurrences.length)
        throw new RecorderError("acceptance-missing");
    const used = new Set();
    let accepted = null;
    let acceptedIssue = null;
    for (let p = 0; p < packageOccurrences.length;) {
        const issue = packageOccurrences[p], result = packageOccurrences[p + 1];
        if (!issue || !result || issue.role !== "issue" || result.role !== "result" || result.i !== issue.i + 1 || issue.id !== result.id || issue.name !== result.name || used.has(issue.id))
            throw new RecorderError("acceptance-invalid");
        used.add(issue.id);
        const m = result.result;
        if (m.isError === true) {
            p += 2;
            continue;
        }
        if (m.isError !== false || accepted)
            throw new RecorderError("acceptance-invalid");
        accepted = result;
        acceptedIssue = issue;
        p += 2;
    }
    if (!accepted || !acceptedIssue)
        throw new RecorderError("acceptance-missing");
    if (accepted.i !== rows.length - 1 || acceptedIssue.i !== rows.length - 2)
        throw new RecorderError("acceptance-invalid");
    const m = accepted.result;
    if (!exact(m, ["role", "toolCallId", "toolName", "content", "isError", "details"], ["timestamp", "usage"]) || !Array.isArray(m.content) || m.content.length !== 1 || !record(m.content[0]) || !exact(m.content[0], ["type", "text"]) || m.content[0].type !== "text" || m.content[0].text !== acceptedTextFor(accepted.name))
        throw new RecorderError("acceptance-invalid");
    const issueRow = rows[acceptedIssue.i], im = issueRow.message;
    if (im.stopReason !== "toolUse" || !Array.isArray(im.content) || im.content.length !== 1)
        throw new RecorderError("acceptance-invalid");
    if (accepted.name === COLLECTOR_OUTPUT_TOOL ? !collectorProjection(acceptedIssue.args, m.details) : !deepEqual(acceptedIssue.args, m.details))
        throw new RecorderError("acceptance-invalid");
    let details;
    try {
        details = validateAcceptedDetails(accepted.name, m.details);
    }
    catch {
        throw new RecorderError("acceptance-invalid");
    }
    const raw = { toolName: accepted.name, toolCallId: accepted.id, details };
    const scanned = scanJsonValue(raw, "receipt");
    try {
        validateAcceptedDetails(accepted.name, scanned.value.details);
    }
    catch {
        throw new RecorderError("scan-failed");
    }
    const receipt = { ...scanned.value, kind: kind(accepted.name) };
    let auditObservation = null;
    let report = scanned.report;
    if (carriesPackageAuditObservation(accepted.name)) {
        const usage = usageOf(m.usage);
        auditObservation = { toolName: accepted.name, toolCallId: accepted.id, auditPassed: true, ...(usage ? { usage } : {}) };
        if (usage)
            report = combineReports(report, scanJsonValue(usage, "audit.usage").report);
    }
    return { receipt, auditObservation, artifactKind: JSON.stringify(raw) === JSON.stringify(scanned.value) ? "acceptedReceipt" : "sanitizedDerivativeOfAcceptedReceipt", report: report ?? empty };
}
