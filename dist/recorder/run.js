import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { admitDeclarations, storeGeneratedJson, } from "./admit.js";
import { buildChildEnv, loadRecorderConfig, parseRecorderArgv, } from "./config.js";
import { RECORDER_FAILURE_EXIT, RecorderError, serializePublicFailure, } from "./errors.js";
import { extractAcceptedReceipt } from "./extract.js";
import { buildManifest, validatePublicManifest } from "./manifest.js";
import { allocateIgnoredStageRoot, assertPathNotSymlinkEscape, assertSameFilesystem, assertScratchOutsideOrIgnored, resolveInsideRoot, } from "./paths.js";
import { isOccupiedRenameError, renameNoReplace, } from "./rename-no-replace.js";
import { combineReports, publicRedactionReport, scanString, } from "./scanner.js";
import { spawnOnce } from "./spawn.js";
/** Fixed public bound for one child diagnostic derived from captured tee bytes. */
const CHILD_DIAGNOSTIC_BOUND = 4096;
function childOutcomeFromSpawn(spawn, diagnostic) {
    if (spawn.signal) {
        return {
            status: "signaled",
            exitCode: null,
            signal: spawn.signal,
            diagnostic,
        };
    }
    return {
        status: "exited",
        exitCode: spawn.exitCode ?? 1,
        signal: null,
        diagnostic,
    };
}
/**
 * One bounded diagnostic from already-captured child tee bytes.
 * Prefer stderr then stdout; scan before attach. Never mutates tee mirrors.
 */
function deriveChildDiagnostic(stdout, stderr) {
    const parts = [];
    if (stderr.length > 0)
        parts.push(stderr);
    if (stdout.length > 0)
        parts.push(stdout);
    if (parts.length === 0)
        return null;
    const joined = Buffer.concat(parts);
    const slice = joined.length > CHILD_DIAGNOSTIC_BOUND
        ? joined.subarray(joined.length - CHILD_DIAGNOSTIC_BOUND)
        : joined;
    const text = slice.toString("utf8");
    if (text.length === 0)
        return null;
    return scanString(text, "child.diagnostic").value;
}
/** Required raw cleanup — failure is Recorder infrastructure failure. */
function requiredRm(path) {
    try {
        rmSync(path, { recursive: true, force: false });
        if (existsSync(path)) {
            // force after non-force attempt for stubborn empty dirs
            rmSync(path, { recursive: true, force: true });
        }
        if (existsSync(path)) {
            throw new Error("path still exists after rm");
        }
    }
    catch (error) {
        throw new RecorderError("cleanup-failed", "required raw scratch cleanup failed", { cause: error });
    }
}
/** Best-effort failure cleanup only — never creates an apparently complete docket. */
function bestEffortRm(path) {
    if (!path)
        return;
    try {
        rmSync(path, { recursive: true, force: true });
    }
    catch {
        // best effort only
    }
}
function destinationPath(config) {
    return resolveInsideRoot(config.archive.repositoryRoot, `${config.archive.root}/${config.archive.docketId}`, "archive destination");
}
function captureGitState(repo) {
    try {
        const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
            encoding: "utf8",
        }).trim();
        const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf8" });
        return `${head}\n${status}`;
    }
    catch {
        return "";
    }
}
function destinationOccupied(dest) {
    try {
        lstatSync(dest);
        return true;
    }
    catch (error) {
        const code = typeof error === "object" &&
            error !== null &&
            "code" in error &&
            typeof error.code === "string"
            ? error.code
            : null;
        if (code === "ENOENT")
            return false;
        // Unreadable destination name is treated as occupied/unsafe.
        return true;
    }
}
/**
 * Create-if-absent publication on one filesystem.
 *
 * The complete staged docket is published at the final name by one same-
 * filesystem kernel-atomic no-replace rename. Before that operation the final
 * identity is absent; afterward it is the complete staged tree. A collision
 * loses without altering the pre-existing destination or the private stage
 * (caller cleans only the private stage).
 */
function promoteStageAtomically(stageRoot, dest, repositoryRoot) {
    const parent = dirname(dest);
    mkdirSync(parent, { recursive: true });
    assertPathNotSymlinkEscape(parent, repositoryRoot, "archive destination parent");
    assertPathNotSymlinkEscape(dest, repositoryRoot, "archive destination");
    assertSameFilesystem(stageRoot, parent, "publication stage and destination");
    // Immediate pre-publication revalidation of containment and device identity.
    assertPathNotSymlinkEscape(parent, repositoryRoot, "archive destination parent");
    assertSameFilesystem(stageRoot, parent, "publication stage and destination");
    try {
        renameNoReplace(stageRoot, dest);
    }
    catch (error) {
        if (error instanceof RecorderError)
            throw error;
        // Occupied final name (file/dir/symlink/empty dir) — never mutate it.
        if (isOccupiedRenameError(error) || destinationOccupied(dest)) {
            throw new RecorderError("destination-exists", "archive destination already exists");
        }
        throw new RecorderError("promotion-failed", "atomic promotion failed", {
            cause: error,
        });
    }
}
export async function runRecorder(options) {
    const env = options.env ?? process.env;
    const stdout = options.stdout ?? process.stdout;
    const stderr = options.stderr ?? process.stderr;
    let child = {
        status: "not-spawned",
        exitCode: null,
        signal: null,
        diagnostic: null,
    };
    let scratchRoot = null;
    let stageRoot = null;
    let requiredCleanupDone = false;
    const fail = (error) => {
        // Best-effort cleanup only after the required raw-cleanup decision point.
        // Before that decision, still attempt best-effort so we leave no complete docket.
        if (!requiredCleanupDone) {
            bestEffortRm(scratchRoot);
            scratchRoot = null;
        }
        bestEffortRm(stageRoot);
        stageRoot = null;
        const diagnostic = child.diagnostic === null
            ? null
            : scanString(child.diagnostic, "child.diagnostic").value;
        const publicChild = {
            ...child,
            diagnostic,
        };
        const line = serializePublicFailure(error, publicChild);
        // Ensure the failure object itself is scanned (fixed literals + scanned diagnostic).
        const scannedLine = scanString(line.trim(), "failure").value;
        const out = `${scannedLine}\n`;
        stderr.write(out);
        return {
            exitCode: RECORDER_FAILURE_EXIT,
            signal: null,
            failureJson: out.trim(),
        };
    };
    try {
        const parsed = parseRecorderArgv(options.argv);
        const config = loadRecorderConfig(parsed.configPath);
        const dest = destinationPath(config);
        assertPathNotSymlinkEscape(dest, config.archive.repositoryRoot, "archive destination");
        if (destinationOccupied(dest)) {
            return fail(new RecorderError("destination-exists", "archive destination already exists"));
        }
        void captureGitState(config.archive.repositoryRoot);
        // Raw tee scratch stays outside the worktree (or ignored). Publication stage
        // lives under the archive's ignored `.ak/work` so promotion stays same-FS.
        const scratch = mkdtempSync(join(tmpdir(), "ak-docket-record-scratch-"));
        scratchRoot = scratch;
        assertScratchOutsideOrIgnored(scratch, config.archive.repositoryRoot);
        let stage;
        try {
            stage = allocateIgnoredStageRoot(config.archive.repositoryRoot);
        }
        catch (error) {
            if (error instanceof RecorderError)
                return fail(error);
            return fail(new RecorderError("invalid-path", "failed to allocate publication stage", {
                cause: error,
            }));
        }
        stageRoot = stage;
        const destParent = dirname(dest);
        mkdirSync(destParent, { recursive: true });
        assertPathNotSymlinkEscape(destParent, config.archive.repositoryRoot, "archive destination parent");
        assertSameFilesystem(stage, destParent, "publication stage and destination");
        const stdoutPath = join(scratch, "stdout.bin");
        const stderrPath = join(scratch, "stderr.bin");
        // Declaration admission is fail-closed before any child spawn.
        let admitted;
        try {
            admitted = admitDeclarations(config, stage);
        }
        catch (error) {
            if (error instanceof RecorderError) {
                return fail(error);
            }
            return fail(new RecorderError("admission-failed", "admission failed", {
                cause: error,
            }));
        }
        const childEnv = buildChildEnv(env, config.execution.environment);
        let spawnResult;
        try {
            spawnResult = await spawnOnce({
                argv: parsed.childArgv,
                cwd: config.execution.cwd,
                env: childEnv,
                stdoutPath,
                stderrPath,
                stdin: "inherit",
                stdoutMirror: stdout,
                stderrMirror: stderr,
            });
        }
        catch (error) {
            if (error instanceof RecorderError)
                return fail(error);
            return fail(new RecorderError("spawn-failed", "failed to spawn child process", {
                cause: error,
            }));
        }
        const stdoutText = readFileSync(stdoutPath);
        const stderrText = readFileSync(stderrPath);
        // Child tee is byte-exact and caller-owned; scanning of tee content is for
        // promotion metadata only and must NOT mutate/suppress the already-teed streams.
        const stdoutScan = scanString(stdoutText.toString("utf8"), "child.stdout");
        const stderrScan = scanString(stderrText.toString("utf8"), "child.stderr");
        // Public failure path may expose one bounded, already-scanned diagnostic
        // derived from the same captured bytes — never from live stream mutation.
        child = childOutcomeFromSpawn(spawnResult, deriveChildDiagnostic(stdoutText, stderrText));
        let extraction;
        try {
            extraction = extractAcceptedReceipt([
                stdoutText.toString("utf8"),
                stderrText.toString("utf8"),
            ]);
        }
        catch (error) {
            if (error instanceof RecorderError)
                return fail(error);
            return fail(new RecorderError("extraction-failed", "receipt extraction failed", {
                cause: error,
            }));
        }
        const artifacts = [...admitted.artifacts];
        const reports = [
            admitted.report,
            extraction.report,
            stdoutScan.report,
            stderrScan.report,
        ];
        if (extraction.receipt !== null) {
            const stored = storeGeneratedJson(stage, "receipt.json", {
                toolName: extraction.receipt.toolName,
                toolCallId: extraction.receipt.toolCallId,
                details: extraction.receipt.details,
                artifactKind: extraction.artifactKind,
            }, "receipt");
            artifacts.push({
                id: "receipt",
                kind: "receipt",
                redactionStatus: extraction.artifactKind === "sanitizedDerivativeOfAcceptedReceipt"
                    ? "sanitized-derivative"
                    : stored.report.redacted
                        ? "redacted"
                        : "clean",
                stored: stored.stored,
            });
            reports.push(stored.report);
        }
        if (extraction.auditObservation !== null) {
            const stored = storeGeneratedJson(stage, "audit-observation.json", extraction.auditObservation, "auditObservation");
            artifacts.push({
                id: "audit-observation",
                kind: "audit-observation",
                redactionStatus: stored.report.redacted ? "redacted" : "clean",
                stored: stored.stored,
            });
            reports.push(stored.report);
        }
        const combined = combineReports(...reports);
        let manifestBuild;
        try {
            manifestBuild = buildManifest({
                config,
                childArgv: parsed.childArgv,
                artifacts,
                extraction,
                child,
                scanReport: combined,
            });
        }
        catch (error) {
            if (error instanceof RecorderError)
                return fail(error);
            return fail(new RecorderError("admission-failed", "manifest build failed", {
                cause: error,
            }));
        }
        // Persist the already-closed final scan result. Do not recombine or rescan
        // in a way that can diverge manifest hits from redaction-report hits.
        const finalHits = publicRedactionReport(manifestBuild.report);
        manifestBuild.manifest.redaction.hits = finalHits;
        try {
            validatePublicManifest(manifestBuild.manifest);
        }
        catch (error) {
            if (error instanceof RecorderError)
                return fail(error);
            return fail(new RecorderError("admission-failed", "manifest schema validation failed", {
                cause: error,
            }));
        }
        const manifestStored = storeGeneratedJson(stage, "manifest.json", manifestBuild.manifest, "manifest");
        // Writing must not discover additional redactions; the pre-persist closure
        // is the sole hit source for both manifest and optional report.
        if (manifestStored.report.redacted) {
            return fail(new RecorderError("admission-failed", "manifest write-time scan diverged from final closure"));
        }
        if (finalHits.length > 0) {
            const reportStored = storeGeneratedJson(stage, "redaction-report.json", { hits: finalHits }, "redaction-report");
            if (reportStored.report.redacted) {
                return fail(new RecorderError("admission-failed", "redaction report write-time scan diverged from final closure"));
            }
        }
        // Required raw scratch cleanup BEFORE promotion.
        try {
            requiredRm(scratch);
            scratchRoot = null;
            requiredCleanupDone = true;
        }
        catch (error) {
            if (error instanceof RecorderError)
                return fail(error);
            return fail(new RecorderError("cleanup-failed", "raw scratch cleanup failed", {
                cause: error,
            }));
        }
        // One-tree atomic no-replace publication (stage ownership transfers on success).
        try {
            promoteStageAtomically(stage, dest, config.archive.repositoryRoot);
            stageRoot = null;
        }
        catch (error) {
            if (error instanceof RecorderError)
                return fail(error);
            return fail(new RecorderError("promotion-failed", "atomic promotion failed", {
                cause: error,
            }));
        }
        // Success: preserve exact child exit/signal. No Recorder diagnostic.
        if (child.status === "signaled" && child.signal) {
            return {
                exitCode: 0,
                signal: child.signal,
                failureJson: null,
            };
        }
        return {
            exitCode: child.exitCode ?? 0,
            signal: null,
            failureJson: null,
        };
    }
    catch (error) {
        if (error instanceof RecorderError)
            return fail(error);
        return fail(new RecorderError("invalid-config", "recorder failed", { cause: error }));
    }
}
function reRaiseSignal(signal) {
    try {
        process.removeAllListeners(signal);
    }
    catch {
        // ignore
    }
    try {
        process.kill(process.pid, signal);
    }
    catch {
        process.exit(RECORDER_FAILURE_EXIT);
    }
}
export async function main(argv = process.argv.slice(2)) {
    const result = await runRecorder({ argv });
    if (result.signal) {
        reRaiseSignal(result.signal);
        // Keep alive until signal is delivered.
        await new Promise(() => { });
        return;
    }
    process.exit(result.exitCode);
}
