import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { admitDeclarations, storeGeneratedJson, } from "./admit.js";
import { buildChildEnv, parseRecorderArgv, parseRecorderConfigStructure, readRecorderConfig, scanRecorderConfigMetadata, validateRecorderConfigState, } from "./config.js";
import { RECORDER_FAILURE_EXIT, RecorderError, internalRecorderError, safeDiagnostic, serializePublicFailure, } from "./errors.js";
import { AcceptanceCollector } from "./extract.js";
import { buildManifest, validatePublicManifest } from "./manifest.js";
import { allocateIgnoredStageRoot, assertPathNotSymlinkEscape, assertSameFilesystem, resolveInsideRoot, } from "./paths.js";
import { isOccupiedRenameError, renameNoReplace } from "./rename-no-replace.js";
import { combineReports, publicRedactionReport, scanString, } from "./scanner.js";
import { createSessionLeaf, readSession } from "./session.js";
import { spawnOnce } from "./spawn.js";
const cleanup = (p) => {
    if (p)
        try {
            rmSync(p, { recursive: true, force: true });
        }
        catch { }
};
function destination(c) {
    return resolveInsideRoot(c.archive.repositoryRoot, `${c.archive.root}/${c.archive.docketId}`, "archive destination");
}
function occupied(p) {
    try {
        lstatSync(p);
        return true;
    }
    catch (e) {
        if (e.code === "ENOENT")
            return false;
        throw e;
    }
}
function promote(stage, dest, root) {
    const parent = dirname(dest);
    mkdirSync(parent, { recursive: true });
    assertPathNotSymlinkEscape(parent, root, "archive destination parent");
    assertSameFilesystem(stage, parent, "publication");
    try {
        renameNoReplace(stage, dest);
    }
    catch (e) {
        if (e instanceof RecorderError)
            throw e;
        if (isOccupiedRenameError(e) || occupied(dest))
            throw new RecorderError("destination-exists", undefined, { cause: e });
        throw new RecorderError("promotion-failed", undefined, { cause: e });
    }
}
function outcome(s, diagnostic) {
    return s.signal
        ? { status: "signaled", exitCode: null, signal: s.signal, diagnostic }
        : { status: "exited", exitCode: s.exitCode ?? 1, signal: null, diagnostic };
}
export async function runRecorder(options) {
    const stderr = options.stderr ?? process.stderr;
    let child = {
        status: "not-spawned",
        exitCode: null,
        signal: null,
        diagnostic: null,
    }, stage = null, current = "argv";
    const fail = (e) => {
        cleanup(stage);
        const err = e.diagnostic || e.cause === undefined
            ? e
            : new RecorderError(e.code, undefined, {
                cause: e.cause,
                location: e.location,
                diagnostic: safeDiagnostic(current, e.cause),
            });
        const line = serializePublicFailure(err, child);
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
        const config = validateRecorderConfigState(scanRecorderConfigMetadata(parseRecorderConfigStructure(readRecorderConfig(parsed.configPath))));
        const dest = destination(config);
        if (occupied(dest))
            return fail(new RecorderError("destination-exists"));
        current = "stage-allocation";
        stage = allocateIgnoredStageRoot(config.archive.repositoryRoot);
        assertSameFilesystem(stage, config.archive.repositoryRoot, "publication");
        current = "admission";
        const admitted = admitDeclarations(config, stage);
        current = "session";
        const owner = createSessionLeaf(config);
        const effectiveArgv = [
            parsed.childArgv[0],
            "--session-dir",
            resolveInsideRoot(config.archive.repositoryRoot, config.session.directory, "session.directory"),
            "--session-id",
            config.session.id,
            ...parsed.childArgv.slice(1),
        ];
        current = "spawn";
        const execution = await spawnOnce({
            argv: effectiveArgv,
            cwd: config.execution.cwd,
            env: buildChildEnv(options.env ?? process.env, config.execution.environment),
            stdin: "inherit",
            stdoutMirror: options.stdout ?? process.stdout,
            stderrMirror: stderr,
        });
        const settled = await execution.settlement;
        child = outcome(settled, null);
        try {
            await execution.streamCompletion;
        }
        catch (e) {
            return fail(internalRecorderError(current, e));
        }
        const tail = execution.stderrTail.bytes().length
            ? execution.stderrTail.bytes()
            : execution.stdoutTail.bytes();
        child = outcome(settled, tail.length
            ? scanString(tail.toString("utf8"), "child.diagnostic").value
            : null);
        current = "extraction";
        const lifecycle = new AcceptanceCollector();
        const session = readSession(config, owner, (row, index) => lifecycle.accept(row, index));
        const extraction = lifecycle.finish(session.rowCount);
        const artifacts = [...admitted.artifacts];
        const reports = [admitted.report, extraction.report];
        const receiptStored = storeGeneratedJson(stage, "receipt.json", {
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
                : receiptStored.report.redacted
                    ? "redacted"
                    : "clean",
            stored: receiptStored.stored,
        });
        reports.push(receiptStored.report);
        if (extraction.auditObservation) {
            const s = storeGeneratedJson(stage, "audit-observation.json", extraction.auditObservation, "auditObservation");
            artifacts.push({
                id: "audit-observation",
                kind: "audit-observation",
                redactionStatus: s.report.redacted ? "redacted" : "clean",
                stored: s.stored,
            });
            reports.push(s.report);
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
                signal: child.signal,
                failureJson: null,
            }
            : { exitCode: child.exitCode ?? 1, signal: null, failureJson: null };
    }
    catch (e) {
        return fail(e instanceof RecorderError ? e : internalRecorderError(current, e));
    }
}
function reRaiseSignal(s) {
    process.removeAllListeners(s);
    try {
        process.kill(process.pid, s);
    }
    catch {
        process.exit(RECORDER_FAILURE_EXIT);
    }
}
export async function main(argv = process.argv.slice(2)) {
    const r = await runRecorder({ argv });
    if (r.signal) {
        reRaiseSignal(r.signal);
        await new Promise(() => { });
    }
    else
        process.exit(r.exitCode);
}
