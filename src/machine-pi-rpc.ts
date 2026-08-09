import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, appendFile, mkdir, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type MachinePiRuntimeIdentity = { readonly executableRealpath: string; readonly version: string };

/** Read the typed identity transported by the public invocation envelope. */
export function machinePiRuntimeFromActivation(env: NodeJS.ProcessEnv = process.env): MachinePiRuntimeIdentity {
  const executableRealpath = env.AK_MACHINE_PI_EXECUTABLE_REALPATH;
  const version = env.AK_MACHINE_PI_VERSION;
  if (executableRealpath === undefined || !isAbsolute(executableRealpath) || version === undefined || version.length === 0) {
    throw new Error("machine Pi runtime identity is absent from the activation envelope");
  }
  return { executableRealpath, version };
}

async function executableFrom(env: NodeJS.ProcessEnv): Promise<string> {
  const selected = env.PI_BINARY;
  const explicitPath = selected !== undefined && (isAbsolute(selected) || selected.includes("/") || selected.includes("\\"));
  const candidates = selected !== undefined
    ? explicitPath ? [isAbsolute(selected) ? selected : resolve(selected)] : (env.PATH ?? "").split(delimiter).filter(Boolean).map((part) => join(part, selected))
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((part) => join(part, "pi"));
  for (const candidate of candidates) {
    const packageLocal = candidate.split(sep).slice(-3).join("/") === "node_modules/.bin/pi";
    if (selected === undefined && packageLocal) continue;
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* try the next PATH entry */ }
  }
  throw new Error(selected === undefined ? "machine Pi executable was not found on PATH" : `PI_BINARY is not executable: ${selected}`);
}

export async function resolveMachinePi(env: NodeJS.ProcessEnv = process.env): Promise<MachinePiRuntimeIdentity> {
  const executableRealpath = await realpath(await executableFrom(env));
  const versionResult = spawnSync(executableRealpath, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
  if (versionResult.error !== undefined || versionResult.status !== 0) throw new Error(`machine Pi version probe failed: ${versionResult.stderr || versionResult.error}`);
  const version = versionResult.stdout.replace(/\r?\n$/, "");
  if (version.length === 0) throw new Error("machine Pi version probe returned no version");
  return { executableRealpath, version };
}

export type MachinePiRpcResult = {
  readonly runtime: MachinePiRuntimeIdentity;
  readonly stderr: string;
  readonly decision?: unknown;
  readonly response?: Record<string, unknown>;
  readonly settled: true;
};

type RpcOptions = { env?: NodeJS.ProcessEnv; runtime?: MachinePiRuntimeIdentity; cwd: string; sessionDir: string; args: readonly string[]; commands: readonly Record<string, unknown>[]; decisionToolName?: string; signal?: AbortSignal };

/** The single child settlement seam: wire I/O, parsing, abort, diagnostics, and close. */
export async function runMachinePiRpc(options: RpcOptions): Promise<MachinePiRpcResult> {
  const env = options.env ?? process.env;
  const runtime = options.runtime ?? await resolveMachinePi(env);
  await mkdir(options.sessionDir, { recursive: true });
  return await new Promise((resolveResult, reject) => {
    const child = spawn(runtime.executableRealpath, ["--mode", "rpc", "--session-dir", options.sessionDir, ...options.args], { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stderr = ""; let buffer = ""; let response: Record<string, unknown> | undefined; let decision: unknown; let settled = false; let aborted = false; let closed = false; let failure: unknown;
    const decoder = new StringDecoder("utf8");
    const fail = (cause: unknown) => { if (failure === undefined) failure = cause; if (!child.killed) child.kill("SIGTERM"); };
    const consume = (line: string) => {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "" || failure !== undefined) return;
      let event: Record<string, unknown>;
      try { event = JSON.parse(line) as Record<string, unknown>; } catch (cause) { fail(new Error("machine Pi RPC emitted invalid JSONL", { cause })); return; }
      if (event.type === "response" && event.success === false) { fail(new Error(`machine Pi RPC command failed: ${String(event.error)}`)); return; }
      if (event.type === "message_end" && typeof event.message === "object" && event.message !== null) response = event.message as Record<string, unknown>;
      if (event.type === "tool_execution_end" && event.toolName === options.decisionToolName) {
        // The terminating decision tool accepts the first submission. A stale
        // duplicate event can neither reopen the lifecycle nor overwrite it.
        if (decision !== undefined) return;
        decision = (event.result as { details?: unknown } | undefined)?.details;
      }
      if (event.type === "agent_settled") { settled = true; child.stdin.end(); }
    };
    child.stdout.on("data", (chunk: Buffer) => { buffer += decoder.write(chunk); for (;;) { const i = buffer.indexOf("\n"); if (i < 0) break; consume(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.stdin.on("error", (cause) => fail(cause));
    const abort = () => { aborted = true; child.kill("SIGTERM"); };
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (cause) => { if (!closed) { closed = true; options.signal?.removeEventListener("abort", abort); reject(cause); } });
    child.on("close", async (code, signal) => {
      if (closed) return; closed = true; options.signal?.removeEventListener("abort", abort);
      buffer += decoder.end(); if (buffer !== "") consume(buffer);
      try { if (stderr !== "") await appendFile(join(options.sessionDir, "child-stderr.log"), stderr, "utf8"); } catch (cause) { if (failure === undefined) failure = cause; }
      if (aborted) return reject(new Error("machine Pi RPC aborted after SIGTERM"));
      if (failure !== undefined) return reject(failure);
      if (code !== 0) return reject(new Error(`machine Pi RPC terminated unsuccessfully (code ${code}, signal ${signal ?? "none"})${stderr === "" ? "" : `: ${stderr}`}`));
      if (!settled) return reject(new Error("machine Pi RPC exited without agent_settled"));
      resolveResult({ runtime, stderr, ...(decision === undefined ? {} : { decision }), ...(response === undefined ? {} : { response }), settled: true });
    });
    child.once("spawn", () => { for (const command of options.commands) child.stdin.write(`${JSON.stringify(command)}\n`); });
  });
}
