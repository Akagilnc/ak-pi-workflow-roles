/**
 * ak-role-owned one-invocation explicit Internal activation (ADR 0052 / #105).
 * Ordinary Pi package auto-registration does not load the role runtime; only
 * this adapter (or an intentional developer `pi -e`) crosses that boundary.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import { INTERNAL_ROLE_ENTRYPOINT_RELATIVE } from "./registry.ts";
import type { ControlledFailureCause } from "./terminal.ts";
import type { MachinePiRuntimeIdentity } from "../machine-pi-rpc.ts";

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

/** Production-owned typed failure carried on a resolved runner result. */
export type ExplicitInternalKnownFailure = {
  readonly cause: ControlledFailureCause;
  readonly identity?: {
    readonly name?: string;
    readonly code?: string | number;
  };
  /**
   * Optional diagnostic already owned by a typed production field (e.g. session
   * assistant errorMessage). Settlement prefers this over child stderr selection.
   */
  readonly diagnostic?: string;
};

/**
 * Produce a typed provider knownFailure from a native session assistant stop.
 * Source fields are session-typed (stopReason / errorMessage / provider) — never
 * child stderr prose. Used by the public classifier after a real Pi child exits.
 */
export function knownFailureFromProviderStop(input: {
  readonly stopReason?: string;
  readonly errorMessage?: string | null;
  readonly provider?: string;
  readonly model?: string;
}): ExplicitInternalKnownFailure | undefined {
  if (input.stopReason !== "error") return undefined;
  const diagnostic =
    typeof input.errorMessage === "string" && input.errorMessage.trim() !== ""
      ? input.errorMessage.trim()
      : "provider failure";
  const identity: { name: string; code?: string } = {
    name: "ProviderStopError",
  };
  if (typeof input.provider === "string" && input.provider.trim() !== "") {
    identity.code = input.provider;
  } else if (typeof input.model === "string" && input.model.trim() !== "") {
    identity.code = input.model;
  }
  return {
    cause: "provider",
    identity,
    diagnostic,
  };
}

export type ExplicitInternalPiResult = {
  code: number | null;
  stderr: string;
  timedOut: boolean;
  /** Full argv passed to the Pi process (includes explicit -e load). */
  args: string[];
  /**
   * Production-owned typed failure channel. Set only when the runner already
   * knows the cause without stderr-prose inference. Settlement trusts this over
   * the nonzero→activation default.
   */
  knownFailure?: ExplicitInternalKnownFailure;
};

/**
 * Thrown activation failure with a production-owned typed cause.
 * Prefer this over ad-hoc Error property tags so settlement retains typed identity.
 */
export class ExplicitInternalActivationError extends Error {
  readonly knownCause: ControlledFailureCause;
  readonly failureCode?: string | number;

  constructor(
    message: string,
    options: {
      knownCause: ControlledFailureCause;
      code?: string | number;
      name?: string;
      cause?: unknown;
    },
  ) {
    super(
      message,
      options.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = options.name ?? "ExplicitInternalActivationError";
    this.knownCause = options.knownCause;
    if (options.code !== undefined) {
      this.failureCode = options.code;
    }
  }
}

export type ExplicitInternalPiRunner = (
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
    runtime: MachinePiRuntimeIdentity;
  },
) => Promise<ExplicitInternalPiResult>;

/** Default runner: execute the admitted machine-Pi principal. */
export const defaultExplicitInternalPiRunner: ExplicitInternalPiRunner = async (
  args,
  options,
) => {
  const command = options.runtime.executableRealpath;
  return await new Promise((resolveResult, reject) => {
    // Child stdout is discarded at the stdio seam (CLAUDE.md Role invocation
    // evidence). Do not pipe or accumulate it. stderr stays piped for diagnostics.
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    let timedOut = false;
    // No default wall clock. Only an explicit caller budget arms a timer (ADR 0010).
    // SIGKILL is unconditionally forbidden (host constitution art. 9) — graceful SIGTERM only.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armTimeoutAfterChildReady = (): void => {
      if (options.timeoutMs === undefined) return;
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
      }, options.timeoutMs);
    };
    // The spawn event is the child-process readiness seam. Start the caller's
    // budget only after the child is actually created, not while spawn is pending.
    child.once("spawn", armTimeoutAfterChildReady);
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      resolveResult({
        code,
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
  timeoutMs?: number | undefined;
  runtime: MachinePiRuntimeIdentity;
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
    runtime: options.runtime,
    env: {
      ...process.env,
      ...options.env,
      HOME: options.home,
      PI_CODING_AGENT_DIR: options.agentDir,
      AK_MACHINE_PI_EXECUTABLE_REALPATH: options.runtime.executableRealpath,
      AK_MACHINE_PI_VERSION: options.runtime.version,
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
