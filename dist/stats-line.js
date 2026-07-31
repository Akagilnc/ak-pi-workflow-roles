import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sha256Hex } from "./sha256.js";
import { validatePublicManifest } from "./recorder/manifest.js";
const execFileAsync = promisify(execFile);
const ROLES = ["judge", "fixer", "coder", "reviewer", "collector", "doctor"];
const UNAVAILABLE_REASONS = ["recorder-does-not-record-invocation-timestamps", "recorder-records-only-accepted-audits", "recorder-does-not-record-wall-clock", "no-apply-receipts", "unclassifiable-receipt", "tracker-metadata-invalid"];
function isRecord(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value, keys) { const actual = Object.keys(value); return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function validMetric(value) { return isRecord(value) && ((value.status === "measured" && exactKeys(value, ["status", "value"])) || (value.status === "unavailable" && exactKeys(value, ["status", "reason"]) && UNAVAILABLE_REASONS.includes(value.reason))); }
export function validateStatsLineV1(value) {
    const top = ["version", "caseKey", "source", "recordedInvocations", "judgeContinueCount", "auditRejectionCount", "recordedInvocationWindow", "issueToDefaultMerge", "paperApplyBytes", "paperApplyWallClock"];
    if (!isRecord(value) || !exactKeys(value, top) || value.version !== 1 || !isRecord(value.caseKey) || !exactKeys(value.caseKey, ["repository", "issueNumber"]) || typeof value.caseKey.repository !== "string" || value.caseKey.repository.trim() === "" || !Number.isSafeInteger(value.caseKey.issueNumber) || Number(value.caseKey.issueNumber) <= 0 || !isRecord(value.source) || !exactKeys(value.source, ["targetCommit", "manifests"]) || typeof value.source.targetCommit !== "string" || !/^[0-9a-f]{40}$/.test(value.source.targetCommit) || !Array.isArray(value.source.manifests))
        throw new Error("Invalid StatsLine v1 contract");
    let prior = "";
    const paths = new Set();
    for (const item of value.source.manifests) {
        if (!isRecord(item) || !exactKeys(item, ["path", "sha256"]) || typeof item.path !== "string" || item.path <= prior || paths.has(item.path) || typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(item.sha256))
            throw new Error("Invalid StatsLine source manifest population");
        prior = item.path;
        paths.add(item.path);
    }
    for (const name of top.slice(3))
        if (!validMetric(value[name]))
            throw new Error(`Invalid StatsLine metric: ${name}`);
    const invocations = value.recordedInvocations;
    if (isRecord(invocations) && invocations.status === "measured") {
        const measuredValue = invocations.value;
        if (!isRecord(measuredValue) || !exactKeys(measuredValue, ["total", "byRole", "unclassified"]) || !Number.isSafeInteger(measuredValue.total) || Number(measuredValue.total) < 0 || !Number.isSafeInteger(measuredValue.unclassified) || Number(measuredValue.unclassified) < 0 || !isRecord(measuredValue.byRole))
            throw new Error("Invalid StatsLine invocation counts");
        const byRole = measuredValue.byRole;
        if (!exactKeys(byRole, ROLES) || !ROLES.every((role) => Number.isSafeInteger(byRole[role]) && Number(byRole[role]) >= 0) || ROLES.reduce((sum, role) => sum + Number(byRole[role]), Number(measuredValue.unclassified)) !== measuredValue.total)
            throw new Error("Invalid StatsLine invocation counts");
    }
    return value;
}
function unavailable(reason) { return { status: "unavailable", reason }; }
function measured(value) { return { status: "measured", value }; }
function flagValues(argv, name) {
    const result = [];
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === name && i + 1 < argv.length)
            result.push(argv[i + 1]);
        else if (argv[i]?.startsWith(`${name}=`))
            result.push(argv[i].slice(name.length + 1));
    }
    return result;
}
function exactFlag(argv, name) {
    const values = flagValues(argv, name);
    return values.length === 1 ? values[0] : undefined;
}
function parseJson(bytes, label) {
    try {
        return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    }
    catch (error) {
        throw new Error(`Invalid ${label}`, { cause: error });
    }
}
function receiptArtifact(manifest) {
    const matches = manifest.artifacts.filter((artifact) => artifact.id === "receipt" && artifact.kind === "receipt" && artifact.stored);
    if (matches.length !== 1)
        throw new Error("Recorder manifest must contain exactly one stored receipt");
    return matches[0].stored;
}
function validTracker(metadata, repository, issueNumber) {
    if (!metadata || metadata.repository !== repository || metadata.issueNumber !== issueNumber ||
        metadata.pullRequest.repository !== repository || !Number.isSafeInteger(metadata.pullRequest.number) || metadata.pullRequest.number <= 0 || metadata.pullRequest.issueNumber !== issueNumber ||
        metadata.pullRequest.base.isDefault !== true || metadata.pullRequest.base.name.trim() === "")
        return unavailable("tracker-metadata-invalid");
    const opened = Date.parse(metadata.issueOpenedAt);
    const merged = Date.parse(metadata.pullRequest.mergedAt);
    if (!Number.isFinite(opened) || !Number.isFinite(merged) || merged < opened)
        return unavailable("tracker-metadata-invalid");
    return measured({ issueOpenedAt: metadata.issueOpenedAt, mergedAt: metadata.pullRequest.mergedAt, milliseconds: merged - opened });
}
export async function produceStatsLineV1(options) {
    if (!Number.isSafeInteger(options.issueNumber) || options.issueNumber <= 0)
        throw new Error("issueNumber must be a positive safe integer");
    if (!/^[0-9a-f]{40}$/.test(options.snapshot.targetCommit))
        throw new Error("targetCommit must be a full commit identity");
    const { isTerminatingToolName, validateAcceptedDetails } = await import("./package-contracts/terminating-tools.js");
    const prefix = `.ak/dockets/issues/${options.issueNumber}/`;
    const allPaths = [...await options.snapshot.list(prefix)].sort();
    const manifestPaths = allPaths.filter((path) => path.startsWith(prefix) && path.endsWith("/manifest.json"));
    const source = [];
    const ids = new Set();
    const byRole = Object.fromEntries(ROLES.map((role) => [role, 0]));
    let unclassified = 0;
    let continues = 0;
    let paperBytes = 0;
    let applyBytes = 0;
    let unclassifiable = false;
    for (const path of manifestPaths) {
        const manifestBytes = await options.snapshot.read(path);
        const value = parseJson(manifestBytes, `manifest ${path}`);
        validatePublicManifest(value);
        const manifest = value;
        if (ids.has(manifest.invocation.id))
            throw new Error(`Duplicate invocation identity: ${manifest.invocation.id}`);
        ids.add(manifest.invocation.id);
        source.push({ path, sha256: sha256Hex(manifestBytes) });
        const stored = receiptArtifact(manifest);
        const receiptPath = `${path.slice(0, -"manifest.json".length)}${stored.path}`;
        if (!allPaths.includes(receiptPath))
            throw new Error(`Inaccessible committed receipt: ${receiptPath}`);
        const receiptBytes = await options.snapshot.read(receiptPath);
        if (receiptBytes.byteLength !== stored.byteLength || sha256Hex(receiptBytes) !== stored.sha256)
            throw new Error(`Receipt identity mismatch: ${receiptPath}`);
        const role = exactFlag(manifest.execution.argv, "--ak-role");
        if (role !== undefined && ROLES.includes(role))
            byRole[role] += 1;
        else
            unclassified += 1;
        const receipt = parseJson(receiptBytes, `receipt ${receiptPath}`);
        if (receipt.toolName !== manifest.receipt.toolName || receipt.toolCallId !== manifest.receipt.toolCallId || receipt.artifactKind !== manifest.receipt.artifactKind || typeof receipt.toolName !== "string" || !isTerminatingToolName(receipt.toolName))
            throw new Error(`Receipt package contract mismatch: ${receiptPath}`);
        const details = validateAcceptedDetails(receipt.toolName, receipt.details);
        if (role === "judge" && "judgeStatus" in details && details.judgeStatus === "continue")
            continues += 1;
        const phase = role === "coder" ? exactFlag(manifest.execution.argv, "--ak-coder-phase") : role === "fixer" ? exactFlag(manifest.execution.argv, "--ak-fixer-phase") : undefined;
        if ((role === "coder" || role === "fixer") && phase === "apply")
            applyBytes += receiptBytes.byteLength;
        else if ((role === "coder" || role === "fixer") && phase === "plan")
            paperBytes += receiptBytes.byteLength;
        else if (role !== undefined && ROLES.includes(role))
            paperBytes += receiptBytes.byteLength;
        else
            unclassifiable = true;
    }
    const ratio = unclassifiable ? unavailable("unclassifiable-receipt")
        : applyBytes === 0 ? unavailable("no-apply-receipts")
            : measured({ numerator: paperBytes, denominator: applyBytes });
    return validateStatsLineV1({
        version: 1,
        caseKey: { repository: options.snapshot.repository, issueNumber: options.issueNumber },
        source: { targetCommit: options.snapshot.targetCommit, manifests: source },
        recordedInvocations: measured({ total: manifestPaths.length, byRole, unclassified }),
        judgeContinueCount: measured(continues),
        auditRejectionCount: unavailable("recorder-records-only-accepted-audits"),
        recordedInvocationWindow: unavailable("recorder-does-not-record-invocation-timestamps"),
        issueToDefaultMerge: validTracker(options.tracker, options.snapshot.repository, options.issueNumber),
        paperApplyBytes: measured({ paperBytes, applyBytes, ratio }),
        paperApplyWallClock: unavailable("recorder-does-not-record-wall-clock"),
    });
}
export function createGitCommittedSnapshot(options) {
    const git = async (...args) => (await execFileAsync("git", ["-C", options.repositoryRoot, ...args], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 })).stdout;
    return {
        repository: options.repository, targetCommit: options.targetCommit,
        async list(prefix) { const out = await git("ls-tree", "-r", "--name-only", "-z", options.targetCommit, "--", prefix); return out.toString("utf8").split("\0").filter(Boolean); },
        async read(path) { return new Uint8Array(await git("show", `${options.targetCommit}:${path}`)); },
    };
}
