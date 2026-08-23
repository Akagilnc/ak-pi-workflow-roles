import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";

/** Git discovery env vars that must not influence book-key resolution from cwd. */
const GIT_DISCOVERY_ENV_KEYS = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
] as const;

function envWithoutGitDiscovery(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, LC_ALL: "C" };
  for (const key of GIT_DISCOVERY_ENV_KEYS) {
    delete env[key];
  }
  return env;
}

/**
 * #413 r2 U5 — single failure-classification owner. A git child nonzero exit is
 * only a *confirmed* non-repository verdict when git's own diagnostic says so
 * ("fatal: not a git repository …", forced to the C locale so the wording is
 * deterministic). Every other diagnostic — dubious ownership exit 128,
 * permissions, anything unknown — leaves the question open: git found or
 * refuses to adjudicate a repository-shaped situation without certifying
 * "non repository". Classification by diagnostic identity, not by exit code
 * alone, because both faces share exit 128.
 */
const CONFIRMED_NON_REPOSITORY_STDERR = /^fatal:\s*not a git repository/i;

export function isConfirmedNonRepositoryStderr(stderr: string): boolean {
  return CONFIRMED_NON_REPOSITORY_STDERR.test(stderr);
}

/**
 * Typed book-key discovery failure: a git child ran and exited nonzero.
 * Original git cause (nonzero exit) is retained. Spawn/OS failures never become
 * this type. `confirmedNonRepository` records whether git itself certified
 * "no repository here" (true) or merely failed for an unadjudicated reason
 * such as dubious ownership (false) — consumers may only synthesize fallback
 * identities from the confirmed face.
 */
export class ActivationGitRepositoryRequiredError extends Error {
  readonly code = "AK_ACTIVATION_GIT_REPOSITORY_REQUIRED" as const;
  readonly confirmedNonRepository: boolean;
  constructor(
    detail: string,
    options?: { cause?: unknown; confirmedNonRepository?: boolean },
  ) {
    super(
      `Workflow role activation requires a git repository cwd (git rev-parse --git-common-dir failed): ${detail || "unknown git error"}`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "ActivationGitRepositoryRequiredError";
    this.confirmedNonRepository = options?.confirmedNonRepository ?? false;
  }
}

/** Spawn/OS failure identity for the git child — not a repository-status result. */
function isGitSpawnInfrastructureError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code: unknown }).code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}

/** True when the git child process started and exited with a typed nonzero status. */
function gitChildExitedNonzero(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("status" in error)) return false;
  const status = (error as { status: unknown }).status;
  return typeof status === "number" && status !== 0;
}

/**
 * Book key = basename of the git common-dir host directory (ADR 0048).
 * Worktrees resolve to the main repository host.
 * A git child that exits nonzero becomes ActivationGitRepositoryRequiredError with cause;
 * spawn/infrastructure failures (ENOENT/EACCES/EPERM) retain their own identity.
 * Discovery is bound to `cwd` only — caller-controlled GIT_DIR / GIT_COMMON_DIR /
 * work-tree / ceiling / discovery env cannot redirect the lookup.
 */
export function resolveBookKeyFromGit(cwd: string): string {
  let commonDir: string;
  try {
    commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: envWithoutGitDiscovery(),
    }).trim();
  } catch (error) {
    // Infrastructure (missing binary, permission) keeps its own identity.
    // Only a git child that ran and returned nonzero may become the typed non-git error.
    // Do not classify by stderr prose.
    if (isGitSpawnInfrastructureError(error) || !gitChildExitedNonzero(error)) {
      throw error;
    }
    const err = error as { stderr?: string | Buffer; message?: string };
    const detail = typeof err.stderr === "string"
      ? err.stderr.trim()
      : Buffer.isBuffer(err.stderr)
      ? err.stderr.toString("utf8").trim()
      : typeof err.message === "string"
      ? err.message
      : "";
    throw new ActivationGitRepositoryRequiredError(detail || "unknown git error", {
      cause: error,
      confirmedNonRepository: isConfirmedNonRepositoryStderr(detail),
    });
  }
  if (commonDir.length === 0) {
    throw new Error("git rev-parse --git-common-dir returned an empty path");
  }
  const absoluteCommon = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  const hostDirectory = basename(absoluteCommon) === ".git"
    ? dirname(absoluteCommon)
    : absoluteCommon;
  const bookKey = basename(hostDirectory);
  if (bookKey.length === 0 || bookKey === "." || bookKey === "/") {
    throw new Error(`Unable to derive activation book key from git common dir: ${absoluteCommon}`);
  }
  return bookKey;
}
