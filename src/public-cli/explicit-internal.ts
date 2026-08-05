/**
 * ak-role-owned one-invocation explicit Internal activation (ADR 0052 / #105).
 * Ordinary Pi package auto-registration does not load the role runtime; only
 * this adapter (or an intentional developer `pi -e`) crosses that boundary.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import { INTERNAL_ROLE_ENTRYPOINT_RELATIVE } from "./registry.ts";

export function resolveInternalRoleEntrypoint(packageRoot: string): string {
  return join(packageRoot, INTERNAL_ROLE_ENTRYPOINT_RELATIVE);
}

/**
 * Explicit one-invocation Internal activation args for the installed package copy.
 * Ordinary Pi package auto-registration does not include this entrypoint (ADR 0052).
 */
export function buildExplicitInternalActivationArgs(
  packageRoot: string,
  extraArgs: readonly string[] = [],
): string[] {
  return [
    "--no-extensions",
    "-e",
    resolveInternalRoleEntrypoint(packageRoot),
    ...extraArgs,
  ];
}

export type ExplicitInternalPiResult = {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /** Full argv passed to the Pi process (includes explicit -e load). */
  args: string[];
};

export type ExplicitInternalPiRunner = (
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
) => Promise<ExplicitInternalPiResult>;

/** Default runner: resolve `pi` on PATH (or PI_BINARY) for one subprocess. */
export const defaultExplicitInternalPiRunner: ExplicitInternalPiRunner = async (
  args,
  options,
) => {
  const command = options.env.PI_BINARY ?? "pi";
  return await new Promise((resolveResult, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 30_000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveResult({
        code,
        stdout,
        stderr,
        timedOut,
        args: [...args],
      });
    });
  });
};

/**
 * Spawn Pi once with `--no-extensions -e <packageRoot>/extensions/role-runtime.ts`
 * plus caller args. Used by ak-role so the public CLI owns the load boundary.
 */
export async function runExplicitInternalActivation(options: {
  packageRoot: string;
  extraArgs?: readonly string[];
  cwd: string;
  home: string;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runner?: ExplicitInternalPiRunner;
}): Promise<ExplicitInternalPiResult> {
  const args = buildExplicitInternalActivationArgs(
    options.packageRoot,
    options.extraArgs ?? [],
  );
  const runner = options.runner ?? defaultExplicitInternalPiRunner;
  return await runner(args, {
    cwd: options.cwd,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    env: {
      ...process.env,
      ...options.env,
      HOME: options.home,
      PI_CODING_AGENT_DIR: options.agentDir,
    },
  });
}

/** Non-dispatch args: load Internal once and exit via Pi help (no model turn). */
export const EXPLICIT_INTERNAL_LOAD_PROBE_ARGS = [
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
  "--no-session",
  "--help",
] as const;
