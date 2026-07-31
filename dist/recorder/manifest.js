import { readFileSync } from "node:fs";
import { Check, Errors } from "typebox/value";
import { internalRecorderError } from "./errors.js";
import { combineReports, publicRedactionReport, scanJsonValue, } from "./scanner.js";
const publicManifestSchema = JSON.parse(readFileSync(new URL("../../schemas/recorder-manifest-v2.schema.json", import.meta.url), "utf8"));
export function loadPublicManifestSchema() {
    return publicManifestSchema;
}
export function validatePublicManifest(value) {
    if (!Check(publicManifestSchema, value)) {
        const first = Errors(publicManifestSchema, value)[0];
        throw internalRecorderError("manifest", new Error(`manifest schema${first ? ` at ${first.instancePath || "/"}: ${first.message}` : ""}`));
    }
    const manifest = value;
    const receipt = manifest.artifacts.find((artifact) => artifact.id === "receipt");
    if (manifest.invocation.id !== manifest.session.id ||
        receipt?.receiptArtifactKind !== manifest.receipt.artifactKind) {
        throw internalRecorderError("manifest", new Error("manifest semantic join"));
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
        artifacts: options.artifacts.map((artifact) => artifact.kind === "receipt"
            ? { ...artifact, receiptArtifactKind: options.extraction.artifactKind }
            : artifact),
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
