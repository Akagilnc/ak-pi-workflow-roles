/** Package-owned Collector receipt leaf — no role registration surface. */
export const COLLECTOR_OUTPUT_TOOL = "ak_collector_output";
export const COLLECTOR_ACCEPTED_TEXT = "Collector receipt accepted";
export const COLLECTOR_HOST = "github.com";
function fail(message) {
    throw new Error(message);
}
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function requireNonEmptyString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        fail(`${label} is invalid`);
    }
    return value;
}
function requireStringArray(value, label) {
    if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) {
        fail(`${label} is invalid`);
    }
    return value;
}
/** Reject unknown keys; allow only required ∪ present optional fields. */
function assertClosedKeys(value, required, optional, label) {
    const allowed = new Set([...required, ...optional]);
    for (const key of Object.keys(value)) {
        if (!allowed.has(key))
            fail(`${label} has unknown key ${key}`);
    }
    for (const key of required) {
        if (!Object.hasOwn(value, key))
            fail(`${label} missing key ${key}`);
    }
}
function validatePageDiagnostics(value, label) {
    if (!isRecord(value))
        fail(`${label} is invalid`);
    assertClosedKeys(value, ["path", "page", "status", "itemCount"], ["linkHeader"], label);
    if (typeof value.page !== "number" || !Number.isInteger(value.page)) {
        fail(`${label}.page is invalid`);
    }
    if (typeof value.status !== "number" || !Number.isInteger(value.status)) {
        fail(`${label}.status is invalid`);
    }
    if (typeof value.itemCount !== "number" || !Number.isInteger(value.itemCount)) {
        fail(`${label}.itemCount is invalid`);
    }
    const out = {
        path: requireNonEmptyString(value.path, `${label}.path`),
        page: value.page,
        status: value.status,
        itemCount: value.itemCount,
    };
    if (value.linkHeader !== undefined) {
        out.linkHeader = requireNonEmptyString(value.linkHeader, `${label}.linkHeader`);
    }
    return out;
}
function validateReport(value, index) {
    if (!isRecord(value))
        fail(`Collector receipt reports[${index}] is invalid`);
    if (value.kind === "review") {
        assertClosedKeys(value, [
            "kind",
            "legId",
            "report",
            "reviewedHead",
            "headRelation",
            "windowRelation",
            "evidenceRefs",
        ], [], `reports[${index}]`);
        return {
            kind: "review",
            legId: requireNonEmptyString(value.legId, `reports[${index}].legId`),
            report: requireNonEmptyString(value.report, `reports[${index}].report`),
            reviewedHead: requireNonEmptyString(value.reviewedHead, `reports[${index}].reviewedHead`),
            headRelation: requireNonEmptyString(value.headRelation, `reports[${index}].headRelation`),
            windowRelation: requireNonEmptyString(value.windowRelation, `reports[${index}].windowRelation`),
            evidenceRefs: requireStringArray(value.evidenceRefs, `reports[${index}].evidenceRefs`),
        };
    }
    if (value.kind === "terminal-fact") {
        assertClosedKeys(value, ["kind", "legId", "terminalStatus", "report", "windowRelation", "evidenceRefs"], ["targetSnapshotHead", "scope"], `reports[${index}]`);
        if (value.terminalStatus !== "unavailable" && value.terminalStatus !== "missing") {
            fail(`reports[${index}].terminalStatus is invalid`);
        }
        const out = {
            kind: "terminal-fact",
            legId: requireNonEmptyString(value.legId, `reports[${index}].legId`),
            terminalStatus: value.terminalStatus,
            report: requireNonEmptyString(value.report, `reports[${index}].report`),
            windowRelation: requireNonEmptyString(value.windowRelation, `reports[${index}].windowRelation`),
            evidenceRefs: requireStringArray(value.evidenceRefs, `reports[${index}].evidenceRefs`),
        };
        if (value.targetSnapshotHead !== undefined) {
            out.targetSnapshotHead = requireNonEmptyString(value.targetSnapshotHead, `reports[${index}].targetSnapshotHead`);
        }
        if (value.scope !== undefined) {
            if (value.scope !== "global")
                fail(`reports[${index}].scope is invalid`);
            out.scope = "global";
        }
        return out;
    }
    fail(`reports[${index}].kind is invalid`);
}
function validateLeg(value, index) {
    if (!isRecord(value))
        fail(`Collector receipt legs[${index}] is invalid`);
    assertClosedKeys(value, ["legId", "status", "rationale", "evidenceRefs"], [], `legs[${index}]`);
    if (value.status !== "valid" && value.status !== "unavailable" &&
        value.status !== "missing") {
        fail(`legs[${index}].status is invalid`);
    }
    return {
        legId: requireNonEmptyString(value.legId, `legs[${index}].legId`),
        status: value.status,
        rationale: requireNonEmptyString(value.rationale, `legs[${index}].rationale`),
        evidenceRefs: requireStringArray(value.evidenceRefs, `legs[${index}].evidenceRefs`),
    };
}
function validateAttempt(value, index) {
    if (!isRecord(value))
        fail(`requestAttempts[${index}] is invalid`);
    assertClosedKeys(value, [
        "attemptId",
        "legId",
        "observedHead",
        "snapshotId",
        "marker",
        "body",
        "startedAt",
        "status",
    ], ["responseDiagnostics", "commentEvidenceId", "recoverySnapshotId"], `requestAttempts[${index}]`);
    const statuses = [
        "started",
        "succeeded",
        "rejected",
        "ambiguous_loss",
        "recovered",
    ];
    if (!statuses.includes(value.status)) {
        fail(`requestAttempts[${index}].status is invalid`);
    }
    const out = {
        attemptId: requireNonEmptyString(value.attemptId, `requestAttempts[${index}].attemptId`),
        legId: requireNonEmptyString(value.legId, `requestAttempts[${index}].legId`),
        observedHead: requireNonEmptyString(value.observedHead, `requestAttempts[${index}].observedHead`),
        snapshotId: requireNonEmptyString(value.snapshotId, `requestAttempts[${index}].snapshotId`),
        marker: requireNonEmptyString(value.marker, `requestAttempts[${index}].marker`),
        body: requireNonEmptyString(value.body, `requestAttempts[${index}].body`),
        startedAt: requireNonEmptyString(value.startedAt, `requestAttempts[${index}].startedAt`),
        status: value.status,
    };
    if (value.responseDiagnostics !== undefined) {
        out.responseDiagnostics = requireNonEmptyString(value.responseDiagnostics, `requestAttempts[${index}].responseDiagnostics`);
    }
    if (value.commentEvidenceId !== undefined) {
        out.commentEvidenceId = requireNonEmptyString(value.commentEvidenceId, `requestAttempts[${index}].commentEvidenceId`);
    }
    if (value.recoverySnapshotId !== undefined) {
        out.recoverySnapshotId = requireNonEmptyString(value.recoverySnapshotId, `requestAttempts[${index}].recoverySnapshotId`);
    }
    return out;
}
function validateSnapshot(value, index) {
    if (!isRecord(value))
        fail(`snapshots[${index}] is invalid`);
    assertClosedKeys(value, [
        "snapshotId",
        "observedAt",
        "completedAt",
        "completedMono",
        "host",
        "repository",
        "prNumber",
        "prState",
        "headOid",
        "complete",
        "evidenceIds",
        "pageDiagnostics",
        "normalizedByteLength",
    ], [], `snapshots[${index}]`);
    if (value.host !== COLLECTOR_HOST)
        fail(`snapshots[${index}].host is invalid`);
    if (typeof value.prNumber !== "number" || !Number.isInteger(value.prNumber)) {
        fail(`snapshots[${index}].prNumber is invalid`);
    }
    if (typeof value.completedMono !== "number" || !Number.isFinite(value.completedMono)) {
        fail(`snapshots[${index}].completedMono is invalid`);
    }
    if (typeof value.complete !== "boolean") {
        fail(`snapshots[${index}].complete is invalid`);
    }
    if (typeof value.normalizedByteLength !== "number") {
        fail(`snapshots[${index}].normalizedByteLength is invalid`);
    }
    if (!Array.isArray(value.pageDiagnostics)) {
        fail(`snapshots[${index}].pageDiagnostics is invalid`);
    }
    return {
        snapshotId: requireNonEmptyString(value.snapshotId, `snapshots[${index}].snapshotId`),
        observedAt: requireNonEmptyString(value.observedAt, `snapshots[${index}].observedAt`),
        completedAt: requireNonEmptyString(value.completedAt, `snapshots[${index}].completedAt`),
        completedMono: value.completedMono,
        host: COLLECTOR_HOST,
        repository: requireNonEmptyString(value.repository, `snapshots[${index}].repository`),
        prNumber: value.prNumber,
        prState: requireNonEmptyString(value.prState, `snapshots[${index}].prState`),
        headOid: requireNonEmptyString(value.headOid, `snapshots[${index}].headOid`),
        complete: value.complete,
        evidenceIds: requireStringArray(value.evidenceIds, `snapshots[${index}].evidenceIds`),
        pageDiagnostics: value.pageDiagnostics.map((item, pageIndex) => validatePageDiagnostics(item, `snapshots[${index}].pageDiagnostics[${pageIndex}]`)),
        normalizedByteLength: value.normalizedByteLength,
    };
}
/** Runtime full-embed optional keys retained on the self-contained public receipt. */
const COLLECTOR_EVIDENCE_OPTIONAL_KEYS = [
    "stableGitHubId",
    "authorLogin",
    "state",
    "body",
    "commitOid",
    "htmlUrl",
    "path",
    "line",
    "originalLine",
    "side",
    "position",
    "pullRequestReviewId",
    "submittedAt",
    "authoritativeTime",
    "windowRelation",
    "pagination",
];
function validateEvidence(value, index) {
    if (!isRecord(value))
        fail(`evidenceRecords[${index}] is invalid`);
    assertClosedKeys(value, ["evidenceId", "kind", "versionId", "contentDigest", "firstObservedAt", "raw"], COLLECTOR_EVIDENCE_OPTIONAL_KEYS, `evidenceRecords[${index}]`);
    // raw may be any JSON value, including null; reject only missing key (above).
    const out = {
        evidenceId: requireNonEmptyString(value.evidenceId, `evidenceRecords[${index}].evidenceId`),
        kind: requireNonEmptyString(value.kind, `evidenceRecords[${index}].kind`),
        versionId: requireNonEmptyString(value.versionId, `evidenceRecords[${index}].versionId`),
        contentDigest: requireNonEmptyString(value.contentDigest, `evidenceRecords[${index}].contentDigest`),
        firstObservedAt: requireNonEmptyString(value.firstObservedAt, `evidenceRecords[${index}].firstObservedAt`),
        raw: value.raw,
    };
    // Pass through present optional embed fields without re-deriving them.
    for (const key of COLLECTOR_EVIDENCE_OPTIONAL_KEYS) {
        if (Object.hasOwn(value, key)) {
            out[key] = value[key];
        }
    }
    return out;
}
/**
 * Recursive production validator for accepted Collector terminal receipt details.
 * Closed: unknown keys and malformed descendants fail at every nested shape.
 * Rejects generated legs-only tool args and shallow lookalikes.
 */
export function validateAcceptedCollectorReceipt(value) {
    if (!isRecord(value))
        fail("Collector receipt must be an object");
    // Discriminate generated output (legs-only) from accepted terminal receipt.
    if (Object.hasOwn(value, "legs") &&
        !Object.hasOwn(value, "host") &&
        !Object.hasOwn(value, "reports")) {
        fail("Collector generated legs-only output is not an accepted receipt");
    }
    assertClosedKeys(value, [
        "host",
        "repository",
        "prNumber",
        "manifestDigest",
        "activationTime",
        "deadlineTime",
        "finalObservationTime",
        "finalSnapshotId",
        "targetHead",
        "reports",
        "legs",
        "requestAttempts",
        "snapshots",
        "evidenceRecords",
    ], [], "Collector receipt");
    if (value.host !== COLLECTOR_HOST)
        fail("Collector receipt host is invalid");
    if (typeof value.repository !== "string" || value.repository.trim() === "") {
        fail("Collector receipt repository is invalid");
    }
    if (typeof value.prNumber !== "number" || !Number.isInteger(value.prNumber)) {
        fail("Collector receipt prNumber is invalid");
    }
    if (typeof value.manifestDigest !== "string" || value.manifestDigest === "") {
        fail("Collector receipt manifestDigest is invalid");
    }
    if (typeof value.activationTime !== "string" || value.activationTime === "") {
        fail("Collector receipt activationTime is invalid");
    }
    if (typeof value.deadlineTime !== "string" || value.deadlineTime === "") {
        fail("Collector receipt deadlineTime is invalid");
    }
    if (typeof value.finalObservationTime !== "string" ||
        value.finalObservationTime === "") {
        fail("Collector receipt finalObservationTime is invalid");
    }
    if (typeof value.finalSnapshotId !== "string" || value.finalSnapshotId === "") {
        fail("Collector receipt finalSnapshotId is invalid");
    }
    if (typeof value.targetHead !== "string" || value.targetHead === "") {
        fail("Collector receipt targetHead is invalid");
    }
    if (!Array.isArray(value.reports) || value.reports.length === 0) {
        fail("Collector receipt reports are invalid");
    }
    if (!Array.isArray(value.legs) || value.legs.length === 0) {
        fail("Collector receipt legs are invalid");
    }
    if (!Array.isArray(value.requestAttempts)) {
        fail("Collector receipt requestAttempts are invalid");
    }
    if (!Array.isArray(value.snapshots) || value.snapshots.length === 0) {
        fail("Collector receipt snapshots are invalid");
    }
    if (!Array.isArray(value.evidenceRecords)) {
        fail("Collector receipt evidenceRecords are invalid");
    }
    // Reject null/non-object array pollution at every child collection.
    if (value.reports.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
        fail("Collector receipt reports contain invalid entries");
    }
    if (value.legs.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
        fail("Collector receipt legs contain invalid entries");
    }
    if (value.snapshots.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
        fail("Collector receipt snapshots contain invalid entries");
    }
    if (value.evidenceRecords.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
        fail("Collector receipt evidenceRecords contain invalid entries");
    }
    if (value.requestAttempts.some((item) => item === null || typeof item !== "object" || Array.isArray(item))) {
        fail("Collector receipt requestAttempts contain invalid entries");
    }
    return {
        host: COLLECTOR_HOST,
        repository: value.repository,
        prNumber: value.prNumber,
        manifestDigest: value.manifestDigest,
        activationTime: value.activationTime,
        deadlineTime: value.deadlineTime,
        finalObservationTime: value.finalObservationTime,
        finalSnapshotId: value.finalSnapshotId,
        targetHead: value.targetHead,
        reports: value.reports.map(validateReport),
        legs: value.legs.map(validateLeg),
        requestAttempts: value.requestAttempts.map(validateAttempt),
        snapshots: value.snapshots.map(validateSnapshot),
        evidenceRecords: value.evidenceRecords.map(validateEvidence),
    };
}
