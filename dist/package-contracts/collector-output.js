/** Package-owned Collector receipt leaf — no role registration surface. */
export const COLLECTOR_OUTPUT_TOOL = "ak_collector_output";
export const COLLECTOR_ACCEPTED_TEXT = "Collector receipt accepted";
export const COLLECTOR_HOST = "github.com";
function safeGet(value, key) {
    if ((typeof value !== "object" && typeof value !== "function") || value === null)
        return undefined;
    try {
        return value[key];
    }
    catch {
        return undefined;
    }
}
function records(value) {
    if (!Array.isArray(value))
        return [];
    return value.filter((item) => item !== null && typeof item === "object");
}
function strings(value) {
    return Array.isArray(value)
        ? value.filter((item) => typeof item === "string")
        : [];
}
function projectReport(value) {
    const common = {
        legId: safeGet(value, "legId"),
        report: safeGet(value, "report"),
        windowRelation: safeGet(value, "windowRelation"),
        evidenceRefs: strings(safeGet(value, "evidenceRefs")),
    };
    if (safeGet(value, "kind") === "review") {
        return {
            kind: "review",
            ...common,
            reviewedHead: safeGet(value, "reviewedHead"),
            headRelation: safeGet(value, "headRelation"),
        };
    }
    const terminal = {
        kind: "terminal-fact",
        ...common,
        terminalStatus: safeGet(value, "terminalStatus"),
    };
    const targetSnapshotHead = safeGet(value, "targetSnapshotHead");
    const scope = safeGet(value, "scope");
    if (targetSnapshotHead !== undefined)
        terminal.targetSnapshotHead = targetSnapshotHead;
    if (scope !== undefined)
        terminal.scope = scope;
    return terminal;
}
/**
 * Safely project the receipt fields consumed by settlement. Runtime ledger
 * construction owns their semantic bindings; this boundary does not impose a
 * second required/type/closed/status shape contract.
 */
export function validateAcceptedCollectorReceipt(value) {
    const snapshots = records(safeGet(value, "snapshots")).map((snapshot) => ({
        snapshotId: safeGet(snapshot, "snapshotId"),
        observedAt: safeGet(snapshot, "observedAt"),
        completedAt: safeGet(snapshot, "completedAt"),
        completedMono: safeGet(snapshot, "completedMono"),
        host: safeGet(snapshot, "host"),
        repository: safeGet(snapshot, "repository"),
        prNumber: safeGet(snapshot, "prNumber"),
        prState: safeGet(snapshot, "prState"),
        headOid: safeGet(snapshot, "headOid"),
        complete: safeGet(snapshot, "complete"),
        evidenceIds: strings(safeGet(snapshot, "evidenceIds")),
        pageDiagnostics: records(safeGet(snapshot, "pageDiagnostics")),
        normalizedByteLength: safeGet(snapshot, "normalizedByteLength"),
    }));
    const evidenceRecords = records(safeGet(value, "evidenceRecords")).map((record) => ({
        evidenceId: safeGet(record, "evidenceId"),
        kind: safeGet(record, "kind"),
        versionId: safeGet(record, "versionId"),
        contentDigest: safeGet(record, "contentDigest"),
        firstObservedAt: safeGet(record, "firstObservedAt"),
        raw: safeGet(record, "raw"),
    }));
    return {
        host: safeGet(value, "host"),
        repository: safeGet(value, "repository"),
        prNumber: safeGet(value, "prNumber"),
        manifestDigest: safeGet(value, "manifestDigest"),
        activationTime: safeGet(value, "activationTime"),
        deadlineTime: safeGet(value, "deadlineTime"),
        finalObservationTime: safeGet(value, "finalObservationTime"),
        finalSnapshotId: safeGet(value, "finalSnapshotId"),
        targetHead: safeGet(value, "targetHead"),
        reports: records(safeGet(value, "reports")).map(projectReport),
        legs: records(safeGet(value, "legs")).map((leg) => ({
            legId: safeGet(leg, "legId"),
            status: safeGet(leg, "status"),
            rationale: safeGet(leg, "rationale"),
            evidenceRefs: strings(safeGet(leg, "evidenceRefs")),
        })),
        requestAttempts: records(safeGet(value, "requestAttempts")),
        snapshots,
        evidenceRecords,
    };
}
