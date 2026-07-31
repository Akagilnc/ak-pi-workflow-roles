import { internalRecorderError } from "./errors.js";
import { combineReports, publicRedactionReport, scanJsonValue, } from "./scanner.js";
export function loadPublicManifestSchema() {
    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "Recorder manifest v2",
    };
}
export function validatePublicManifest(value) {
    const record = (candidate) => typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
    const exact = (candidate, keys) => {
        const actual = Object.keys(candidate);
        return actual.length === keys.length && keys.every((key) => Object.hasOwn(candidate, key));
    };
    if (!record(value) || !exact(value, ["version", "archive", "invocation", "session", "execution", "provenance", "artifacts", "receipt", "auditObservation", "child", "recorder", "redaction"])) {
        throw internalRecorderError("manifest", new Error("manifest shape"));
    }
    const manifest = value;
    if (!record(manifest.invocation) || !record(manifest.session) || !record(manifest.execution) ||
        !record(manifest.execution.stdio) || !record(manifest.receipt) || !Array.isArray(manifest.artifacts) ||
        manifest.version !== 2 || manifest.invocation.id !== manifest.session.id ||
        typeof manifest.invocation.id !== "string" || manifest.invocation.id.length === 0 ||
        !Array.isArray(manifest.execution.argv) || !manifest.execution.argv.every((arg) => typeof arg === "string") ||
        manifest.receipt.artifactId !== "receipt" ||
        !["acceptedReceipt", "sanitizedDerivativeOfAcceptedReceipt"].includes(manifest.receipt.artifactKind) ||
        manifest.execution.stdio.stdout !== "pass-through" || manifest.execution.stdio.diagnosticTailBytes !== 4096) {
        throw internalRecorderError("manifest", new Error("manifest invariant"));
    }
    const receipts = manifest.artifacts.filter((artifact) => artifact && typeof artifact === "object" && artifact.id === "receipt" && artifact.kind === "receipt" && artifact.stored?.identity === "stored");
    if (receipts.length !== 1) {
        throw internalRecorderError("manifest", new Error("manifest receipt invariant"));
    }
}
export function buildManifest(options) {
    if (options.child.status === "not-spawned")
        throw internalRecorderError("manifest", new Error("child missing"));
    const skeleton = {
        version: 2,
        archive: options.config.archive,
        invocation: { id: options.config.session.id },
        session: { ...options.session, retention: "caller-owned-raw-not-promoted" },
        execution: {
            argv: options.childArgv,
            cwd: options.config.execution.cwd,
            environment: options.config.execution.environment,
            stdin: "inherit",
            stdio: {
                stdout: "pass-through",
                stderr: "pass-through",
                diagnosticTailBytes: 4096,
            },
        },
        provenance: { ...options.config.provenance, verification: "unverified" },
        artifacts: options.artifacts,
        receipt: {
            toolName: options.extraction.receipt.toolName,
            toolCallId: options.extraction.receipt.toolCallId,
            artifactId: "receipt",
            artifactKind: options.extraction.artifactKind,
        },
        auditObservation: options.extraction.auditObservation,
        child: {
            status: options.child.status,
            exitCode: options.child.exitCode,
            signal: options.child.signal,
        },
        recorder: { status: "completed" },
        redaction: { hits: [] },
    };
    const scanned = scanJsonValue(skeleton, "manifest");
    const report = combineReports(options.scanReport, scanned.report);
    const manifest = scanned.value;
    manifest.redaction.hits = publicRedactionReport(report);
    validatePublicManifest(manifest);
    return { manifest, report };
}
