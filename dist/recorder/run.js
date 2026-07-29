import { execFileSync } from "node:child_process";
import { constants as fsConstants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, closeSync, } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { admitDeclarations, storeGeneratedJson, } from "./admit.js";
import { buildChildEnv, loadRecorderConfig, parseRecorderArgv, } from "./config.js";
import { RECORDER_FAILURE_EXIT, RecorderError, serializePublicFailure, } from "./errors.js";
import { extractAcceptedReceipt } from "./extract.js";
import { buildManifest } from "./manifest.js";
import { assertPathNotSymlinkEscape, assertScratchOutsideOrIgnored, resolveInsideRoot, } from "./paths.js";
import { combineReports, scanString, } from "./scanner.js";
import { spawnOnce } from "./spawn.js";
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
/**
 * Atomic create-if-absent rename robust to races and child-created collisions.
 * Uses O_EXCL directory create marker when available, then rename.
 */
function promoteStageAtomically(stageRoot, dest, repositoryRoot) {
    const parent = dirname(dest);
    mkdirSync(parent, { recursive: true });
    assertPathNotSymlinkEscape(parent, repositoryRoot, "archive destination parent");
    assertPathNotSymlinkEscape(dest, repositoryRoot, "archive destination");
    if (existsSync(dest)) {
        throw new RecorderError("destination-exists", "archive destination already exists");
    }
    // Race-robust: try exclusive create of the destination as empty dir, then
    // replace via rename from stage. If exclusive create fails, destination exists.
    let markerFd = null;
    const markerPath = `${dest}.__ak_promoter_marker__`;
    try {
        markerFd = openSync(markerPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
        closeSync(markerFd);
        markerFd = null;
        // Re-check dest after winning the marker race.
        if (existsSync(dest)) {
            throw new RecorderError("destination-exists", "archive destination already exists");
        }
        renameSync(stageRoot, dest);
    }
    catch (error) {
        if (error instanceof RecorderError)
            throw error;
        if (existsSync(dest)) {
            throw new RecorderError("destination-exists", "archive destination already exists");
        }
        throw new RecorderError("promotion-failed", "atomic promotion failed", { cause: error });
    }
    finally {
        try {
            if (markerFd !== null)
                closeSync(markerFd);
        }
        catch {
            // ignore
        }
        try {
            if (existsSync(markerPath))
                rmSync(markerPath, { force: true });
        }
        catch {
            // ignore
        }
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
        if (existsSync(dest)) {
            return fail(new RecorderError("destination-exists", "archive destination already exists"));
        }
        void captureGitState(config.archive.repositoryRoot);
        // Scratch/stage outside worktree (tmpdir) — prove outside-or-ignored.
        const scratch = mkdtempSync(join(tmpdir(), "ak-docket-record-scratch-"));
        const stage = mkdtempSync(join(tmpdir(), "ak-docket-record-stage-"));
        scratchRoot = scratch;
        stageRoot = stage;
        assertScratchOutsideOrIgnored(scratch, config.archive.repositoryRoot);
        assertScratchOutsideOrIgnored(stage, config.archive.repositoryRoot);
        const stdoutPath = join(scratch, "stdout.bin");
        const stderrPath = join(scratch, "stderr.bin");
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
        child = childOutcomeFromSpawn(spawnResult, null);
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
        // Final scan closure — manifest redaction hits must equal this complete set.
        const finalReport = combineReports(combined, manifestBuild.report);
        // Rebuild redaction hits from final closure so manifest/report cannot diverge.
        manifestBuild.manifest.redaction.hits = finalReport.hits.map((hit) => ({
            ruleId: hit.ruleId,
            location: hit.location,
            count: hit.count,
        }));
        storeGeneratedJson(stage, "manifest.json", manifestBuild.manifest, "manifest");
        if (manifestBuild.manifest.redaction.hits.length > 0) {
            storeGeneratedJson(stage, "redaction-report.json", { hits: manifestBuild.manifest.redaction.hits }, "redaction-report");
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
        // Atomic promotion with parent revalidation.
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
