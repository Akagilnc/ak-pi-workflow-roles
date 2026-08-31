/**
 * Engine-generic one-shot subprocess detour (#357 T2 / ADR 0069).
 * Spawn once; no retry, hang surface, or per-engine branch.
 * Material body is LLM data — this module only executes argv the model assembled.
 * Large prompt bodies stage through a seam-owned temp file (never argv) so
 * collectors avoid spawn E2BIG / ENAMETOOLONG (engine-dispatch / #582).
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
/** Package-owned detour tool name (settlement whitelist + session principal). */
export const ENGINE_DETOUR_TOOL_NAME = "ak_engine_detour";
/** Env presence/name signal injected by public role runs (registration gate only). */
export const AK_ROLE_ENGINE_ENV = "AK_ROLE_ENGINE";
/**
 * Argv placeholder replaced by a seam-owned temp prompt file path when
 * `stagedPrompt` is set. Exactly one argv entry must equal this token.
 */
export const ENGINE_DETOUR_STAGED_PROMPT_TOKEN = "<<ak-engine-staged-prompt>>";
/**
 * Sole AK_ROLE_ENGINE write seam for public role child env (#391 E2).
 * Delete ambient inheritance first; own-key undefined mask survives process.env re-merge.
 */
export function applyEngineChildEnv(childEnv, engine) {
    delete childEnv[AK_ROLE_ENGINE_ENV];
    if (engine !== undefined && engine.trim() !== "") {
        childEnv[AK_ROLE_ENGINE_ENV] = engine.trim();
    }
    else {
        childEnv[AK_ROLE_ENGINE_ENV] = undefined;
    }
}
export const ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC = "劳务引擎 stdout 为空";
export const ENGINE_DETOUR_ALREADY_USED_DIAGNOSTIC = "本激活内劳务引擎已使用";
function abortReasonError(signal) {
    const reason = signal.reason;
    if (reason instanceof Error)
        return reason;
    if (typeof reason === "string" && reason.trim() !== "") {
        return new Error(reason);
    }
    const error = new Error("aborted");
    error.name = "AbortError";
    return error;
}
function resolveArgvWithStagedPrompt(argv, stagedPath) {
    let replaced = 0;
    const out = argv.map((part) => {
        if (part !== ENGINE_DETOUR_STAGED_PROMPT_TOKEN)
            return part;
        replaced += 1;
        return stagedPath;
    });
    if (replaced !== 1) {
        throw new Error(`劳务引擎 stagedPrompt 需要 argv 中恰好一个 ${ENGINE_DETOUR_STAGED_PROMPT_TOKEN}（实际 ${replaced}）`);
    }
    return out;
}
async function spawnEngineDetourOnce(input) {
    if (input.argv.length === 0) {
        throw new Error("劳务引擎 argv 不得为空");
    }
    const command = input.argv[0];
    const args = input.argv.slice(1);
    return await new Promise((resolve, reject) => {
        let settled = false;
        const signal = input.signal;
        // Own abort→kill explicitly so rejection preserves signal.reason (caller cancel).
        // Do not pass `signal` to spawn (Node replaces reason).
        const child = spawn(command, args, {
            cwd: input.cwd,
            env: input.env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
            stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
            stderr += chunk;
        });
        const fail = (error) => {
            if (settled)
                return;
            settled = true;
            if (signal !== undefined) {
                signal.removeEventListener("abort", onAbort);
            }
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        const succeed = (result) => {
            if (settled)
                return;
            settled = true;
            if (signal !== undefined) {
                signal.removeEventListener("abort", onAbort);
            }
            resolve(result);
        };
        const onAbort = () => {
            // Fail synchronously so caller-cancel soft-settle preserves signal.reason.
            fail(signal !== undefined ? abortReasonError(signal) : new Error("aborted"));
            try {
                child.kill("SIGTERM");
            }
            catch {
                // already exited
            }
        };
        if (signal !== undefined) {
            if (signal.aborted) {
                onAbort();
            }
            else {
                signal.addEventListener("abort", onAbort, { once: true });
            }
        }
        child.on("error", (error) => fail(error));
        child.on("close", (code) => {
            succeed({ code: code ?? 1, stdout, stderr });
        });
    });
}
/**
 * Run one engine subprocess. First argv element is the executable (PATH lookup).
 * stdio: ignore stdin, pipe stdout+stderr. No shell, no retry, no hang timer.
 * AbortSignal cancels the child immediately via an explicit listener (reason preserved).
 * Optional stagedPrompt: seam owns temp-file lifecycle for large bodies (ADR 0069).
 */
export async function runEngineDetourOnce(input) {
    if (input.stagedPrompt === undefined) {
        return spawnEngineDetourOnce(input);
    }
    const stagingDir = await mkdtemp(join(tmpdir(), "ak-engine-detour-"));
    const stagedPath = join(stagingDir, "prompt.txt");
    let result;
    let runError;
    try {
        await writeFile(stagedPath, input.stagedPrompt, "utf8");
        const argv = resolveArgvWithStagedPrompt(input.argv, stagedPath);
        result = await spawnEngineDetourOnce({
            argv,
            cwd: input.cwd,
            ...(input.env === undefined ? {} : { env: input.env }),
            ...(input.signal === undefined ? {} : { signal: input.signal }),
        });
    }
    catch (error) {
        runError = error;
    }
    // Cleanup is seam-owned and fail-closed: never wash rm failure into success
    // (失败诚实). force only covers already-absent nodes, not permission/IO faults.
    try {
        await rm(stagingDir, { recursive: true, force: true });
    }
    catch (cleanupError) {
        if (runError !== undefined) {
            throw new Error(`劳务引擎 stagedPrompt 清理失败（原运行错误保留为 cause）: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`, { cause: runError });
        }
        throw cleanupError instanceof Error
            ? cleanupError
            : new Error(String(cleanupError));
    }
    if (runError !== undefined) {
        throw runError instanceof Error ? runError : new Error(String(runError));
    }
    return result;
}
/** Failure predicate: nonzero exit OR stdout trim-empty (including whitespace-only). */
export function isEngineDetourFailure(result) {
    return result.code !== 0 || result.stdout.trim() === "";
}
/**
 * Diagnostic string for shared settlement / Terminal Error Artifact (#395).
 * Prefer engine stderr 原样; whitespace-only/empty stderr with stdout body must
 * carry the child's last result/error row verbatim (e.g. a 529 API Error row) —
 * never swallow the cause behind an exit code. Fully-empty output → stable fallback.
 */
export function engineDetourFailureDiagnostic(result) {
    if (result.stderr.trim().length > 0)
        return result.stderr;
    if (result.stdout.trim() === "")
        return ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC;
    const rows = result.stdout.split("\n");
    let lastRow = "";
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        if (rows[index].trim() !== "") {
            lastRow = rows[index];
            break;
        }
    }
    return `劳务引擎以 code ${result.code} 退出：${lastRow}`;
}
/** Non-empty trimmed engine name from process.env, else undefined. */
export function engineNameFromEnv() {
    const raw = process.env[AK_ROLE_ENGINE_ENV];
    if (typeof raw !== "string")
        return undefined;
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
}
