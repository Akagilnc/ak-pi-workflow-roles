/**
 * Engine-generic one-shot subprocess detour (#357 T2 / ADR 0069).
 * Spawn once; no retry, hang surface, or per-engine branch.
 * Material body is LLM data — this module only executes argv the model assembled.
 */
import { spawn } from "node:child_process";
/** Package-owned detour tool name (settlement whitelist + session principal). */
export const ENGINE_DETOUR_TOOL_NAME = "ak_engine_detour";
/** Env presence/name signal injected by public Judge run (registration gate only). */
export const AK_ROLE_ENGINE_ENV = "AK_ROLE_ENGINE";
export const ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC = "engine detour produced empty stdout";
export const ENGINE_DETOUR_ALREADY_USED_DIAGNOSTIC = "engine detour already used in this activation";
/**
 * Run one engine subprocess. First argv element is the executable (PATH lookup).
 * stdio: ignore stdin, pipe stdout+stderr. No shell, no retry, no hang timer.
 */
export async function runEngineDetourOnce(input) {
    if (input.argv.length === 0) {
        throw new Error("engine detour argv must be non-empty");
    }
    const command = input.argv[0];
    const args = input.argv.slice(1);
    return await new Promise((resolve, reject) => {
        let settled = false;
        const child = spawn(command, args, {
            cwd: input.cwd,
            env: input.env ?? process.env,
            stdio: ["ignore", "pipe", "pipe"],
            ...(input.signal === undefined ? {} : { signal: input.signal }),
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
            reject(error instanceof Error ? error : new Error(String(error)));
        };
        child.on("error", (error) => fail(error));
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            resolve({ code: code ?? 1, stdout, stderr });
        });
    });
}
/** Failure predicate: nonzero exit OR stdout trim-empty (including whitespace-only). */
export function isEngineDetourFailure(result) {
    return result.code !== 0 || result.stdout.trim() === "";
}
/**
 * Diagnostic string for shared settlement / Terminal Error Artifact.
 * Prefer engine stderr 原样; whitespace-only/empty stderr is absent → stable fallback.
 */
export function engineDetourFailureDiagnostic(result) {
    if (result.stderr.trim().length > 0)
        return result.stderr;
    if (result.stdout.trim() === "")
        return ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC;
    return `engine detour exited with code ${result.code}`;
}
/** Non-empty trimmed engine name from process.env, else undefined. */
export function engineNameFromEnv() {
    const raw = process.env[AK_ROLE_ENGINE_ENV];
    if (typeof raw !== "string")
        return undefined;
    const trimmed = raw.trim();
    return trimmed === "" ? undefined : trimmed;
}
