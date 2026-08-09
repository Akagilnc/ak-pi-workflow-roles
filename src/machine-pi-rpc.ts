import { spawn, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdir, realpath } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";

export type MachinePiRuntimeIdentity = { readonly executableRealpath: string; readonly version: string };
const resolutions = new Map<string, Promise<MachinePiRuntimeIdentity>>();

async function executableFrom(env: NodeJS.ProcessEnv): Promise<string> {
  const selected = env.PI_BINARY;
  const candidates = selected !== undefined
    ? [isAbsolute(selected) ? selected : resolve(selected)]
    : (env.PATH ?? "").split(delimiter).filter(Boolean).map((part) => join(part, "pi"));
  for (const candidate of candidates) {
    if (candidate.includes("/node_modules/.bin/") || candidate.endsWith("/node_modules/.bin/pi")) {
      if (selected !== undefined) throw new Error("package-local .bin/pi is not a machine Pi authority");
      continue;
    }
    try { await access(candidate, constants.X_OK); return candidate; } catch { /* try next PATH entry */ }
  }
  throw new Error(selected === undefined ? "machine Pi executable was not found on PATH" : `PI_BINARY is not executable: ${selected}`);
}

export function resolveMachinePi(env: NodeJS.ProcessEnv = process.env): Promise<MachinePiRuntimeIdentity> {
  const key = `${env.PI_BINARY ?? ""}\0${env.PATH ?? ""}`;
  let pending = resolutions.get(key);
  if (pending === undefined) {
    pending = (async () => {
      const executableRealpath = await realpath(await executableFrom(env));
      const versionResult = spawnSync(executableRealpath, ["--version"], { env, encoding: "utf8", timeout: 10_000 });
      if (versionResult.error !== undefined || versionResult.status !== 0) throw new Error(`machine Pi version probe failed: ${versionResult.stderr || versionResult.error}`);
      const version = versionResult.stdout.replace(/\r?\n$/, "");
      if (version.length === 0) throw new Error("machine Pi version probe returned no version");
      return { executableRealpath, version };
    })();
    resolutions.set(key, pending);
  }
  return pending;
}

export type MachinePiRpcResult = {
  readonly runtime: MachinePiRuntimeIdentity;
  readonly events: readonly Record<string, unknown>[];
  readonly stderr: string;
  readonly decision?: unknown;
  readonly response?: Record<string, unknown>;
  readonly settled: boolean;
};

export async function runMachinePiRpc(options: { env?: NodeJS.ProcessEnv; cwd: string; sessionDir: string; args: readonly string[]; commands: readonly Record<string, unknown>[]; decisionToolName?: string; signal?: AbortSignal }): Promise<MachinePiRpcResult> {
  const env = options.env ?? process.env;
  const runtime = await resolveMachinePi(env);
  await mkdir(options.sessionDir, { recursive: true });
  return await new Promise((resolveResult, reject) => {
    const child = spawn(runtime.executableRealpath, ["--mode", "rpc", "--session-dir", options.sessionDir, ...options.args], { cwd: options.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const events: Record<string, unknown>[] = []; let stderr = ""; let buffer = ""; let response: Record<string, unknown> | undefined; let decision: unknown; let settled = false; let aborted = false; let finished = false;
    const decoder = new StringDecoder("utf8");
    const fail = (error: Error) => { if (!finished) { finished = true; reject(error); } };
    const consume = (line: string) => {
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") return;
      let event: Record<string, unknown>; try { event = JSON.parse(line) as Record<string, unknown>; } catch (cause) { child.kill("SIGTERM"); fail(new Error("machine Pi RPC emitted invalid JSONL", { cause })); return; }
      events.push(event);
      if (event.type === "response" && event.success === false) { child.kill("SIGTERM"); fail(new Error(`machine Pi RPC command failed: ${String(event.error)}`)); }
      if (event.type === "message_end" && typeof event.message === "object" && event.message !== null) response = event.message as Record<string, unknown>;
      if (event.type === "tool_execution_end" && event.toolName === options.decisionToolName) decision = (event.result as { details?: unknown } | undefined)?.details;
      if (event.type === "agent_settled") { settled = true; child.stdin.end(); }
    };
    child.stdout.on("data", (chunk: Buffer) => { buffer += decoder.write(chunk); for (;;) { const i = buffer.indexOf("\n"); if (i < 0) break; consume(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    const abort = () => { aborted = true; child.kill("SIGTERM"); };
    if (options.signal?.aborted) abort(); else options.signal?.addEventListener("abort", abort, { once: true });
    child.on("error", (cause) => fail(new Error("machine Pi RPC spawn failed", { cause })));
    child.on("close", (code, signal) => {
      options.signal?.removeEventListener("abort", abort); buffer += decoder.end(); if (buffer !== "") consume(buffer);
      if (finished) return; finished = true;
      if (aborted) return reject(new Error("machine Pi RPC aborted after SIGTERM"));
      if (code !== 0) return reject(new Error(`machine Pi RPC terminated unsuccessfully (code ${code}, signal ${signal ?? "none"})${stderr === "" ? "" : `: ${stderr}`}`));
      if (!settled) return reject(new Error("machine Pi RPC exited without agent_settled"));
      resolveResult({ runtime, events, stderr, ...(decision === undefined ? {} : { decision }), ...(response === undefined ? {} : { response }), settled });
    });
    child.once("spawn", () => { for (const command of options.commands) child.stdin.write(`${JSON.stringify(command)}\n`); });
  });
}
