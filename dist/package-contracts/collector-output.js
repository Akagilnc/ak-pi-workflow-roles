/** Package-owned Collector receipt leaf — no role registration surface. */
export const COLLECTOR_OUTPUT_TOOL = "ak_collector_output";
export const COLLECTOR_ACCEPTED_TEXT = "通进司回执已接受";
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
    return Array.isArray(value) ? value.filter((item) => item !== null && typeof item === "object") : [];
}
function strings(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}
/** Settlement projection. Presence of the canonical groups array is the one Collector terminal discriminator. */
export function validateAcceptedCollectorReceipt(value) {
    const rawGroups = safeGet(value, "groups");
    if (!Array.isArray(rawGroups))
        throw new Error("Collector receipt has no typed groups terminal discriminator");
    const groups = records(rawGroups).map((group) => ({
        identity: (safeGet(group, "identity") ?? null),
        ...(typeof safeGet(group, "displayLogin") === "string" ? { displayLogin: safeGet(group, "displayLogin") } : {}),
        attendance: true,
        materials: records(safeGet(group, "materials")),
        findings: records(safeGet(group, "findings")),
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
        groups,
        requestAttempts: records(safeGet(value, "requestAttempts")),
        snapshots: records(safeGet(value, "snapshots")).map((snapshot) => ({
            snapshotId: safeGet(snapshot, "snapshotId"), observedAt: safeGet(snapshot, "observedAt"), completedAt: safeGet(snapshot, "completedAt"), completedMono: safeGet(snapshot, "completedMono"), host: safeGet(snapshot, "host"), repository: safeGet(snapshot, "repository"), prNumber: safeGet(snapshot, "prNumber"), prState: safeGet(snapshot, "prState"), headOid: safeGet(snapshot, "headOid"), complete: safeGet(snapshot, "complete"), evidenceIds: strings(safeGet(snapshot, "evidenceIds")), pageDiagnostics: records(safeGet(snapshot, "pageDiagnostics")), normalizedByteLength: safeGet(snapshot, "normalizedByteLength"),
        })),
        evidenceRecords: records(safeGet(value, "evidenceRecords")).map((record) => ({ evidenceId: safeGet(record, "evidenceId"), kind: safeGet(record, "kind"), versionId: safeGet(record, "versionId"), contentDigest: safeGet(record, "contentDigest"), firstObservedAt: safeGet(record, "firstObservedAt"), raw: safeGet(record, "raw") })),
    };
}
