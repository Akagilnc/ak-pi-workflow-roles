import { readFileSync } from "node:fs";

import { Check, Errors } from "typebox/value";

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
  artifacts: Array<AdmittedArtifact & {
    receiptArtifactKind?: "acceptedReceipt" | "sanitizedDerivativeOfAcceptedReceipt";
  }>;
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

const publicManifestSchema: object = JSON.parse(
  readFileSync(new URL("../../schemas/recorder-manifest-v2.schema.json", import.meta.url), "utf8"),
) as object;

export function loadPublicManifestSchema(): object {
  return publicManifestSchema;
}

export function validatePublicManifest(
  value: unknown,
): asserts value is RecorderManifestV2 {
  if (!Check(publicManifestSchema, value)) {
    const first = Errors(publicManifestSchema, value)[0];
    throw internalRecorderError(
      "manifest",
      new Error(`manifest schema${first ? ` at ${first.instancePath || "/"}: ${first.message}` : ""}`),
    );
  }
  const manifest = value as RecorderManifestV2;
  const receipt = manifest.artifacts.find((artifact) => artifact.id === "receipt");
  if (
    manifest.invocation.id !== manifest.session.id ||
    receipt?.receiptArtifactKind !== manifest.receipt.artifactKind
  ) {
    throw internalRecorderError("manifest", new Error("manifest semantic join"));
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
  const manifest = scanned.value as RecorderManifestV2;
  manifest.redaction.hits = publicRedactionReport(report);
  validatePublicManifest(manifest);
  return { manifest, report };
}
