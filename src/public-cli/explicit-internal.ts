/**
 * ak-role-owned one-invocation explicit Internal activation (ADR 0052 / #105).
 * Ordinary Pi package auto-registration does not load the role runtime; only
 * this adapter (or an intentional developer `pi -e`) crosses that boundary.
 */
import { execFile, spawn } from "node:child_process";
import { constants, writeFileSync } from "node:fs";
import { access, readFile, realpath, unlink } from "node:fs/promises";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { platform } from "node:process";
import { promisify } from "node:util";

import {
  observeLaunchedRolePackageIdentity,
  recordLaunchedPiIdentity,
  recordLaunchedRolePackageIdentity,
} from "./invocation.ts";
import { INTERNAL_ROLE_ENTRYPOINT_RELATIVE } from "./registry.ts";
import {
  REVIEWER_PREFLIGHT_VIOLATIONS,
  type ReviewerPreflightViolation,
} from "../reviewer-dispatch.ts";
import type { ControlledFailureCause } from "./terminal.ts";

/** Durable Reviewer-rejection child→parent page under AK_ROLE_RUN_DIR. */
const REVIEWER_DISPATCH_REJECTION_FILE = "typed-known-failure.json";

function isReviewerPreflightViolation(value: unknown): value is ReviewerPreflightViolation {
  return (
    typeof value === "string" &&
    (REVIEWER_PREFLIGHT_VIOLATIONS as readonly string[]).includes(value)
  );
}

function reviewerDispatchRejectionPath(runDirectory: string): string {
  return join(runDirectory, REVIEWER_DISPATCH_REJECTION_FILE);
}

/**
 * Clear any prior attempt's Reviewer rejection page so resume/retry cannot
 * inherit a stale knownFailure.details.
 */
export async function clearReviewerDispatchRejection(runDirectory: string): Promise<void> {
  try {
    await unlink(reviewerDispatchRejectionPath(runDirectory));
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Synchronous durable write for Reviewer dispatch rejection (child process exit is sync).
 * Parent public CLI recovers via readReviewerDispatchRejection into knownFailure.
 */
export function recordReviewerDispatchRejectionSync(
  runDirectory: string,
  rejection: Readonly<{
    diagnostic: string;
    violations: readonly ReviewerPreflightViolation[];
  }>,
): void {
  writeFileSync(
    reviewerDispatchRejectionPath(runDirectory),
    `${JSON.stringify(rejection)}\n`,
    "utf8",
  );
}

/** Recover a child-written Reviewer dispatch rejection through a fixed mapping. */
export async function readReviewerDispatchRejection(
  runDirectory: string,
): Promise<ExplicitInternalKnownFailure | undefined> {
  let raw: string;
  try {
    raw = await readFile(reviewerDispatchRejectionPath(runDirectory), "utf8");
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    const error = new Error("Reviewer dispatch rejection page must be a JSON object");
    error.name = "ReviewerDispatchRejectionContractError";
    throw error;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record.diagnostic !== "string" ||
    record.diagnostic.trim() === "" ||
    !Array.isArray(record.violations) ||
    record.violations.length === 0 ||
    record.violations.some((value) => !isReviewerPreflightViolation(value))
  ) {
    const error = new Error("Reviewer dispatch rejection page has unusable required fields");
    error.name = "ReviewerDispatchRejectionContractError";
    throw error;
  }
  return {
    cause: "activation",
    diagnostic: record.diagnostic,
    identity: { name: "ReviewerDispatchRejectionError" },
    details: { violations: Object.freeze([...record.violations]) },
  };
}

export function resolveInternalRoleEntrypoint(packageRoot: string): string {
  return join(packageRoot, INTERNAL_ROLE_ENTRYPOINT_RELATIVE);
}

/**
 * Explicit one-invocation Internal activation args for the installed package copy.
 * Ordinary Pi package auto-registration does not include this entrypoint (ADR 0052).
 */
export function buildExplicitInternalActivationArgs(
  selectedRoleEntry: string,
  extraArgs: readonly string[] = [],
): string[] {
  return ["--no-extensions", "-e", selectedRoleEntry, ...extraArgs];
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
  /** Secondary evidence attached to the same typed failure record. */
  readonly details?: Readonly<Record<string, unknown>>;
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
  /** Canonical identity of the executable selected and launched by this runner. */
  piIdentity?: { executable: string; version: string };
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
  },
) => Promise<ExplicitInternalPiResult>;

const execFileAsync = promisify(execFile);

async function resolveSelectedPi(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string> {
  // Match child_process.spawn lookup: path-like commands and every relative or
  // empty PATH entry are interpreted from the child's cwd. When PATH is absent,
  // Node uses the platform search default rather than an empty search list.
  const searchPath = env.PATH ?? (platform === "win32" ? (process.env.PATH ?? "") : "/usr/bin:/bin");
  const candidates = isAbsolute(command) || command.includes("/")
    ? [resolve(cwd, command)]
    : searchPath.split(delimiter).map((dir) => resolve(cwd, dir, command));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES") continue;
      throw error;
    }
    // Once a candidate qualifies, canonicalization failures are real filesystem
    // failures, not evidence that PATH contained no executable.
    return await realpath(candidate);
  }
  throw new Error(`Pi executable not found: ${command}`);
}

async function selectedPiIdentity(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<{ executable: string; version: string }> {
  const executable = await resolveSelectedPi(command, cwd, env);
  const { stdout } = await execFileAsync(executable, ["--version"], {
    cwd,
    env,
    encoding: "utf8",
  });
  const version = stdout.trim();
  if (version === "") throw new Error(`Pi executable returned an empty version: ${executable}`);
  return { executable, version };
}

/** Default runner: canonically select `pi` on PATH (or PI_BINARY) and launch that exact file. */
export const defaultExplicitInternalPiRunner: ExplicitInternalPiRunner = async (
  args,
  options,
) => {
  const command = options.env.PI_BINARY ?? "pi";
  const piIdentity = await selectedPiIdentity(command, options.cwd, options.env);
  return await new Promise((resolveResult, reject) => {
    // Child stdout is discarded at the stdio seam (CLAUDE.md Role invocation
    // evidence). Do not pipe or accumulate it. stderr stays piped for diagnostics.
    const child = spawn(piIdentity.executable, [...args], {
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
    let identityRecorded: Promise<void> = Promise.resolve();
    child.once("spawn", () => {
      armTimeoutAfterChildReady();
      const runDirectory = options.env.AK_ROLE_RUN_DIR;
      if (typeof runDirectory === "string" && runDirectory !== "") {
        identityRecorded = recordLaunchedPiIdentity(runDirectory, piIdentity);
      }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timer !== undefined) clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      void identityRecorded.then(
        () => resolveResult({
          code,
          stderr,
          timedOut,
          args: [...args],
          piIdentity,
        }),
        reject,
      );
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
  runner?: ExplicitInternalPiRunner;
}): Promise<ExplicitInternalPiResult> {
  const roleEntry = await realpath(
    resolveInternalRoleEntrypoint(options.packageRoot),
  );
  const args = buildExplicitInternalActivationArgs(
    roleEntry,
    options.extraArgs ?? [],
  );
  const runner = options.runner ?? defaultExplicitInternalPiRunner;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...options.env,
    HOME: options.home,
    PI_CODING_AGENT_DIR: options.agentDir,
  };
  // Package provenance is known at the public CLI seam before Pi starts — write it
  // onto the existing invocation page so runs remain attributable even when the
  // child runner is injected or Pi identity recording never fires.
  const runDirectory = env.AK_ROLE_RUN_DIR;
  if (typeof runDirectory === "string" && runDirectory !== "") {
    await recordLaunchedRolePackageIdentity(
      runDirectory,
      await observeLaunchedRolePackageIdentity(options.packageRoot, roleEntry),
    );
  }
  return await runner(args, {
    cwd: options.cwd,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    env,
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
