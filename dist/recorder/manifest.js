import { internalRecorderError } from "./errors.js";
import { combineReports, publicRedactionReport, scanJsonValue, } from "./scanner.js";
export function loadPublicManifestSchema() {
    return {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        title: "Recorder manifest v2",
    };
}
export function validatePublicManifest(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw internalRecorderError("manifest", new Error("manifest shape"));
    }
    const manifest = value;
    if (manifest.version !== 2 ||
        manifest.invocation.id !== manifest.session.id ||
        !manifest.receipt ||
        manifest.execution.stdio.stdout !== "pass-through" ||
        manifest.execution.stdio.diagnosticTailBytes !== 4096) {
        throw internalRecorderError("manifest", new Error("manifest invariant"));
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
