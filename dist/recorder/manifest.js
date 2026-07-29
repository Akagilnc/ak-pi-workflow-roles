import { randomUUID } from "node:crypto";
import { RecorderError } from "./errors.js";
import { combineReports, publicRedactionReport, scanJsonValue, scanString, } from "./scanner.js";
function assertCoherentChild(child) {
    if (child.status === "not-spawned") {
        throw new RecorderError("admission-failed", "cannot build success manifest without spawn");
    }
    if (child.status === "exited") {
        if (child.exitCode === null || child.signal !== null) {
            throw new RecorderError("admission-failed", "incoherent exited child outcome");
        }
        return { status: "exited", exitCode: child.exitCode, signal: null };
    }
    if (child.signal === null || child.exitCode !== null) {
        throw new RecorderError("admission-failed", "incoherent signaled child outcome");
    }
    return { status: "signaled", exitCode: null, signal: child.signal };
}
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
            throw new RecorderError("admission-failed", "audit observation without receipt is incoherent");
        }
        if (options.artifacts.some((a) => a.kind === "receipt" || a.id === "receipt")) {
            throw new RecorderError("admission-failed", "receipt artifact without extraction is incoherent");
        }
    }
    else {
        const receiptArtifact = options.artifacts.find((a) => a.id === "receipt");
        if (!receiptArtifact || receiptArtifact.kind !== "receipt") {
            throw new RecorderError("admission-failed", "receipt extraction missing stored artifact");
        }
        if (options.extraction.auditObservation !== null) {
            const auditArtifact = options.artifacts.find((a) => a.id === "audit-observation");
            if (!auditArtifact || auditArtifact.kind !== "audit-observation") {
                throw new RecorderError("admission-failed", "audit observation missing stored artifact");
            }
            if (options.extraction.auditObservation.toolCallId !==
                options.extraction.receipt.toolCallId) {
                throw new RecorderError("admission-failed", "audit observation toolCallId does not match receipt");
            }
        }
    }
    // Each artifact exactly one identity; unique ids and canonical paths.
    const ids = new Set();
    const refKeys = new Set();
    const storedPaths = new Set();
    for (const artifact of options.artifacts) {
        if (ids.has(artifact.id)) {
            throw new RecorderError("admission-failed", `duplicate artifact id ${artifact.id}`);
        }
        ids.add(artifact.id);
        const hasRef = artifact.reference !== undefined;
        const hasStored = artifact.stored !== undefined;
        if (hasRef === hasStored) {
            throw new RecorderError("admission-failed", `artifact ${artifact.id} must have exactly one identity`);
        }
        if (artifact.reference) {
            const key = [
                artifact.reference.repositoryRoot,
                artifact.reference.commit,
                artifact.reference.path,
                artifact.reference.blobOid,
            ].join("|");
            if (refKeys.has(key)) {
                throw new RecorderError("admission-failed", `duplicate reference identity for ${artifact.id}`);
            }
            refKeys.add(key);
        }
        if (artifact.stored) {
            if (storedPaths.has(artifact.stored.path)) {
                throw new RecorderError("admission-failed", `duplicate stored path for ${artifact.id}`);
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
    const manifest = {
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
        redaction: {
            hits: publicRedactionReport(combineReports(options.scanReport, argvScan.report, cwdScan.report, envScan.report, provenanceScan.report, archiveScan.report, options.extraction.report)),
        },
    };
    const manifestScan = scanJsonValue(manifest, "manifest");
    // If scanning the manifest itself hits secrets, those must be in the report.
    // Post-manifest redaction hits that would change the already-built object fail closed
    // only when the scan mutates discriminants — scanJsonValue already redacts strings.
    if (manifestScan.report.redacted) {
        // Rebuild hits to include manifest scan; values already redacted in value.
        const mergedHits = publicRedactionReport(combineReports(options.scanReport, argvScan.report, cwdScan.report, envScan.report, provenanceScan.report, archiveScan.report, options.extraction.report, manifestScan.report));
        manifestScan.value.redaction.hits = mergedHits;
    }
    return {
        manifest: manifestScan.value,
        report: combineReports(options.scanReport, argvScan.report, cwdScan.report, envScan.report, provenanceScan.report, archiveScan.report, options.extraction.report, manifestScan.report),
    };
}
