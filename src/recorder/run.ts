import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  admitDeclarations,
  storeGeneratedJson,
  type AdmittedArtifact,
} from "./admit.ts";
import {
  buildChildEnv,
  parseRecorderArgv,
  parseRecorderConfigStructure,
  readRecorderConfig,
  scanRecorderConfigMetadata,
  validateRecorderConfigState,
} from "./config.ts";
import {
  RECORDER_FAILURE_EXIT,
  RecorderError,
  internalRecorderError,
  safeDiagnostic,
  serializePublicFailure,
  type ChildOutcome,
  type CleanupFailure,
  type RecorderStage,
} from "./errors.ts";
import { AcceptanceCollector } from "./extract.ts";
import { buildManifest, validatePublicManifest } from "./manifest.ts";
import {
  allocateIgnoredStageRoot,
  assertPathNotSymlinkEscape,
  assertSameFilesystem,
  resolveInsideRoot,
} from "./paths.ts";
import { isOccupiedRenameError, renameNoReplace } from "./rename-no-replace.ts";
import {
  combineReports,
  publicRedactionReport,
  scanString,
  type ScanReport,
} from "./scanner.ts";
import { createSessionLeaf, readSession } from "./session.ts";
import { spawnOnce } from "./spawn.ts";
export type RunResult = {
  exitCode: number;
  signal: NodeJS.Signals | null;
  failureJson: string | null;
};
const cleanup = (stagePath: string | null): CleanupFailure | null => {
  if (!stagePath) return null;
  try {
    rmSync(stagePath, { recursive: true, force: true });
    return null;
  } catch (cause) {
    return { status: "failed", category: safeDiagnostic("launcher", cause).category };
  }
};
function destination(config: {
  archive: { repositoryRoot: string; root: string; docketId: string };
}) {
  return resolveInsideRoot(
    config.archive.repositoryRoot,
    `${config.archive.root}/${config.archive.docketId}`,
    "archive destination",
  );
}
function occupied(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}
function promote(stage: string, dest: string, root: string) {
  const parent = dirname(dest);
  mkdirSync(parent, { recursive: true });
  assertPathNotSymlinkEscape(parent, root, "archive destination parent");
  assertSameFilesystem(stage, parent, "publication");
  try {
    renameNoReplace(stage, dest);
  } catch (cause) {
    if (cause instanceof RecorderError) throw cause;
    if (isOccupiedRenameError(cause) || occupied(dest))
      throw new RecorderError("destination-exists", undefined, { cause });
    throw new RecorderError("promotion-failed", undefined, { cause });
  }
}
function outcome(
  settlement: { exitCode: number | null; signal: NodeJS.Signals | null },
  diagnostic: string | null,
): ChildOutcome {
  return settlement.signal
    ? { status: "signaled", exitCode: null, signal: settlement.signal, diagnostic }
    : { status: "exited", exitCode: settlement.exitCode ?? 1, signal: null, diagnostic };
}
export async function runRecorder(options: {
  argv: string[];
  env?: NodeJS.ProcessEnv;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
}): Promise<RunResult> {
  const stderr = options.stderr ?? process.stderr;
  let child: ChildOutcome = {
      status: "not-spawned",
      exitCode: null,
      signal: null,
      diagnostic: null,
    },
    stage: string | null = null,
    current: RecorderStage = "argv";
  const fail = (primaryError: RecorderError): RunResult => {
    const cleanupFailure = cleanup(stage);
    const publicError =
      primaryError.diagnostic || primaryError.cause === undefined
        ? primaryError
        : new RecorderError(primaryError.code, undefined, {
            cause: primaryError.cause,
            location: primaryError.location,
            diagnostic: safeDiagnostic(current, primaryError.cause),
          });
    const line = serializePublicFailure(publicError, child, cleanupFailure);
    stderr.write(line);
    return {
      exitCode: RECORDER_FAILURE_EXIT,
      signal: null,
      failureJson: line.trim(),
    };
  };
  try {
    const parsed = parseRecorderArgv(options.argv);
    current = "config-read";
    const config = validateRecorderConfigState(
      scanRecorderConfigMetadata(
        parseRecorderConfigStructure(readRecorderConfig(parsed.configPath)),
      ),
    );
    const dest = destination(config);
    if (occupied(dest)) return fail(new RecorderError("destination-exists"));
    current = "stage-allocation";
    stage = allocateIgnoredStageRoot(config.archive.repositoryRoot);
    assertSameFilesystem(stage, config.archive.repositoryRoot, "publication");
    current = "admission";
    const admitted = admitDeclarations(config, stage);
    current = "session";
    const owner = createSessionLeaf(config);
    const effectiveArgv = [
      parsed.childArgv[0]!,
      "--session-dir",
      resolveInsideRoot(
        config.archive.repositoryRoot,
        config.session.directory,
        "session.directory",
      ),
      "--session-id",
      config.session.id,
      ...parsed.childArgv.slice(1),
    ];
    current = "spawn";
    const execution = await spawnOnce({
      argv: effectiveArgv,
      cwd: config.execution.cwd,
      env: buildChildEnv(
        options.env ?? process.env,
        config.execution.environment,
      ),
      stdin: "inherit",
      stdoutMirror: options.stdout ?? process.stdout,
      stderrMirror: stderr,
    });
    const settled = await execution.settlement;
    child = outcome(settled, null);
    try {
      await execution.streamCompletion;
    } catch (streamCause) {
      return fail(internalRecorderError(current, streamCause));
    }
    const tail = execution.stderrTail.bytes().length
      ? execution.stderrTail.bytes()
      : execution.stdoutTail.bytes();
    child = outcome(
      settled,
      tail.length
        ? scanString(tail.toString("utf8"), "child.diagnostic").value
        : null,
    );
    current = "extraction";
    const lifecycle = new AcceptanceCollector();
    const session = readSession(config, owner, (row, index) =>
      lifecycle.accept(row, index),
    );
    const extraction = lifecycle.finish(session.rowCount);
    const artifacts: AdmittedArtifact[] = [...admitted.artifacts];
    const reports: ScanReport[] = [admitted.report, extraction.report];
    const receiptStored = storeGeneratedJson(
      stage,
      "receipt.json",
      {
        toolName: extraction.receipt.toolName,
        toolCallId: extraction.receipt.toolCallId,
        details: extraction.receipt.details,
        artifactKind: extraction.artifactKind,
      },
      "receipt",
    );
    artifacts.push({
      id: "receipt",
      kind: "receipt",
      redactionStatus:
        extraction.artifactKind === "sanitizedDerivativeOfAcceptedReceipt"
          ? "sanitized-derivative"
          : receiptStored.report.redacted
            ? "redacted"
            : "clean",
      stored: receiptStored.stored,
    });
    reports.push(receiptStored.report);
    if (extraction.auditObservation) {
      const auditStored = storeGeneratedJson(
        stage,
        "audit-observation.json",
        extraction.auditObservation,
        "auditObservation",
      );
      artifacts.push({
        id: "audit-observation",
        kind: "audit-observation",
        redactionStatus: auditStored.report.redacted ? "redacted" : "clean",
        stored: auditStored.stored,
      });
      reports.push(auditStored.report);
    }
    current = "manifest";
    const built = buildManifest({
      config,
      childArgv: effectiveArgv,
      artifacts,
      extraction,
      child,
      scanReport: combineReports(...reports),
      session: {
        id: config.session.id,
        directory: config.session.directory,
        basename: session.basename,
        sha256: session.sha256,
        byteLength: session.byteLength,
      },
    });
    built.manifest.redaction.hits = publicRedactionReport(built.report);
    validatePublicManifest(built.manifest);
    storeGeneratedJson(stage, "manifest.json", built.manifest, "manifest");
    session.verify();
    current = "promotion";
    promote(stage, dest, config.archive.repositoryRoot);
    stage = null;
    return child.status === "signaled"
      ? {
          exitCode: 0,
          signal: child.signal as NodeJS.Signals,
          failureJson: null,
        }
      : { exitCode: child.exitCode ?? 1, signal: null, failureJson: null };
  } catch (primaryCause) {
    return fail(
      primaryCause instanceof RecorderError
        ? primaryCause
        : internalRecorderError(current, primaryCause),
    );
  }
}
function reRaiseSignal(signal: NodeJS.Signals) {
  process.removeAllListeners(signal);
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(RECORDER_FAILURE_EXIT);
  }
}
export async function main(argv = process.argv.slice(2)) {
  const result = await runRecorder({ argv });
  if (result.signal) {
    reRaiseSignal(result.signal);
    await new Promise(() => {});
  } else process.exit(result.exitCode);
}
