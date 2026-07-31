import { accessSync, constants, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { RecorderError } from "./errors.js";
import { assertNotReservedArtifactId, assertPathNotSymlinkEscape, normalizeRepoRelativePath, requireAbsoluteExistingDirectory, requireCanonicalGitWorktree, resolveInsideRoot, } from "./paths.js";
import { scanString } from "./scanner.js";
const FULL_SHA_RE = /^[0-9a-f]{40}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const BLOB_OID_RE = /^[0-9a-f]{40}$/i;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function hasExactKeys(value, expected) {
    const keys = Object.keys(value);
    return (keys.length === expected.length &&
        expected.every((key) => Object.hasOwn(value, key)));
}
function requireString(value, label) {
    if (typeof value !== "string" || value.length === 0) {
        throw new RecorderError("invalid-config", `${label} must be a non-empty string`);
    }
    return value;
}
function normalizeStructuralPath(value, location) {
    try {
        return normalizeRepoRelativePath(value, "config path");
    }
    catch (error) {
        throw new RecorderError("invalid-config", "config path is invalid", {
            cause: error,
            location,
        });
    }
}
function requireStringOrNull(value, label) {
    if (value === null)
        return null;
    if (typeof value !== "string") {
        throw new RecorderError("invalid-config", `${label} must be a string or null`);
    }
    return value;
}
/**
 * Structural metadata (archive identity, declaration ids) becomes path segments
 * and report locations. Redaction would damage identity, so a scanner hit fails
 * closed before path construction or later diagnostics can observe the raw value.
 */
function requireCredentialFreeMetadata(value, label) {
    const scanned = scanString(value, label);
    if (scanned.report.redacted || scanned.value !== value) {
        throw new RecorderError("invalid-config", `${label} must not be credential-shaped`);
    }
    return value;
}
function parseGitReference(raw, index) {
    if (!isRecord(raw) || !hasExactKeys(raw, [
        "id",
        "repositoryRoot",
        "commit",
        "path",
        "blobOid",
        "sha256",
        "kind",
    ])) {
        throw new RecorderError("invalid-config", `declarations.gitReferences[${index}] has invalid shape`);
    }
    const id = requireCredentialFreeMetadata(requireString(raw.id, `declarations.gitReferences[${index}].id`), `declarations.gitReferences[${index}].id`);
    if (!ID_RE.test(id)) {
        throw new RecorderError("invalid-config", `declarations.gitReferences[${index}].id is unlawful`);
    }
    const kind = raw.kind;
    if (kind !== "authority" && kind !== "task" && kind !== "input" &&
        kind !== "exhibit") {
        throw new RecorderError("invalid-config", `declarations.gitReferences[${index}].kind is invalid`, { location: ["declarations", "gitReferences", index, "kind"] });
    }
    const commit = requireString(raw.commit, `declarations.gitReferences[${index}].commit`);
    if (!FULL_SHA_RE.test(commit)) {
        throw new RecorderError("invalid-config", `declarations.gitReferences[${index}].commit must be a full SHA`);
    }
    const blobOid = requireString(raw.blobOid, `declarations.gitReferences[${index}].blobOid`);
    if (!BLOB_OID_RE.test(blobOid)) {
        throw new RecorderError("invalid-config", `declarations.gitReferences[${index}].blobOid must be a full Git object id`);
    }
    const sha256 = requireString(raw.sha256, `declarations.gitReferences[${index}].sha256`);
    if (!SHA256_RE.test(sha256)) {
        throw new RecorderError("invalid-config", `declarations.gitReferences[${index}].sha256 must be sha256 hex`);
    }
    return {
        id,
        repositoryRoot: requireString(raw.repositoryRoot, `declarations.gitReferences[${index}].repositoryRoot`),
        commit: commit.toLowerCase(),
        path: normalizeStructuralPath(requireString(raw.path, `declarations.gitReferences[${index}].path`), ["declarations", "gitReferences", index, "path"]),
        blobOid: blobOid.toLowerCase(),
        sha256: sha256.toLowerCase(),
        kind,
    };
}
function parseExternalInput(raw, index) {
    if (!isRecord(raw) || !hasExactKeys(raw, ["id", "sourcePath", "sha256", "kind"])) {
        throw new RecorderError("invalid-config", `declarations.externalInputs[${index}] has invalid shape`);
    }
    const id = requireCredentialFreeMetadata(requireString(raw.id, `declarations.externalInputs[${index}].id`), `declarations.externalInputs[${index}].id`);
    if (!ID_RE.test(id)) {
        throw new RecorderError("invalid-config", `declarations.externalInputs[${index}].id is unlawful`);
    }
    const kind = raw.kind;
    if (kind !== "authority" && kind !== "task" && kind !== "input") {
        throw new RecorderError("invalid-config", `declarations.externalInputs[${index}].kind is invalid`, { location: ["declarations", "externalInputs", index, "kind"] });
    }
    const sourcePath = requireString(raw.sourcePath, `declarations.externalInputs[${index}].sourcePath`);
    if (!isAbsolute(sourcePath)) {
        throw new RecorderError("invalid-config", `declarations.externalInputs[${index}].sourcePath must be absolute`);
    }
    const sha256 = requireString(raw.sha256, `declarations.externalInputs[${index}].sha256`);
    if (!SHA256_RE.test(sha256)) {
        throw new RecorderError("invalid-config", `declarations.externalInputs[${index}].sha256 must be sha256 hex`);
    }
    return { id, sourcePath, sha256: sha256.toLowerCase(), kind };
}
function parseExhibit(raw, index) {
    if (!isRecord(raw) || !hasExactKeys(raw, ["id", "sourcePath", "sha256"])) {
        throw new RecorderError("invalid-config", `declarations.exhibits[${index}] has invalid shape`);
    }
    const id = requireCredentialFreeMetadata(requireString(raw.id, `declarations.exhibits[${index}].id`), `declarations.exhibits[${index}].id`);
    if (!ID_RE.test(id)) {
        throw new RecorderError("invalid-config", `declarations.exhibits[${index}].id is unlawful`);
    }
    const sourcePath = requireString(raw.sourcePath, `declarations.exhibits[${index}].sourcePath`);
    if (!isAbsolute(sourcePath)) {
        throw new RecorderError("invalid-config", `declarations.exhibits[${index}].sourcePath must be absolute`);
    }
    const sha256 = requireString(raw.sha256, `declarations.exhibits[${index}].sha256`);
    if (!SHA256_RE.test(sha256)) {
        throw new RecorderError("invalid-config", `declarations.exhibits[${index}].sha256 must be sha256 hex`);
    }
    return { id, sourcePath, sha256: sha256.toLowerCase() };
}
export function parseRecorderArgv(argv) {
    // argv is process.argv.slice(2)
    if (argv.length < 3) {
        throw new RecorderError("invalid-argv", "usage: ak-docket-record --config <json-path> -- <command> [args...]");
    }
    if (argv[0] !== "--config") {
        throw new RecorderError("invalid-argv", "Recorder accepts only --config before --");
    }
    const configPath = argv[1];
    if (typeof configPath !== "string" || configPath.length === 0) {
        throw new RecorderError("invalid-argv", "--config requires a path");
    }
    if (argv[2] !== "--") {
        throw new RecorderError("invalid-argv", "Recorder requires -- before the child command");
    }
    const childArgv = argv.slice(3);
    if (childArgv.length === 0) {
        throw new RecorderError("invalid-argv", "child argv must not be empty");
    }
    // Reject any additional Recorder options before --
    for (let i = 0; i < 2; i++) {
        const token = argv[i];
        if (i === 0)
            continue;
        if (token.startsWith("-") && token !== "--config") {
            throw new RecorderError("invalid-argv", `unknown Recorder option: ${token}`);
        }
    }
    return { configPath, childArgv };
}
export function loadRecorderConfigStructure(configPath) {
    let text;
    try {
        accessSync(configPath, constants.R_OK);
        text = readFileSync(configPath, "utf8");
    }
    catch {
        throw new RecorderError("invalid-config", "config JSON is unreadable");
    }
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        throw new RecorderError("invalid-config", "config JSON is malformed");
    }
    if (!isRecord(raw) || !hasExactKeys(raw, [
        "version",
        "archive",
        "execution",
        "declarations",
        "provenance",
    ])) {
        throw new RecorderError("invalid-config", "config must be a closed version-1 object");
    }
    if (raw.version !== 1) {
        throw new RecorderError("invalid-config", "config.version must be 1");
    }
    if (!isRecord(raw.archive) || !hasExactKeys(raw.archive, [
        "repositoryRoot",
        "root",
        "docketId",
    ])) {
        throw new RecorderError("invalid-config", "archive shape is invalid");
    }
    if (!isRecord(raw.execution) || !hasExactKeys(raw.execution, [
        "cwd",
        "environment",
        "stdin",
    ])) {
        throw new RecorderError("invalid-config", "execution shape is invalid");
    }
    if (!isRecord(raw.execution.environment) || !hasExactKeys(raw.execution.environment, ["inherit", "overrides", "unset"])) {
        throw new RecorderError("invalid-config", "execution.environment shape is invalid");
    }
    if (!isRecord(raw.declarations) || !hasExactKeys(raw.declarations, [
        "gitReferences",
        "externalInputs",
        "exhibits",
    ])) {
        throw new RecorderError("invalid-config", "declarations shape is invalid");
    }
    if (!isRecord(raw.provenance) || !hasExactKeys(raw.provenance, [
        "package",
        "model",
        "target",
    ])) {
        throw new RecorderError("invalid-config", "provenance shape is invalid");
    }
    if (raw.execution.stdin !== "inherit") {
        throw new RecorderError("invalid-config", "execution.stdin must be inherit");
    }
    if (typeof raw.execution.environment.inherit !== "boolean") {
        throw new RecorderError("invalid-config", "execution.environment.inherit must be boolean");
    }
    if (!isRecord(raw.execution.environment.overrides)) {
        throw new RecorderError("invalid-config", "execution.environment.overrides must be an object");
    }
    const overrides = {};
    for (const [key, value] of Object.entries(raw.execution.environment.overrides)) {
        if (typeof value !== "string") {
            throw new RecorderError("invalid-config", "execution.environment.overrides values must be strings");
        }
        overrides[key] = value;
    }
    if (!Array.isArray(raw.execution.environment.unset)) {
        throw new RecorderError("invalid-config", "execution.environment.unset must be an array");
    }
    const unset = [];
    const unsetSeen = new Set();
    for (const name of raw.execution.environment.unset) {
        if (typeof name !== "string" || name.length === 0) {
            throw new RecorderError("invalid-config", "execution.environment.unset entries must be non-empty strings");
        }
        if (unsetSeen.has(name)) {
            throw new RecorderError("invalid-config", "execution.environment.unset must not contain duplicates");
        }
        unsetSeen.add(name);
        unset.push(name);
    }
    for (const name of unset) {
        if (Object.hasOwn(overrides, name)) {
            throw new RecorderError("invalid-config", "execution.environment unset/overrides must not overlap");
        }
    }
    if (!Array.isArray(raw.declarations.gitReferences) ||
        !Array.isArray(raw.declarations.externalInputs) ||
        !Array.isArray(raw.declarations.exhibits)) {
        throw new RecorderError("invalid-config", "declaration collections must be arrays");
    }
    // Parse every structure-only declaration before consulting filesystem or Git.
    const gitReferences = raw.declarations.gitReferences.map(parseGitReference);
    const externalInputs = raw.declarations.externalInputs.map(parseExternalInput);
    const exhibits = raw.declarations.exhibits.map(parseExhibit);
    const repositoryRootRaw = requireCredentialFreeMetadata(requireString(raw.archive.repositoryRoot, "archive.repositoryRoot"), "archive.repositoryRoot");
    if (!isAbsolute(repositoryRootRaw)) {
        throw new RecorderError("invalid-config", "archive.repositoryRoot must be absolute", {
            location: ["archive", "repositoryRoot"],
        });
    }
    const repositoryRoot = repositoryRootRaw;
    const root = requireCredentialFreeMetadata(normalizeStructuralPath(requireString(raw.archive.root, "archive.root"), ["archive", "root"]), "archive.root");
    const docketId = requireCredentialFreeMetadata(normalizeStructuralPath(requireString(raw.archive.docketId, "archive.docketId"), ["archive", "docketId"]), "archive.docketId");
    const cwd = requireString(raw.execution.cwd, "execution.cwd");
    if (!isAbsolute(cwd)) {
        throw new RecorderError("invalid-config", "execution.cwd must be absolute", {
            location: ["execution", "cwd"],
        });
    }
    const ids = new Set();
    for (const item of [...gitReferences, ...externalInputs, ...exhibits]) {
        assertNotReservedArtifactId(item.id, `declaration ${item.id}`);
        if (ids.has(item.id)) {
            throw new RecorderError("invalid-config", `declaration id is duplicated: ${item.id}`);
        }
        ids.add(item.id);
    }
    // Reject generated-as-future reference claims: git references must not use reserved generated ids
    // (already checked). Also reject commit-shaped placeholders that are all zeros as unresolvable later.
    const hasAuthority = gitReferences.some((item) => item.kind === "authority") ||
        externalInputs.some((item) => item.kind === "authority");
    const hasTask = gitReferences.some((item) => item.kind === "task") ||
        externalInputs.some((item) => item.kind === "task");
    if (!hasAuthority || !hasTask) {
        throw new RecorderError("invalid-config", "declarations must include at least one authority and one task", { location: ["declarations"] });
    }
    return {
        version: 1,
        archive: { repositoryRoot, root, docketId },
        execution: {
            cwd,
            environment: {
                inherit: raw.execution.environment.inherit,
                overrides,
                unset,
            },
            stdin: "inherit",
        },
        declarations: { gitReferences, externalInputs, exhibits },
        provenance: {
            package: requireStringOrNull(raw.provenance.package, "provenance.package"),
            model: requireStringOrNull(raw.provenance.model, "provenance.model"),
            target: requireStringOrNull(raw.provenance.target, "provenance.target"),
        },
    };
}
/** Consult external filesystem and Git state only after pure structure succeeds. */
export function validateRecorderConfigState(config) {
    const repositoryRoot = requireCanonicalGitWorktree(config.archive.repositoryRoot, "archive.repositoryRoot");
    const destination = resolveInsideRoot(repositoryRoot, `${config.archive.root}/${config.archive.docketId}`, "archive destination");
    assertPathNotSymlinkEscape(destination, repositoryRoot, "archive destination");
    const cwd = requireAbsoluteExistingDirectory(config.execution.cwd, "execution.cwd");
    return {
        ...config,
        archive: { ...config.archive, repositoryRoot },
        execution: { ...config.execution, cwd },
    };
}
/** Backwards-compatible stateful loader; production orchestration calls both phases explicitly. */
export function loadRecorderConfig(configPath) {
    return validateRecorderConfigState(loadRecorderConfigStructure(configPath));
}
export function buildChildEnv(parentEnv, environment) {
    const base = environment.inherit ? { ...parentEnv } : {};
    for (const name of environment.unset) {
        delete base[name];
    }
    for (const [name, value] of Object.entries(environment.overrides)) {
        base[name] = value;
    }
    return base;
}
