import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, resolve } from "node:path";
const GIT_DISCOVERY_ENV_KEYS = [
  "GIT_DIR",
  "GIT_COMMON_DIR",
  "GIT_WORK_TREE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM"
];
function envWithoutGitDiscovery(base = process.env) {
  const env = { ...base, LC_ALL: "C" };
  for (const key of GIT_DISCOVERY_ENV_KEYS) {
    delete env[key];
  }
  return env;
}
const CONFIRMED_NON_REPOSITORY_STDERR = /^fatal:\s*not a git repository/i;
function isConfirmedNonRepositoryStderr(stderr) {
  return CONFIRMED_NON_REPOSITORY_STDERR.test(stderr);
}
class ActivationGitRepositoryRequiredError extends Error {
  code = "AK_ACTIVATION_GIT_REPOSITORY_REQUIRED";
  confirmedNonRepository;
  constructor(detail, options) {
    super(
      `Workflow role activation requires a git repository cwd (git rev-parse --git-common-dir failed): ${detail || "unknown git error"}`,
      options?.cause === void 0 ? void 0 : { cause: options.cause }
    );
    this.name = "ActivationGitRepositoryRequiredError";
    this.confirmedNonRepository = options?.confirmedNonRepository ?? false;
  }
}
function isGitSpawnInfrastructureError(error) {
  if (error === null || typeof error !== "object" || !("code" in error)) return false;
  const code = error.code;
  return code === "ENOENT" || code === "EACCES" || code === "EPERM";
}
function gitChildExitedNonzero(error) {
  if (error === null || typeof error !== "object" || !("status" in error)) return false;
  const status = error.status;
  return typeof status === "number" && status !== 0;
}
function resolveBookKeyFromGit(cwd) {
  let commonDir;
  try {
    commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: envWithoutGitDiscovery()
    }).trim();
  } catch (error) {
    if (isGitSpawnInfrastructureError(error) || !gitChildExitedNonzero(error)) {
      throw error;
    }
    const err = error;
    const detail = typeof err.stderr === "string" ? err.stderr.trim() : Buffer.isBuffer(err.stderr) ? err.stderr.toString("utf8").trim() : typeof err.message === "string" ? err.message : "";
    throw new ActivationGitRepositoryRequiredError(detail || "unknown git error", {
      cause: error,
      confirmedNonRepository: isConfirmedNonRepositoryStderr(detail)
    });
  }
  if (commonDir.length === 0) {
    throw new Error("git rev-parse --git-common-dir returned an empty path");
  }
  const absoluteCommon = isAbsolute(commonDir) ? commonDir : resolve(cwd, commonDir);
  const hostDirectory = basename(absoluteCommon) === ".git" ? dirname(absoluteCommon) : absoluteCommon;
  const bookKey = basename(hostDirectory);
  if (bookKey.length === 0 || bookKey === "." || bookKey === "/") {
    throw new Error(`Unable to derive activation book key from git common dir: ${absoluteCommon}`);
  }
  return bookKey;
}
export {
  ActivationGitRepositoryRequiredError,
  isConfirmedNonRepositoryStderr,
  resolveBookKeyFromGit
};
