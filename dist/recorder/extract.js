import { acceptedTextFor, carriesPackageAuditObservation, COLLECTOR_OUTPUT_TOOL, CODER_OUTPUT_TOOL_NAME, deepEqual, FIXER_OUTPUT_TOOL_NAME, isTerminatingToolName, JUDGE_OUTPUT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME, TERMINATING_TOOL_NAMES, validateAcceptedDetails, } from "../package-contracts/terminating-tools.js";
import { RecorderError } from "./errors.js";
import { combineReports, scanJsonValue, } from "./scanner.js";
export { TERMINATING_TOOL_NAMES };
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function contentTextFromUnknown(content) {
    if (typeof content === "string")
        return content;
    if (!Array.isArray(content))
        return "";
    const parts = [];
    for (const item of content) {
        if (!isRecord(item))
            continue;
        if (item.type === "text" && typeof item.text === "string") {
            parts.push(item.text);
        }
    }
    return parts.join("");
}
/** Parse only supported persisted-session and machine/JSON envelopes into ordered rows. */
export function decodeEnvelopeRows(text) {
    const rows = [];
    const lines = text.split(/\r?\n/);
    let sawLineJson = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0)
            continue;
        if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
            continue;
        try {
            const parsed = JSON.parse(trimmed);
            sawLineJson = true;
            if (Array.isArray(parsed)) {
                for (const item of parsed)
                    rows.push(item);
            }
            else {
                rows.push(parsed);
            }
        }
        catch {
            // prose / unsupported line
        }
    }
    if (!sawLineJson) {
        const trimmed = text.trim();
        if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
            try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed))
                    return parsed;
                // Nested common containers for whole-document session objects only.
                if (isRecord(parsed)) {
                    if (Array.isArray(parsed.messages))
                        return parsed.messages;
                    if (Array.isArray(parsed.entries))
                        return parsed.entries;
                    return [parsed];
                }
            }
            catch {
                return [];
            }
        }
    }
    return rows;
}
/**
 * Collect lifecycle-relevant events from supported envelope rows only.
 * Bare toolResult objects and recursive descent forgeries are ignored.
 */
export function collectLifecycleEvents(rows) {
    const events = [];
    for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if (!isRecord(row))
            continue;
        // machine: tool_execution_start
        if (row.type === "tool_execution_start" &&
            typeof row.toolCallId === "string" &&
            row.toolCallId.length > 0 &&
            typeof row.toolName === "string" &&
            isTerminatingToolName(row.toolName)) {
            events.push({
                kind: "start",
                index,
                toolCallId: row.toolCallId,
                toolName: row.toolName,
                args: row.args,
            });
            continue;
        }
        // machine: tool_execution_end
        if (row.type === "tool_execution_end" &&
            typeof row.toolCallId === "string" &&
            row.toolCallId.length > 0 &&
            typeof row.toolName === "string" &&
            isTerminatingToolName(row.toolName) &&
            typeof row.isError === "boolean") {
            const result = isRecord(row.result) ? row.result : null;
            events.push({
                kind: "terminal",
                index,
                toolCallId: row.toolCallId,
                toolName: row.toolName,
                isError: row.isError,
                contentText: contentTextFromUnknown(result?.content),
                details: result?.details,
                usage: result?.usage ?? row.usage,
            });
            continue;
        }
        // session JSONL: { type: "message", message }
        // machine/JSON: { type: "message_end", message }
        if ((row.type === "message" || row.type === "message_end") &&
            isRecord(row.message)) {
            const message = row.message;
            if (message.role === "assistant" && Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (!isRecord(part) ||
                        part.type !== "toolCall" ||
                        typeof part.name !== "string" ||
                        !isTerminatingToolName(part.name) ||
                        typeof part.id !== "string" ||
                        part.id.length === 0) {
                        continue;
                    }
                    events.push({
                        kind: "issued",
                        index,
                        toolCallId: part.id,
                        toolName: part.name,
                        args: part.arguments,
                    });
                }
                continue;
            }
            if (message.role === "toolResult" &&
                typeof message.toolCallId === "string" &&
                message.toolCallId.length > 0 &&
                typeof message.toolName === "string" &&
                isTerminatingToolName(message.toolName) &&
                typeof message.isError === "boolean") {
                events.push({
                    kind: "terminal",
                    index,
                    toolCallId: message.toolCallId,
                    toolName: message.toolName,
                    isError: message.isError,
                    contentText: contentTextFromUnknown(message.content),
                    details: message.details,
                    usage: message.usage,
                });
            }
        }
    }
    return events;
}
/** @deprecated Use decodeEnvelopeRows + collectLifecycleEvents. Kept for tests naming. */
export function decodeToolResultsFromEnvelope(text) {
    const events = collectLifecycleEvents(decodeEnvelopeRows(text));
    return events
        .filter((event) => event.kind === "terminal")
        .map((event) => ({
        role: "toolResult",
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        isError: event.isError,
        details: event.details,
        usage: event.usage,
    }));
}
/**
 * Bind exactly one unambiguous production-accepted lifecycle across ordered events.
 * Absence is lawful (null). Ambiguity / forgery / conflict fails closed via throw
 * only when a candidate looks like a package acceptance but is malformed after binding.
 * Pure forgeries simply yield null.
 */
export function bindAcceptedLifecycle(events) {
    const byId = new Map();
    const bucket = (id) => {
        const existing = byId.get(id);
        if (existing)
            return existing;
        const created = { issued: [], starts: [], terminals: [] };
        byId.set(id, created);
        return created;
    };
    for (const event of events) {
        const b = bucket(event.toolCallId);
        if (event.kind === "issued")
            b.issued.push(event);
        else if (event.kind === "start")
            b.starts.push(event);
        else
            b.terminals.push(event);
    }
    const accepted = [];
    for (const [toolCallId, life] of byId) {
        const { issued, starts, terminals } = life;
        // Require exact one issuance, one start, ≥1 terminal.
        if (issued.length !== 1 || starts.length !== 1 || terminals.length === 0) {
            continue;
        }
        const soleIssued = issued[0];
        const soleStart = starts[0];
        if (soleIssued.toolName !== soleStart.toolName)
            continue;
        if (!(soleIssued.index < soleStart.index))
            continue;
        if (!terminals.every((t) => t.index > soleStart.index))
            continue;
        if (!terminals.every((t) => t.toolName === soleIssued.toolName))
            continue;
        if (!deepEqual(soleIssued.args, soleStart.args))
            continue;
        // Successful terminals only; any error terminal for this id rejects the lifecycle.
        if (terminals.some((t) => t.isError))
            continue;
        const successTerminals = terminals.filter((t) => t.isError === false);
        if (successTerminals.length === 0)
            continue;
        const expectedText = acceptedTextFor(soleIssued.toolName);
        if (!successTerminals.every((t) => t.contentText.includes(expectedText))) {
            continue;
        }
        // All success terminals must agree on details.
        const first = successTerminals[0];
        if (successTerminals.some((t) => !deepEqual(t.details, first.details) || t.contentText !== first.contentText)) {
            continue;
        }
        // Non-collector: terminal details must equal issued args.
        // Collector: issued args are generated legs-only; terminal details are full receipt.
        if (soleIssued.toolName !== COLLECTOR_OUTPUT_TOOL) {
            if (!deepEqual(first.details, soleIssued.args))
                continue;
        }
        let details;
        try {
            details = validateAcceptedDetails(soleIssued.toolName, first.details);
        }
        catch {
            // Malformed bound details → not a lawful acceptance (absence for forgeries;
            // throw only if we need to fail redaction unlawfulness later).
            continue;
        }
        // Prefer usage from the first terminal that carries it.
        const usage = successTerminals.find((t) => t.usage !== undefined)?.usage;
        accepted.push({
            toolName: soleIssued.toolName,
            toolCallId,
            details,
            usage,
        });
    }
    if (accepted.length === 0)
        return null;
    if (accepted.length > 1) {
        // Ambiguous multiple distinct package acceptances — fail closed.
        throw new RecorderError("extraction-failed", "multiple unambiguous package acceptances are conflicting");
    }
    return accepted[0];
}
function toAcceptedReceipt(toolName, toolCallId, details) {
    switch (toolName) {
        case CODER_OUTPUT_TOOL_NAME:
        case FIXER_OUTPUT_TOOL_NAME:
            return {
                toolName,
                toolCallId,
                details: details,
                kind: "worker",
            };
        case REVIEWER_OUTPUT_TOOL_NAME:
            return {
                toolName,
                toolCallId,
                details: details,
                kind: "reviewer",
            };
        case JUDGE_OUTPUT_TOOL_NAME:
            return {
                toolName,
                toolCallId,
                details: details,
                kind: "judge",
            };
        case COLLECTOR_OUTPUT_TOOL:
            return {
                toolName,
                toolCallId,
                details: details,
                kind: "collector",
            };
    }
}
function usageObservation(usage) {
    if (!isRecord(usage))
        return undefined;
    const out = {};
    if (typeof usage.input === "number")
        out.input = usage.input;
    if (typeof usage.output === "number")
        out.output = usage.output;
    if (typeof usage.cacheRead === "number")
        out.cacheRead = usage.cacheRead;
    if (typeof usage.cacheWrite === "number")
        out.cacheWrite = usage.cacheWrite;
    if (typeof usage.totalTokens === "number")
        out.totalTokens = usage.totalTokens;
    return Object.keys(out).length === 0 ? undefined : out;
}
export function extractAcceptedReceipt(envelopes) {
    const emptyReport = { hits: [], redacted: false };
    const rows = [];
    for (const text of envelopes) {
        rows.push(...decodeEnvelopeRows(text));
    }
    const events = collectLifecycleEvents(rows);
    let bound;
    try {
        bound = bindAcceptedLifecycle(events);
    }
    catch (error) {
        if (error instanceof RecorderError)
            throw error;
        throw new RecorderError("extraction-failed", "receipt extraction failed", { cause: error });
    }
    if (bound === null) {
        return {
            receipt: null,
            auditObservation: null,
            artifactKind: null,
            report: emptyReport,
        };
    }
    const originalJson = JSON.stringify(bound.details);
    const scanned = scanJsonValue(bound.details, "receipt.details");
    const scannedJson = JSON.stringify(scanned.value);
    // Revalidate derivative; redaction that damages discriminant/type fails closed.
    try {
        validateAcceptedDetails(bound.toolName, scanned.value);
    }
    catch {
        throw new RecorderError("scan-failed", "redaction made accepted receipt production-unlawful");
    }
    // Key collision: if scan produced colliding keys under an object, scanner throws.
    const receipt = toAcceptedReceipt(bound.toolName, bound.toolCallId, scanned.value);
    const artifactKind = originalJson === scannedJson
        ? "acceptedReceipt"
        : "sanitizedDerivativeOfAcceptedReceipt";
    let auditObservation = null;
    // Audit only from genuinely bound accepted Judge/Reviewer lifecycle.
    // Never infer auditPassed from tool identity alone or child exit success.
    if (carriesPackageAuditObservation(bound.toolName)) {
        const usage = usageObservation(bound.usage);
        let usageScan = emptyReport;
        let scannedUsage;
        if (usage !== undefined) {
            const usageResult = scanJsonValue(usage, "audit.usage");
            usageScan = usageResult.report;
            scannedUsage = usageResult.value;
        }
        auditObservation = {
            toolName: bound.toolName,
            toolCallId: bound.toolCallId,
            auditPassed: true,
            ...(scannedUsage === undefined ? {} : { usage: scannedUsage }),
        };
        return {
            receipt,
            auditObservation,
            artifactKind,
            report: combineReports(scanned.report, usageScan),
        };
    }
    return {
        receipt,
        auditObservation,
        artifactKind,
        report: scanned.report,
    };
}
