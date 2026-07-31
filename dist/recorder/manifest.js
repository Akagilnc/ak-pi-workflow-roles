import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { RecorderError } from "./errors.js";
import { combineReports, publicRedactionReport, scanJsonValue, scanString, } from "./scanner.js";
let cachedSchema = null;
function publicManifestSchemaPath() {
    return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "schemas", "recorder-manifest-v1.schema.json");
}
export function loadPublicManifestSchema() {
    if (cachedSchema !== null)
        return cachedSchema;
    try {
        cachedSchema = JSON.parse(readFileSync(publicManifestSchemaPath(), "utf8"));
    }
    catch (error) {
        throw new RecorderError("internal-error", "public manifest schema is unreadable", { cause: error });
    }
    return cachedSchema;
}
function isObject(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
function deepEqual(a, b) {
    if (Object.is(a, b))
        return true;
    if (typeof a !== typeof b)
        return false;
    if (a === null || b === null)
        return a === b;
    if (Array.isArray(a)) {
        if (!Array.isArray(b) || a.length !== b.length)
            return false;
        return a.every((item, index) => deepEqual(item, b[index]));
    }
    if (typeof a === "object") {
        if (!isObject(b))
            return false;
        const aKeys = Object.keys(a).sort();
        const bKeys = Object.keys(b).sort();
        if (aKeys.length !== bKeys.length)
            return false;
        return aKeys.every((key, index) => key === bKeys[index] &&
            deepEqual(a[key], b[key]));
    }
    return false;
}
function resolveRef(root, ref) {
    if (typeof root === "boolean") {
        throw new RecorderError("internal-error", "public manifest schema $ref is unresolvable");
    }
    if (!ref.startsWith("#/")) {
        throw new RecorderError("internal-error", "public manifest schema $ref must be local");
    }
    let current = root;
    for (const part of ref.slice(2).split("/")) {
        if (!isObject(current) || !Object.hasOwn(current, part)) {
            throw new RecorderError("internal-error", "public manifest schema $ref is unresolvable");
        }
        current = current[part];
    }
    if (typeof current !== "object" || current === null) {
        if (typeof current === "boolean")
            return current;
        throw new RecorderError("internal-error", "public manifest schema $ref is unresolvable");
    }
    return current;
}
function typeMatches(typeName, value) {
    switch (typeName) {
        case "object":
            return isObject(value);
        case "array":
            return Array.isArray(value);
        case "string":
            return typeof value === "string";
        case "boolean":
            return typeof value === "boolean";
        case "number":
            return typeof value === "number" && Number.isFinite(value);
        case "integer":
            return typeof value === "number" && Number.isInteger(value);
        case "null":
            return value === null;
        default:
            return false;
    }
}
/**
 * Minimal draft-2020-12 evaluator for the public recorder manifest schema.
 * Loads and checks the exact shipped schema document — no parallel contract.
 */
function schemaValid(root, schema, value) {
    if (schema === true)
        return true;
    if (schema === false)
        return false;
    if (!isObject(schema))
        return false;
    if (typeof schema.$ref === "string") {
        return schemaValid(root, resolveRef(root, schema.$ref), value);
    }
    if (Object.hasOwn(schema, "const") && !deepEqual(schema.const, value)) {
        return false;
    }
    if (Object.hasOwn(schema, "enum")) {
        if (!Array.isArray(schema.enum))
            return false;
        if (!schema.enum.some((item) => deepEqual(item, value)))
            return false;
    }
    if (Object.hasOwn(schema, "type")) {
        const types = Array.isArray(schema.type) ? schema.type : [schema.type];
        if (!types.every((item) => typeof item === "string") ||
            !types.some((item) => typeMatches(item, value))) {
            return false;
        }
    }
    if (typeof schema.minimum === "number") {
        if (typeof value !== "number" || value < schema.minimum)
            return false;
    }
    if (typeof schema.minLength === "number") {
        if (typeof value !== "string" || value.length < schema.minLength) {
            return false;
        }
    }
    if (typeof schema.pattern === "string") {
        if (typeof value !== "string")
            return false;
        if (!new RegExp(schema.pattern, "u").test(value))
            return false;
    }
    if (typeof schema.minItems === "number") {
        if (!Array.isArray(value) || value.length < schema.minItems)
            return false;
    }
    if (Object.hasOwn(schema, "items")) {
        if (!Array.isArray(value))
            return false;
        const itemSchema = schema.items;
        if (!value.every((item) => schemaValid(root, itemSchema, item))) {
            return false;
        }
    }
    if (Object.hasOwn(schema, "contains")) {
        if (!Array.isArray(value))
            return false;
        const containsSchema = schema.contains;
        const matches = value.filter((item) => schemaValid(root, containsSchema, item)).length;
        const min = typeof schema.minContains === "number" ? schema.minContains : 1;
        const max = typeof schema.maxContains === "number"
            ? schema.maxContains
            : Number.POSITIVE_INFINITY;
        if (matches < min || matches > max)
            return false;
    }
    if (isObject(value)) {
        if (Array.isArray(schema.required)) {
            for (const key of schema.required) {
                if (typeof key !== "string" || !Object.hasOwn(value, key))
                    return false;
            }
        }
        const properties = isObject(schema.properties) ? schema.properties : null;
        if (properties) {
            for (const [key, childSchema] of Object.entries(properties)) {
                if (!Object.hasOwn(value, key))
                    continue;
                if (!schemaValid(root, childSchema, value[key])) {
                    return false;
                }
            }
        }
        if (schema.additionalProperties === false) {
            const allowed = new Set(properties ? Object.keys(properties) : []);
            for (const key of Object.keys(value)) {
                if (!allowed.has(key))
                    return false;
            }
        }
        else if (Object.hasOwn(schema, "additionalProperties")) {
            const addSchema = schema.additionalProperties;
            const known = new Set(properties ? Object.keys(properties) : []);
            for (const [key, child] of Object.entries(value)) {
                if (known.has(key))
                    continue;
                if (!schemaValid(root, addSchema, child))
                    return false;
            }
        }
    }
    else if (Object.hasOwn(schema, "properties") ||
        Object.hasOwn(schema, "required") ||
        schema.additionalProperties === false) {
        // Object keywords only apply to objects; type mismatch already handled.
        if (schema.type === "object" ||
            (Array.isArray(schema.type) && schema.type.includes("object"))) {
            return false;
        }
    }
    if (Array.isArray(schema.allOf)) {
        if (!schema.allOf.every((part) => schemaValid(root, part, value))) {
            return false;
        }
    }
    if (Array.isArray(schema.oneOf)) {
        let matches = 0;
        for (const part of schema.oneOf) {
            if (schemaValid(root, part, value))
                matches += 1;
            if (matches > 1)
                return false;
        }
        if (matches !== 1)
            return false;
    }
    if (Array.isArray(schema.anyOf)) {
        if (!schema.anyOf.some((part) => schemaValid(root, part, value))) {
            return false;
        }
    }
    if (Object.hasOwn(schema, "not")) {
        if (schemaValid(root, schema.not, value))
            return false;
    }
    if (Object.hasOwn(schema, "if")) {
        const matched = schemaValid(root, schema.if, value);
        if (matched) {
            if (Object.hasOwn(schema, "then") &&
                !schemaValid(root, schema.then, value)) {
                return false;
            }
        }
        else if (Object.hasOwn(schema, "else") &&
            !schemaValid(root, schema.else, value)) {
            return false;
        }
    }
    return true;
}
/** Validate a value against the shipped public v1 manifest schema. */
export function validatePublicManifest(value) {
    const schema = loadPublicManifestSchema();
    if (!schemaValid(schema, schema, value)) {
        throw new RecorderError("internal-error", "manifest failed public schema validation");
    }
}
function assertCoherentChild(child) {
    if (child.status === "not-spawned") {
        throw new RecorderError("internal-error", "cannot build success manifest without spawn");
    }
    if (child.status === "exited") {
        if (child.exitCode === null || child.signal !== null) {
            throw new RecorderError("internal-error", "incoherent exited child outcome");
        }
        return { status: "exited", exitCode: child.exitCode, signal: null };
    }
    if (child.signal === null || child.exitCode !== null) {
        throw new RecorderError("internal-error", "incoherent signaled child outcome");
    }
    return { status: "signaled", exitCode: null, signal: child.signal };
}
function assertRuntimeJoins(manifest) {
    // Equal-value joins ordinary JSON Schema cannot express.
    if (manifest.receipt !== null && manifest.auditObservation !== null) {
        if (manifest.receipt.toolCallId !== manifest.auditObservation.toolCallId) {
            throw new RecorderError("internal-error", "audit observation toolCallId does not match receipt");
        }
        if (manifest.receipt.toolName !== manifest.auditObservation.toolName) {
            throw new RecorderError("internal-error", "audit observation toolName does not match receipt");
        }
    }
    if (manifest.receipt !== null) {
        const receiptArtifact = manifest.artifacts.find((a) => a.id === "receipt");
        if (!receiptArtifact ||
            receiptArtifact.receiptArtifactKind !== manifest.receipt.artifactKind) {
            throw new RecorderError("internal-error", "receipt artifact kind does not match receipt metadata");
        }
    }
}
/**
 * Build the final success manifest with one stable scan closure, then validate
 * against the public schema before the caller persists it.
 */
export function buildManifest(options) {
    const { config } = options;
    const argvScan = scanJsonValue(options.childArgv, "execution.argv");
    const cwdScan = scanString(config.execution.cwd, "execution.cwd");
    const envScan = scanJsonValue(config.execution.environment, "execution.environment");
    const provenanceScan = scanJsonValue({
        package: config.provenance.package,
        model: config.provenance.model,
        target: config.provenance.target,
    }, "provenance");
    const archiveScan = scanJsonValue({
        repositoryRoot: config.archive.repositoryRoot,
        root: config.archive.root,
        docketId: config.archive.docketId,
    }, "archive");
    const child = assertCoherentChild(options.child);
    // Receipt/audit link coherence.
    if (options.extraction.receipt === null) {
        if (options.extraction.auditObservation !== null) {
            throw new RecorderError("internal-error", "audit observation without receipt is incoherent");
        }
        if (options.artifacts.some((a) => a.kind === "receipt" || a.id === "receipt")) {
            throw new RecorderError("internal-error", "receipt artifact without extraction is incoherent");
        }
    }
    else {
        const receiptArtifact = options.artifacts.find((a) => a.id === "receipt");
        if (!receiptArtifact || receiptArtifact.kind !== "receipt") {
            throw new RecorderError("internal-error", "receipt extraction missing stored artifact");
        }
        if (options.extraction.auditObservation !== null) {
            const auditArtifact = options.artifacts.find((a) => a.id === "audit-observation");
            if (!auditArtifact || auditArtifact.kind !== "audit-observation") {
                throw new RecorderError("internal-error", "audit observation missing stored artifact");
            }
            if (options.extraction.auditObservation.toolCallId !==
                options.extraction.receipt.toolCallId) {
                throw new RecorderError("internal-error", "audit observation toolCallId does not match receipt");
            }
        }
    }
    // Each artifact exactly one identity; unique ids and canonical paths.
    const ids = new Set();
    const refKeys = new Set();
    const storedPaths = new Set();
    for (const artifact of options.artifacts) {
        if (ids.has(artifact.id)) {
            throw new RecorderError("internal-error", `duplicate artifact id ${artifact.id}`);
        }
        ids.add(artifact.id);
        const hasRef = artifact.reference !== undefined;
        const hasStored = artifact.stored !== undefined;
        if (hasRef === hasStored) {
            throw new RecorderError("internal-error", `artifact ${artifact.id} must have exactly one identity`);
        }
        if (artifact.reference) {
            const key = [
                artifact.reference.repositoryRoot,
                artifact.reference.commit,
                artifact.reference.path,
                artifact.reference.blobOid,
            ].join("|");
            if (refKeys.has(key)) {
                throw new RecorderError("internal-error", `duplicate reference identity for ${artifact.id}`);
            }
            refKeys.add(key);
        }
        if (artifact.stored) {
            if (storedPaths.has(artifact.stored.path)) {
                throw new RecorderError("internal-error", `duplicate stored path for ${artifact.id}`);
            }
            storedPaths.add(artifact.stored.path);
        }
    }
    const receiptMeta = options.extraction.receipt === null
        ? null
        : {
            toolName: options.extraction.receipt.toolName,
            toolCallId: options.extraction.receipt.toolCallId,
            artifactId: "receipt",
            artifactKind: options.extraction.artifactKind,
        };
    const baseReport = combineReports(options.scanReport, argvScan.report, cwdScan.report, envScan.report, provenanceScan.report, archiveScan.report, options.extraction.report);
    const skeleton = {
        version: 1,
        archive: archiveScan.value,
        invocation: {
            id: options.invocationId ?? randomUUID(),
        },
        execution: {
            argv: argvScan.value,
            cwd: cwdScan.value,
            environment: envScan.value,
            stdin: "inherit",
            stdio: { stdout: "tee", stderr: "tee" },
        },
        provenance: {
            ...provenanceScan.value,
            verification: "unverified",
        },
        artifacts: options.artifacts.map((artifact) => {
            const base = {
                id: artifact.id,
                kind: artifact.kind,
                redactionStatus: artifact.redactionStatus,
            };
            if (artifact.reference !== undefined) {
                base.reference = artifact.reference;
            }
            if (artifact.stored !== undefined) {
                base.stored = artifact.stored;
            }
            if (artifact.id === "receipt" && options.extraction.artifactKind) {
                base.receiptArtifactKind = options.extraction.artifactKind;
            }
            return base;
        }),
        receipt: receiptMeta,
        auditObservation: options.extraction.auditObservation,
        child,
        recorder: { status: "completed" },
        redaction: { hits: publicRedactionReport(baseReport) },
    };
    // Single stable final-scan closure: scan the complete manifest, fold every
    // new hit into redaction.hits, and rescan until the hit set is closed.
    let report = baseReport;
    let manifest = skeleton;
    for (let round = 0; round < 8; round += 1) {
        manifest = {
            ...manifest,
            redaction: { hits: publicRedactionReport(report) },
        };
        const scanned = scanJsonValue(manifest, "manifest");
        const closed = combineReports(report, scanned.report);
        const nextManifest = scanned.value;
        nextManifest.redaction = { hits: publicRedactionReport(closed) };
        const hitsStable = deepEqual(publicRedactionReport(report), nextManifest.redaction.hits);
        manifest = nextManifest;
        report = closed;
        if (hitsStable && !scanned.report.redacted) {
            break;
        }
        if (hitsStable) {
            // Values were already redacted and hits did not grow — closed.
            break;
        }
    }
    // Final defensive rescan: no further mutations may remain.
    const verify = scanJsonValue(manifest, "manifest");
    if (verify.report.redacted) {
        report = combineReports(report, verify.report);
        manifest = verify.value;
        manifest.redaction = { hits: publicRedactionReport(report) };
    }
    else {
        manifest = verify.value;
        manifest.redaction = { hits: publicRedactionReport(report) };
    }
    assertRuntimeJoins(manifest);
    validatePublicManifest(manifest);
    return {
        manifest,
        report: {
            hits: publicRedactionReport(report),
            redacted: report.redacted || publicRedactionReport(report).length > 0,
        },
    };
}
