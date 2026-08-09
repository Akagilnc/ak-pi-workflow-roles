import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdir, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
/** Read the typed identity transported by the public invocation envelope. */
export function machinePiRuntimeFromActivation(env = process.env) {
    const executableRealpath = env.AK_MACHINE_PI_EXECUTABLE_REALPATH;
    const version = env.AK_MACHINE_PI_VERSION;
    if (executableRealpath === undefined || !isAbsolute(executableRealpath) || version === undefined || version.length === 0) {
        throw new Error("machine Pi runtime identity is absent from the activation envelope");
    }
    return { executableRealpath, version };
}
async function executableFrom(env) {
    const selected = env.PI_BINARY;
    const explicitPath = selected !== undefined && (isAbsolute(selected) || selected.includes("/") || selected.includes("\\"));
    const candidates = selected !== undefined
        ? explicitPath ? [isAbsolute(selected) ? selected : resolve(selected)] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((part) => join(part, selected))
        : (env.PATH ?? "").split(delimiter).filter(Boolean).map((part) => join(part, "pi"));
    for (const candidate of candidates) {
        const packageLocal = candidate.split(sep).slice(-3).join("/") === "node_modules/.bin/pi";
        if (selected === undefined && packageLocal)
            continue;
        try {
            await access(candidate, constants.X_OK);
            return candidate;
        }
        catch { /* try the next PATH entry */ }
    }
    throw new Error(selected === undefined ? "machine Pi executable was not found on PATH" : `PI_BINARY is not executable: ${selected}`);
}
export async function resolveMachinePi(env = process.env) {
    const executableRealpath = await realpath(await executableFrom(env));
    const versionResult = spawnSync(executableRealpath, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
    if (versionResult.error !== undefined || versionResult.status !== 0)
        throw new Error(`machine Pi version probe failed: ${versionResult.stderr || versionResult.error}`);
    const version = versionResult.stdout.replace(/\r?\n$/, "");
    if (version.length === 0)
        throw new Error("machine Pi version probe returned no version");
    return { executableRealpath, version };
}
/** The single child settlement seam: wire I/O, parsing, abort, diagnostics, and close. */
export async function runMachinePiRpc(options) {
    const env = options.env ?? process.env;
    const runtime = options.runtime ?? await resolveMachinePi(env);
    await mkdir(options.sessionDir, { recursive: true });
    return await new Promise((resolveResult, reject) => {
        const child = spawn(runtime.executableRealpath, ["--mode", "rpc", "--session-dir", options.sessionDir, ...options.args], { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
        let stderr = "";
        let buffer = "";
        let response;
        let decision;
        let settled = false;
        let aborted = false;
        let spawned = false;
        let closed = false;
        let failure;
        const decoder = new StringDecoder("utf8");
        const fail = (cause) => { if (failure === undefined)
            failure = cause; if (!child.killed)
            child.kill("SIGTERM"); };
        const consume = (line) => {
            if (line.endsWith("\r"))
                line = line.slice(0, -1);
            if (line === "" || failure !== undefined)
                return;
            let event;
            try {
                event = JSON.parse(line);
            }
            catch (cause) {
                fail(new Error("machine Pi RPC emitted invalid JSONL", { cause }));
                return;
            }
            if (event.type === "response" && event.success === false) {
                fail(new Error(`machine Pi RPC command failed: ${String(event.error)}`));
                return;
            }
            if (event.type === "message_end" && typeof event.message === "object" && event.message !== null)
                response = event.message;
            if (event.type === "tool_execution_end" && event.toolName === options.decisionToolName) {
                // The terminating decision tool accepts the first submission. A stale
                // duplicate event can neither reopen the lifecycle nor overwrite it.
                if (decision !== undefined)
                    return;
                decision = event.result?.details;
            }
            if (event.type === "agent_settled") {
                settled = true;
                child.stdin.end();
            }
        };
        child.stdout.on("data", (chunk) => { buffer += decoder.write(chunk); for (;;) {
            const i = buffer.indexOf("\n");
            if (i < 0)
                break;
            consume(buffer.slice(0, i));
            buffer = buffer.slice(i + 1);
        } });
        child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        child.stdin.on("error", (cause) => fail(cause));
        const abortError = () => Object.assign(new Error("machine Pi RPC aborted by caller"), { name: "AbortError" });
        const abort = () => { aborted = true; if (spawned && !child.killed)
            child.kill("SIGTERM"); };
        if (options.signal?.aborted)
            abort();
        else
            options.signal?.addEventListener("abort", abort, { once: true });
        child.on("error", (cause) => { if (!closed) {
            closed = true;
            options.signal?.removeEventListener("abort", abort);
            reject(aborted ? abortError() : cause);
        } });
        child.on("close", async (code, signal) => {
            if (closed)
                return;
            closed = true;
            options.signal?.removeEventListener("abort", abort);
            buffer += decoder.end();
            if (buffer !== "")
                consume(buffer);
            try {
                if (stderr !== "")
                    await appendFile(join(options.sessionDir, "child-stderr.log"), stderr, "utf8");
            }
            catch (cause) {
                if (failure === undefined)
                    failure = cause;
            }
            if (aborted)
                return reject(abortError());
            if (failure !== undefined)
                return reject(failure);
            if (code !== 0)
                return reject(new Error(`machine Pi RPC terminated unsuccessfully (code ${code}, signal ${signal ?? "none"})${stderr === "" ? "" : `: ${stderr}`}`));
            if (!settled)
                return reject(new Error("machine Pi RPC exited without agent_settled"));
            resolveResult({ runtime, stderr, ...(decision === undefined ? {} : { decision }), ...(response === undefined ? {} : { response }), settled: true });
        });
        child.once("spawn", () => {
            spawned = true;
            if (aborted) {
                child.kill("SIGTERM");
                return;
            }
            for (const command of options.commands)
                child.stdin.write(`${JSON.stringify(command)}\n`);
        });
    });
}
