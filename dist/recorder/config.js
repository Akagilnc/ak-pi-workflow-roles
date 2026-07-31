import { accessSync, constants, readFileSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { RecorderError, safeDiagnostic } from "./errors.js";
import { assertPathNotSymlinkEscape, normalizeRepoRelativePath, requireAbsoluteExistingDirectory, requireCanonicalGitWorktree, resolveInsideRoot, } from "./paths.js";
import { scanString } from "./scanner.js";
const FULL_SHA_RE = /^[0-9a-f]{40}$/i, SHA256_RE = /^[0-9a-f]{64}$/i, ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RESERVED_IDS = new Set(["receipt", "audit-observation", "manifest", "redaction-report"]);
const RESERVED_PATHS = new Set(["receipt.json", "audit-observation.json", "manifest.json", "redaction-report.json"]);
function isRecord(v) { return typeof v === "object" && v !== null && !Array.isArray(v); }
function exact(v, keys) { const actual = Object.keys(v); return actual.length === keys.length && keys.every(k => Object.hasOwn(v, k)); }
function invalid(message, location) { throw new RecorderError("invalid-config", message, { location }); }
function stringAt(v, location) { if (typeof v !== "string" || v.length === 0)
    invalid("value must be a non-empty string", location); return v; }
function nullableStringAt(v, location) { if (v === null)
    return null; if (typeof v !== "string")
    invalid("value must be a string or null", location); return v; }
function relativeAt(v, location) {
    const text = stringAt(v, location);
    try {
        return normalizeRepoRelativePath(text, "config path");
    }
    catch (error) {
        if (error instanceof RecorderError && error.code === "invalid-path")
            throw new RecorderError("invalid-config", "config path is invalid", { cause: error, location });
        throw error;
    }
}
function closed(v, keys, location, label) { if (!isRecord(v) || !exact(v, keys))
    invalid(`${label} shape is invalid`, location); return v; }
function idAt(v, location) { const id = stringAt(v, location); if (!ID_RE.test(id))
    invalid("declaration id is unlawful", location); return id; }
function shaAt(v, re, location, label) { const s = stringAt(v, location); if (!re.test(s))
    invalid(`${label} is invalid`, location); return s.toLowerCase(); }
function absoluteAt(v, location) { const s = stringAt(v, location); if (!isAbsolute(s))
    invalid("path must be absolute", location); return s; }
function parseGit(v, i) { const p = ["declarations", "gitReferences", i]; const r = closed(v, ["id", "repositoryRoot", "commit", "path", "blobOid", "sha256", "kind"], p, "git reference"); const k = r.kind; if (k !== "authority" && k !== "task" && k !== "input" && k !== "exhibit")
    invalid("git reference kind is invalid", [...p, "kind"]); return { id: idAt(r.id, [...p, "id"]), repositoryRoot: absoluteAt(r.repositoryRoot, [...p, "repositoryRoot"]), commit: shaAt(r.commit, FULL_SHA_RE, [...p, "commit"], "commit"), path: relativeAt(r.path, [...p, "path"]), blobOid: shaAt(r.blobOid, FULL_SHA_RE, [...p, "blobOid"], "blob oid"), sha256: shaAt(r.sha256, SHA256_RE, [...p, "sha256"], "sha256"), kind: k }; }
function parseExternal(v, i) { const p = ["declarations", "externalInputs", i]; const r = closed(v, ["id", "sourcePath", "sha256", "kind"], p, "external input"); const k = r.kind; if (k !== "authority" && k !== "task" && k !== "input")
    invalid("external input kind is invalid", [...p, "kind"]); return { id: idAt(r.id, [...p, "id"]), sourcePath: absoluteAt(r.sourcePath, [...p, "sourcePath"]), sha256: shaAt(r.sha256, SHA256_RE, [...p, "sha256"], "sha256"), kind: k }; }
function parseExhibit(v, i) { const p = ["declarations", "exhibits", i]; const r = closed(v, ["id", "sourcePath", "sha256"], p, "exhibit"); return { id: idAt(r.id, [...p, "id"]), sourcePath: absoluteAt(r.sourcePath, [...p, "sourcePath"]), sha256: shaAt(r.sha256, SHA256_RE, [...p, "sha256"], "sha256") }; }
export function parseRecorderArgv(argv) { if (argv.length < 3)
    throw new RecorderError("invalid-argv"); if (argv[0] !== "--config")
    throw new RecorderError("invalid-argv"); const configPath = argv[1]; if (typeof configPath !== "string" || !configPath)
    throw new RecorderError("invalid-argv"); if (argv[2] !== "--")
    throw new RecorderError("invalid-argv"); const childArgv = argv.slice(3); if (!childArgv.length)
    throw new RecorderError("invalid-argv"); return { configPath, childArgv }; }
export function readRecorderConfig(configPath) { try {
    accessSync(configPath, constants.R_OK);
    return readFileSync(configPath, "utf8");
}
catch (error) {
    const code = isRecord(error) ? error.code : null;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "EISDIR")
        throw new RecorderError("invalid-path", "config path is unreadable", { cause: error, location: null, diagnostic: safeDiagnostic("config-read", error) });
    throw error;
} }
export function parseRecorderConfigStructure(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    }
    catch {
        invalid("config JSON is malformed", []);
    }
    const root = closed(raw, ["version", "archive", "execution", "declarations", "provenance"], [], "config");
    if (root.version !== 1)
        invalid("config.version must be 1", ["version"]);
    const archive = closed(root.archive, ["repositoryRoot", "root", "docketId"], ["archive"], "archive");
    const execution = closed(root.execution, ["cwd", "environment", "stdin"], ["execution"], "execution");
    const environment = closed(execution.environment, ["inherit", "overrides", "unset"], ["execution", "environment"], "environment");
    const declarations = closed(root.declarations, ["gitReferences", "externalInputs", "exhibits"], ["declarations"], "declarations");
    const provenance = closed(root.provenance, ["package", "model", "target"], ["provenance"], "provenance");
    if (execution.stdin !== "inherit")
        invalid("execution.stdin must be inherit", ["execution", "stdin"]);
    if (typeof environment.inherit !== "boolean")
        invalid("environment.inherit must be boolean", ["execution", "environment", "inherit"]);
    if (!isRecord(environment.overrides))
        invalid("environment.overrides must be an object", ["execution", "environment", "overrides"]);
    const overrides = {};
    for (const [key, value] of Object.entries(environment.overrides)) {
        if (typeof value !== "string")
            invalid("override values must be strings", ["execution", "environment", "overrides"]);
        overrides[key] = value;
    }
    if (!Array.isArray(environment.unset))
        invalid("environment.unset must be an array", ["execution", "environment", "unset"]);
    const unset = [];
    const seenUnset = new Set();
    for (const [i, value] of environment.unset.entries()) {
        if (typeof value !== "string" || !value)
            invalid("unset entry must be a non-empty string", ["execution", "environment", "unset", i]);
        if (seenUnset.has(value))
            invalid("unset entry is duplicated", ["execution", "environment", "unset", i]);
        if (Object.hasOwn(overrides, value))
            invalid("unset conflicts with overrides", ["execution", "environment", "unset", i]);
        seenUnset.add(value);
        unset.push(value);
    }
    for (const key of ["gitReferences", "externalInputs", "exhibits"])
        if (!Array.isArray(declarations[key]))
            invalid("declaration collection must be an array", ["declarations", key]);
    const gitReferences = declarations.gitReferences.map(parseGit), externalInputs = declarations.externalInputs.map(parseExternal), exhibits = declarations.exhibits.map(parseExhibit);
    const repositoryRoot = absoluteAt(archive.repositoryRoot, ["archive", "repositoryRoot"]), archiveRoot = relativeAt(archive.root, ["archive", "root"]), docketId = relativeAt(archive.docketId, ["archive", "docketId"]), cwd = absoluteAt(execution.cwd, ["execution", "cwd"]);
    const indexed = [...gitReferences.map((item, i) => ({ item, loc: ["declarations", "gitReferences", i, "id"] })), ...externalInputs.map((item, i) => ({ item, loc: ["declarations", "externalInputs", i, "id"] })), ...exhibits.map((item, i) => ({ item, loc: ["declarations", "exhibits", i, "id"] }))];
    const ids = new Set();
    for (const { item, loc } of indexed) {
        if (RESERVED_IDS.has(item.id))
            invalid("declaration uses a reserved generated id", loc);
        if (ids.has(item.id))
            invalid("declaration id is duplicated", loc);
        ids.add(item.id);
    }
    const identities = new Set();
    for (const [i, ref] of gitReferences.entries()) {
        if ([...RESERVED_PATHS].some((reservedPath) => ref.path === reservedPath || ref.path.startsWith(`${reservedPath}/`)))
            invalid("git reference uses a reserved generated path", ["declarations", "gitReferences", i, "path"]);
        const key = [normalize(ref.repositoryRoot), ref.commit, ref.path, ref.blobOid].join("\0");
        if (identities.has(key))
            invalid("git reference identity is duplicated", ["declarations", "gitReferences", i]);
        identities.add(key);
    }
    if (![...gitReferences, ...externalInputs].some(x => x.kind === "authority"))
        invalid("authority declaration is required", ["declarations"]);
    if (![...gitReferences, ...externalInputs].some(x => x.kind === "task"))
        invalid("task declaration is required", ["declarations"]);
    return { version: 1, archive: { repositoryRoot, root: archiveRoot, docketId }, execution: { cwd, environment: { inherit: environment.inherit, overrides, unset }, stdin: "inherit" }, declarations: { gitReferences, externalInputs, exhibits }, provenance: { package: nullableStringAt(provenance.package, ["provenance", "package"]), model: nullableStringAt(provenance.model, ["provenance", "model"]), target: nullableStringAt(provenance.target, ["provenance", "target"]) } };
}
export function scanRecorderConfigMetadata(config) { const values = [[config.archive.repositoryRoot, ["archive", "repositoryRoot"]], [config.archive.root, ["archive", "root"]], [config.archive.docketId, ["archive", "docketId"]], ...config.declarations.gitReferences.map((x, i) => [x.id, ["declarations", "gitReferences", i, "id"]]), ...config.declarations.externalInputs.map((x, i) => [x.id, ["declarations", "externalInputs", i, "id"]]), ...config.declarations.exhibits.map((x, i) => [x.id, ["declarations", "exhibits", i, "id"]])]; for (const [value, location] of values) {
    const scan = scanString(value, "config metadata");
    if (scan.report.redacted || scan.value !== value)
        invalid("metadata must not be credential-shaped", location);
} return config; }
export function loadRecorderConfigStructure(path) { return scanRecorderConfigMetadata(parseRecorderConfigStructure(readRecorderConfig(path))); }
export function validateRecorderConfigState(config) { const repositoryRoot = requireCanonicalGitWorktree(config.archive.repositoryRoot, "archive.repositoryRoot"); const destination = resolveInsideRoot(repositoryRoot, `${config.archive.root}/${config.archive.docketId}`, "archive destination"); assertPathNotSymlinkEscape(destination, repositoryRoot, "archive destination"); const cwd = requireAbsoluteExistingDirectory(config.execution.cwd, "execution.cwd"); return { ...config, archive: { ...config.archive, repositoryRoot }, execution: { ...config.execution, cwd } }; }
export function loadRecorderConfig(path) { return validateRecorderConfigState(loadRecorderConfigStructure(path)); }
export function buildChildEnv(parent, e) { const result = e.inherit ? { ...parent } : {}; for (const n of e.unset)
    delete result[n]; for (const [n, v] of Object.entries(e.overrides))
    result[n] = v; return result; }
