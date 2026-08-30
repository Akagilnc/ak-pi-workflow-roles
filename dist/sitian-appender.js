/**
 * Sitian Appender kernel (ADR 0065).
 * Computes destination automatically from ledger topology without destination parameters.
 * Owns volume open, torn-tail recovery, entry-level idempotency, and commit boundary.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { resolveBookKeyFromGit } from "./activation-ledger-git.js";
import { activationBookDirectory, ensureRealDirectoryTree, errorText, physicallyContainedIn, resolveActivationLedgerHome, } from "./activation-ledger-topology.js";
import { SitianInfrastructureError, } from "./sitian-contracts.js";
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Authorized S4 submission ledger kinds that share a common run submission volume. */
export const S4_SUBMISSION_LEDGER_KINDS = new Set([
    "candidate",
    "roundContext",
    "outcome",
    "sealed",
    "post-seal-anomaly",
]);
/** Compute the volume partition key for directory placement. */
export function resolveSitianVolumeCategory(kind) {
    if (S4_SUBMISSION_LEDGER_KINDS.has(kind)) {
        return "submission-ledger";
    }
    return kind;
}
function safeBookKey(cwd) {
    try {
        return resolveBookKeyFromGit(cwd);
    }
    catch {
        return basename(resolve(cwd)) || "default";
    }
}
/** Pure topology owner shared by ambient writes and explicit-home submission reads. */
export function resolveSitianRecordPathInLedger(input, ledgerHome) {
    const cwd = input.cwd ?? process.cwd();
    const category = resolveSitianVolumeCategory(input.kind);
    let sessionDir;
    if (input.sessionParent !== undefined && input.sessionParent.length > 0 && physicallyContainedIn(ledgerHome, input.sessionParent)) {
        sessionDir = join(dirname(input.sessionParent), category);
    }
    else {
        const bookKey = safeBookKey(cwd);
        const bookDir = activationBookDirectory(ledgerHome, bookKey);
        if (input.subject !== undefined) {
            let subjectStr;
            if (typeof input.subject === "string") {
                subjectStr = input.subject;
            }
            else if (typeof input.subject.runId === "string" && input.subject.runId.length > 0) {
                subjectStr = input.subject.runId;
            }
            else {
                subjectStr = JSON.stringify(input.subject);
            }
            const digest = createHash("sha256").update(subjectStr).digest("hex").slice(0, 32);
            sessionDir = join(bookDir, category, digest);
        }
        else {
            sessionDir = join(bookDir, category);
        }
    }
    const recordFile = join(sessionDir, "records.jsonl");
    return { sessionDir, recordFile, ledgerHome };
}
/** Compute a write destination from ambient ledger topology (ADR 0065). */
export function resolveSitianRecordPath(input) {
    return resolveSitianRecordPathInLedger(input, resolveActivationLedgerHome());
}
/**
 * Appends a canonical record to its self-computed volume under the Sitian contract.
 * - Idempotency: checks volume by deterministic canonical identity; returns existing pointer on hit.
 * - Torn-tail recovery: checks file tail; un-terminated trailing bytes are sealed with a newline and re-parsed.
 *   Substate a (valid JSON): committed on recovery, returns existing pointer.
 *   Substate b (malformed): preserved as bad line, check misses, appends new row.
 * - Commit point: full JSON string ending with newline.
 */
export function appendSitianRecord(input) {
    try {
        const { sessionDir, recordFile, ledgerHome } = resolveSitianRecordPath(input);
        ensureRealDirectoryTree(ledgerHome, sessionDir);
        const identity = input.identity ?? randomUUID();
        const timestamp = input.timestamp ?? new Date().toISOString();
        const host = input.host ?? "pi";
        const record = {
            level: input.level,
            kind: input.kind,
            identity,
            ...(input.subject === undefined ? {} : { subject: input.subject }),
            ...(input.sessionParent === undefined ? {} : { sessionParent: input.sessionParent }),
            ...(input.priorEventId === undefined ? {} : { priorEventId: input.priorEventId }),
            timestamp,
            host,
            ...(input.source === undefined ? {} : { source: input.source }),
            ...(input.payload === undefined ? {} : { payload: input.payload }),
            ...(input.raw === undefined ? {} : { raw: input.raw }),
            ...(input.usage === undefined ? {} : { usage: input.usage }),
        };
        if (existsSync(recordFile)) {
            const buffer = readFileSync(recordFile);
            if (buffer.length > 0) {
                // Torn-tail check: if last byte is not newline, seal the fragment with \n
                if (buffer[buffer.length - 1] !== 0x0a) {
                    appendFileSync(recordFile, "\n", "utf8");
                }
                // Self-check volume by canonical identity
                const text = readFileSync(recordFile, "utf8");
                for (const line of text.split("\n")) {
                    const trimmed = line.trim();
                    if (!trimmed)
                        continue;
                    try {
                        const parsed = JSON.parse(trimmed);
                        if (isRecord(parsed) && parsed.identity === identity) {
                            // Existing record found (or substate a recovered record) -> return existing pointer
                            return {
                                identity,
                                recordFile,
                                kind: record.kind,
                                level: record.level,
                            };
                        }
                    }
                    catch {
                        // Malformed lines (including substate b preserved bad lines) are ignored during self-check
                    }
                }
            }
        }
        // Not found -> append new canonical row terminating with newline
        const row = `${JSON.stringify(record)}\n`;
        appendFileSync(recordFile, row, "utf8");
        return {
            identity,
            recordFile,
            kind: record.kind,
            level: record.level,
        };
    }
    catch (error) {
        if (error instanceof SitianInfrastructureError)
            throw error;
        throw new SitianInfrastructureError(`Sitian appender persistence failure: ${errorText(error)}`, { cause: error });
    }
}
