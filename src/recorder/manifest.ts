import type { RecorderConfig } from "./config.ts";
import type { AdmittedArtifact } from "./admit.ts";
import type { ChildOutcome } from "./errors.ts";
import { internalRecorderError } from "./errors.ts";
import type { AuditObservation, ExtractionResult } from "./extract.ts";
import {
  combineReports,
  publicRedactionReport,
  scanJsonValue,
  type ScanReport,
} from "./scanner.ts";

export type RecorderManifestV2 = {
  version: 2;
  archive: RecorderConfig["archive"];
  invocation: { id: string };
  session: {
    id: string;
    directory: string;
    basename: string;
    sha256: string;
    byteLength: number;
    retention: "caller-owned-raw-not-promoted";
  };
  execution: {
    argv: string[];
    cwd: string;
    environment: RecorderConfig["execution"]["environment"];
    stdin: "inherit";
    stdio: {
      stdout: "pass-through";
      stderr: "pass-through";
      diagnosticTailBytes: 4096;
    };
  };
  provenance: RecorderConfig["provenance"] & { verification: "unverified" };
  artifacts: AdmittedArtifact[];
  receipt: {
    toolName: string;
    toolCallId: string;
    artifactId: "receipt";
    artifactKind: "acceptedReceipt" | "sanitizedDerivativeOfAcceptedReceipt";
  };
  auditObservation: AuditObservation | null;
  child: {
    status: "exited" | "signaled";
    exitCode: number | null;
    signal: string | null;
  };
  recorder: { status: "completed" };
  redaction: {
    hits: Array<{ ruleId: string; location: string; count: number }>;
  };
};

export function loadPublicManifestSchema() {
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Recorder manifest v2",
  };
}

export function validatePublicManifest(
  value: unknown,
): asserts value is RecorderManifestV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw internalRecorderError("manifest", new Error("manifest shape"));
  }
  const manifest = value as RecorderManifestV2;
  if (
    manifest.version !== 2 ||
    manifest.invocation.id !== manifest.session.id ||
    !manifest.receipt ||
    manifest.execution.stdio.stdout !== "pass-through" ||
    manifest.execution.stdio.diagnosticTailBytes !== 4096
  ) {
    throw internalRecorderError("manifest", new Error("manifest invariant"));
  }
}

export function buildManifest(options: {
  config: RecorderConfig;
  childArgv: string[];
  artifacts: AdmittedArtifact[];
  extraction: ExtractionResult;
  child: ChildOutcome;
  scanReport: ScanReport;
  session: {
    id: string;
    directory: string;
    basename: string;
    sha256: string;
    byteLength: number;
  };
}): { manifest: RecorderManifestV2; report: ScanReport } {
  if (options.child.status === "not-spawned")
    throw internalRecorderError("manifest", new Error("child missing"));
  const skeleton: RecorderManifestV2 = {
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
  const manifest = scanned.value as RecorderManifestV2;
  manifest.redaction.hits = publicRedactionReport(report);
  validatePublicManifest(manifest);
  return { manifest, report };
}
