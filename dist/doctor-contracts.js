import { Type } from "typebox";
import { Value } from "typebox/value";
import { sha256Hex } from "./sha256.js";
import { validateStatsLineV1 } from "./stats-line.js";
export const DOCTOR_EVIDENCE_TOOL_NAME = "ak_doctor_evidence";
export const DOCTOR_OUTPUT_TOOL_NAME = "ak_doctor_output";
export const DOCTOR_TARGET_KINDS = ["law", "gate", "template", "station", "seat"];
const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const evidenceIds = Type.Array(nonblank, { minItems: 1 });
const completeEvidenceIds = Type.Array(nonblank);
const metric = Type.Union([
    Type.Object({ status: Type.Literal("measured"), value: Type.Unknown() }, { additionalProperties: false }),
    Type.Object({ status: Type.Literal("unavailable"), reason: nonblank }, { additionalProperties: false }),
]);
const guardrail = Type.Object({ answer: Type.Boolean(), evidenceIds, explanation: nonblank }, { additionalProperties: false });
const lastRealBite = Type.Union([
    Type.Object({ kind: Type.Literal("actual"), targetKey: nonblank, evidenceId: nonblank, sealedIdentity: Type.Object({ commit: nonblank, path: nonblank, sha256: nonblank }, { additionalProperties: false }) }, { additionalProperties: false }),
    Type.Object({ kind: Type.Literal("noRealBite"), targetKey: nonblank, populationId: nonblank, eligibleEvidenceIds: completeEvidenceIds }, { additionalProperties: false }),
]);
const finding = Type.Object({
    targetKey: nonblank, evidenceIds, disposition: Type.Union([Type.Literal("keep"), Type.Literal("thin"), Type.Literal("delete")]),
    guardrails: Type.Object({ reproducibleFailure: guardrail, owningSeamOrInvariant: guardrail, deletionOrSimplificationSuffices: guardrail }, { additionalProperties: false }),
    prescription: Type.Object({ kind: Type.Union([Type.Literal("retain"), Type.Literal("delete"), Type.Literal("simplify"), Type.Literal("patch"), Type.Literal("addMechanism")]), recommendation: nonblank, necessityExplanation: Type.Optional(nonblank) }, { additionalProperties: false }),
    lastRealBite,
}, { additionalProperties: false });
export const doctorOutputSchema = Type.Union([
    Type.Object({ status: Type.Literal("completed"), coverage: Type.Array(Type.Object({ targetKey: nonblank, evidenceIds }, { additionalProperties: false }), { minItems: 1 }), trends: Type.Array(Type.Object({ metric: nonblank, points: Type.Array(Type.Object({ evidenceId: nonblank, value: metric }, { additionalProperties: false }), { minItems: 2 }) }, { additionalProperties: false }), { minItems: 1 }), findings: Type.Array(finding) }, { additionalProperties: false }),
    Type.Object({ status: Type.Literal("refused"), reason: nonblank, missingEvidence: Type.Array(Type.Object({ need: nonblank, targetKeys: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false }), { minItems: 1 }) }, { additionalProperties: false }),
]);
export function validateRecordedDoctorOutput(value) {
    if (!Value.Check(doctorOutputSchema, value))
        throw new Error("Doctor output does not match its closed contract");
    return value;
}
export const doctorEvidenceReadSchema = Type.Object({ evidenceId: nonblank, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 4096 })) }, { additionalProperties: false });
function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value, keys, label) { const actual = Object.keys(value); if (actual.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key)))
    throw new Error(`${label} must have exact keys`); }
function text(value, label) { if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} must be nonblank`); }
function strings(value, label, allowEmpty = false) { if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || !value.every((item) => typeof item === "string" && item.trim() !== ""))
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a nonempty"} string array`); }
function deepFreeze(value) { if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value))
        deepFreeze(child);
    Object.freeze(value);
} return value; }
function canonical(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
export function statsLineEvidenceBytes(value) { return new TextEncoder().encode(canonical(value)); }
function isStatsLine(value) { try {
    validateStatsLineV1(value);
    return true;
}
catch {
    return false;
} }
function timestamp(value, label) { text(value, label); if (!Number.isFinite(Date.parse(value)))
    throw new Error(`${label} must be an ISO timestamp`); }
function validateGitMetadata(value) {
    if (!record(value))
        throw new Error("invalid Git metadata");
    exact(value, ["commits"], "Git metadata");
    if (!Array.isArray(value.commits))
        throw new Error("Git metadata commits must be an array");
    for (const commit of value.commits) {
        if (!record(commit))
            throw new Error("invalid Git commit metadata");
        exact(commit, ["commit", "timestamp", "paths"], "Git commit metadata");
        if (typeof commit.commit !== "string" || !/^[0-9a-f]{40}$/.test(commit.commit))
            throw new Error("Git commit identity is invalid");
        timestamp(commit.timestamp, "Git timestamp");
        strings(commit.paths, "Git paths", true);
    }
}
function validateTrackerMetadata(value) {
    if (!record(value))
        throw new Error("invalid tracker metadata");
    exact(value, ["issues", "pullRequests"], "tracker metadata");
    const validate = (items, kind) => { if (!Array.isArray(items))
        throw new Error(`tracker ${kind} must be an array`); for (const item of items) {
        if (!record(item))
            throw new Error(`invalid tracker ${kind} metadata`);
        const optional = kind === "issue" ? ["closedAt"] : ["mergedAt", "closedAt"];
        const keys = ["repository", "number", "createdAt", ...optional.filter((key) => Object.hasOwn(item, key))];
        exact(item, keys, `tracker ${kind} metadata`);
        text(item.repository, "tracker repository");
        if (!Number.isSafeInteger(item.number) || Number(item.number) < 1)
            throw new Error("tracker number is invalid");
        timestamp(item.createdAt, "tracker createdAt");
        for (const key of optional)
            if (Object.hasOwn(item, key) && item[key] !== null)
                timestamp(item[key], `tracker ${key}`);
    } };
    validate(value.issues, "issue");
    validate(value.pullRequests, "pull request");
}
export function validateDoctorEvidenceIndex(value, committedIdentities = new Map()) {
    if (!record(value))
        throw new Error("Doctor evidence index must be an object");
    exact(value, ["version", "repository", "targetCommit", "catalog", "populations", "evidence"], "Doctor evidence index");
    if (value.version !== 1)
        throw new Error("Doctor evidence index version must be 1");
    text(value.repository, "repository");
    if (typeof value.targetCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.targetCommit))
        throw new Error("targetCommit must be a full commit identity");
    if (!Array.isArray(value.catalog) || value.catalog.length === 0)
        throw new Error("catalog must be nonempty");
    const targets = new Set();
    for (const item of value.catalog) {
        if (!record(item))
            throw new Error("catalog target must be an object");
        exact(item, ["key", "kind", "active"], "catalog target");
        text(item.key, "target key");
        if (targets.has(item.key))
            throw new Error(`Duplicate target key: ${item.key}`);
        targets.add(item.key);
        if (!DOCTOR_TARGET_KINDS.includes(item.kind) || item.active !== true)
            throw new Error("catalog admits only active factory targets");
    }
    if (!Array.isArray(value.evidence))
        throw new Error("evidence must be an array");
    const entries = new Map();
    const committed = new Set(["manifest", "receipt", "verdict", "disposition"]);
    for (const raw of value.evidence) {
        if (!record(raw))
            throw new Error("evidence entry must be an object");
        exact(raw, ["id", "kind", "sha256", "byteLength", ...(committed.has(String(raw.kind)) ? ["source"] : []), "data"], "evidence entry");
        text(raw.id, "evidence id");
        if (entries.has(raw.id))
            throw new Error(`Duplicate evidence id: ${raw.id}`);
        if (![...committed, "statsLine", "gitMetadata", "trackerMetadata"].includes(String(raw.kind)))
            throw new Error(`Forbidden or unknown evidence kind: ${String(raw.kind)}`);
        if (typeof raw.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(raw.sha256) || !Number.isSafeInteger(raw.byteLength) || Number(raw.byteLength) < 0)
            throw new Error("evidence sealed identity is invalid");
        if (committed.has(String(raw.kind))) {
            if (!record(raw.source))
                throw new Error("committed evidence requires source");
            exact(raw.source, ["commit", "path"], "evidence source");
            if (raw.source.commit !== value.targetCommit)
                throw new Error("evidence source target mismatch");
            text(raw.source.path, "evidence source path");
        }
        if (raw.kind === "statsLine" && !isStatsLine(raw.data))
            throw new Error("invalid StatsLine evidence");
        if (raw.kind === "gitMetadata")
            validateGitMetadata(raw.data);
        if (raw.kind === "trackerMetadata")
            validateTrackerMetadata(raw.data);
        // Resolver-derived committed identities seal exact target bytes; direct
        // normalized validation uses the package canonical serialization.
        const resolvedIdentity = committed.has(String(raw.kind)) ? committedIdentities.get(raw.id) : undefined;
        const canonicalBytes = resolvedIdentity === undefined ? statsLineEvidenceBytes(raw.data) : undefined;
        const expected = resolvedIdentity ?? { sha256: sha256Hex(canonicalBytes), byteLength: canonicalBytes.byteLength };
        if (expected.byteLength !== raw.byteLength || expected.sha256 !== raw.sha256)
            throw new Error(`Evidence digest mismatch: ${raw.id}`);
        entries.set(raw.id, raw);
    }
    if (!Array.isArray(value.populations))
        throw new Error("populations must be an array");
    const populationIds = new Set();
    for (const raw of value.populations) {
        if (!record(raw))
            throw new Error("population must be an object");
        exact(raw, ["id", "targetKey", "eligibleEvidenceIds"], "population");
        text(raw.id, "population id");
        text(raw.targetKey, "population target");
        if (populationIds.has(raw.id))
            throw new Error(`Duplicate population id: ${raw.id}`);
        populationIds.add(raw.id);
        if (!targets.has(raw.targetKey))
            throw new Error("population target mismatch");
        strings(raw.eligibleEvidenceIds, "eligible evidence IDs", true);
        const unique = new Set(raw.eligibleEvidenceIds);
        if (unique.size !== raw.eligibleEvidenceIds.length)
            throw new Error("population evidence IDs must be unique");
        for (const id of raw.eligibleEvidenceIds) {
            const entry = entries.get(id);
            if (!entry || (entry.kind !== "receipt" && entry.kind !== "verdict"))
                throw new Error("population admits only Receipt/verdict evidence");
        }
    }
    return deepFreeze(structuredClone(value));
}
export class DoctorEvidenceStore {
    index;
    entries;
    ranges = new Map();
    constructor(index) {
        this.index = index;
        this.entries = new Map(index.evidence.map((entry) => [entry.id, entry]));
    }
    read(evidenceId, offset = 0, limit = 4096) { const entry = this.entries.get(evidenceId); if (!entry)
        throw new Error(`Evidence ID is not admitted: ${evidenceId}`); if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 4096)
        throw new Error("Invalid evidence pagination"); const serialized = canonical(entry.data); const end = Math.min(serialized.length, offset + limit); if (offset > serialized.length)
        throw new Error("Evidence offset exceeds content"); const ranges = this.ranges.get(evidenceId) ?? []; ranges.push([offset, end]); this.ranges.set(evidenceId, ranges); return { evidenceId, kind: entry.kind, source: entry.source, offset, content: serialized.slice(offset, end), nextOffset: end < serialized.length ? end : null, byteLength: entry.byteLength, sha256: entry.sha256 }; }
    hasRead(evidenceId) { return (this.ranges.get(evidenceId)?.length ?? 0) > 0; }
    hasFullyRead(evidenceId) { const entry = this.entries.get(evidenceId); if (!entry)
        return false; const length = canonical(entry.data).length; const sorted = [...(this.ranges.get(evidenceId) ?? [])].sort((a, b) => a[0] - b[0]); let end = 0; for (const range of sorted) {
        if (range[0] > end)
            return false;
        end = Math.max(end, range[1]);
    } return end >= length; }
    readRecord() { return [...this.entries.keys()].filter((id) => this.hasRead(id)).sort().map((id) => ({ evidenceId: id, fullyRead: this.hasFullyRead(id) })); }
}
function setEqual(left, right) { return left.length === right.length && new Set(left).size === left.length && left.every((item) => right.includes(item)); }
function readCitations(ids, store, label) { strings(ids, label); for (const id of ids)
    if (!store.entries.has(id) || !store.hasRead(id))
        throw new Error(`${label} must cite admitted/read evidence: ${id}`); }
export function validateDoctorOutput(value, index, store) {
    const output = validateRecordedDoctorOutput(value);
    const targets = new Set(index.catalog.map((target) => target.key));
    if (output.status === "refused") {
        for (const missing of output.missingEvidence)
            for (const key of missing.targetKeys)
                if (!targets.has(key))
                    throw new Error("missing evidence target mismatch");
        return output;
    }
    if (output.coverage.length !== targets.size)
        throw new Error("coverage must contain every catalog target exactly once");
    const covered = new Set();
    for (const item of output.coverage) {
        if (!targets.has(item.targetKey) || covered.has(item.targetKey))
            throw new Error("coverage target mismatch or duplicate");
        covered.add(item.targetKey);
        readCitations(item.evidenceIds, store, "coverage evidence");
    }
    for (const trend of output.trends) {
        if (trend.metric === "version" || trend.metric === "caseKey" || trend.metric === "source")
            throw new Error("trend metric must name a StatsLine metric");
        const cases = new Set();
        for (const point of trend.points) {
            const entry = store.entries.get(point.evidenceId);
            if (!entry || entry.kind !== "statsLine" || !store.hasRead(point.evidenceId))
                throw new Error("trend must cite read StatsLines");
            const line = entry.data;
            const expected = line[trend.metric];
            if (canonical(point.value) !== canonical(expected))
                throw new Error("trend point does not exactly join its StatsLine");
            cases.add(`${line.caseKey.repository}#${line.caseKey.issueNumber}`);
        }
        if (cases.size < 2)
            throw new Error("trend requires distinct StatsLines");
    }
    const findings = new Set();
    for (const finding of output.findings) {
        if (!targets.has(finding.targetKey) || findings.has(finding.targetKey))
            throw new Error("finding target mismatch or duplicate");
        findings.add(finding.targetKey);
        readCitations(finding.evidenceIds, store, "finding evidence");
        for (const answer of Object.values(finding.guardrails))
            readCitations(answer.evidenceIds, store, "guardrail evidence");
        const needsNecessity = finding.prescription.kind === "patch" || finding.prescription.kind === "addMechanism";
        if (needsNecessity !== (finding.prescription.necessityExplanation !== undefined))
            throw new Error("patch/addMechanism alone require a necessity explanation");
        const bite = finding.lastRealBite;
        if (bite.targetKey !== finding.targetKey)
            throw new Error("lastRealBite target mismatch");
        if (bite.kind === "actual") {
            const entry = store.entries.get(bite.evidenceId);
            if (!entry || (entry.kind !== "receipt" && entry.kind !== "verdict") || !store.hasRead(bite.evidenceId) || canonical(bite.sealedIdentity) !== canonical({ ...entry.source, sha256: entry.sha256 }))
                throw new Error("actual bite must cite admitted/read sealed Receipt or verdict");
        }
        else {
            if (finding.disposition === "keep")
                throw new Error("noRealBite permits only thin or delete");
            const population = index.populations.find((item) => item.id === bite.populationId && item.targetKey === finding.targetKey);
            if (!population)
                throw new Error("noRealBite population mismatch");
            if (!setEqual(bite.eligibleEvidenceIds, population.eligibleEvidenceIds))
                throw new Error("noRealBite must prove the complete eligible population");
            for (const id of population.eligibleEvidenceIds)
                if (!store.hasFullyRead(id))
                    throw new Error(`noRealBite requires fully read evidence: ${id}`);
        }
    }
    return output;
}
