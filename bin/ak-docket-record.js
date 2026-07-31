#!/usr/bin/env node
/**
 * Standalone launcher for ak-docket-record.
 *
 * Runtime strategy: ship precompiled plain ESM under dist/ (built from
 * src/recorder + src/package-contracts via `npm run build:recorder`). Packed
 * installs invoke this bin with no tsx dependency and no Node type-stripping
 * under node_modules. Child signal death is re-raised as a real signal.
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(packageRoot, "dist/recorder/cli.js");

/**
 * Finite platform-code → category map (mirrors errors.ts safeDiagnostic).
 * Never interpolates message, stack, path, argv, or environment.
 */
function categoryFromCause(cause) {
  const code =
    typeof cause === "object" &&
    cause !== null &&
    typeof cause.code === "string"
      ? cause.code
      : null;
  if (code === "ENOENT") return "filesystem-missing";
  if (code === "EACCES" || code === "EPERM") return "filesystem-inaccessible";
  if (code === "EISDIR") return "filesystem-not-file";
  const filesystem = new Set([
    "EEXIST",
    "ENOTDIR",
    "ENOTEMPTY",
    "EROFS",
    "EXDEV",
    "ELOOP",
    "ENOSPC",
    "EMFILE",
    "ENFILE",
  ]);
  const processCodes = new Set(["ECHILD", "ENOEXEC", "ESRCH"]);
  if (code !== null && filesystem.has(code)) return "filesystem";
  if (code !== null && processCodes.has(code)) return "process";
  if (code !== null) return "platform-error";
  if (cause instanceof Error) return "error";
  return "non-error-throw";
}

function writeLauncherFailure(code, cause) {
  const message =
    code === "spawn-failed"
      ? "failed to spawn child process"
      : "internal Recorder failure";
  console.error(
    JSON.stringify({
      recorder: {
        status: "failed",
        code,
        message,
        location: null,
        diagnostic: {
          stage: "launcher",
          category: categoryFromCause(cause),
        },
      },
      child: {
        status: "not-spawned",
        exitCode: null,
        signal: null,
        diagnostic: null,
      },
    }),
  );
}

try {
  accessSync(entry, constants.R_OK);
} catch (error) {
  // Package entry unavailability is not a spawn failure.
  writeLauncherFailure("internal-error", error);
  process.exit(125);
}

let child;
try {
  child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
} catch (error) {
  writeLauncherFailure("spawn-failed", error);
  process.exit(125);
}

child.on("error", (error) => {
  writeLauncherFailure("spawn-failed", error);
  process.exit(125);
});

function reRaiseSignal(signal) {
  try {
    process.removeAllListeners(signal);
  } catch {
    // ignore
  }
  try {
    process.kill(process.pid, signal);
  } catch {
    process.exit(125);
  }
  setInterval(() => {}, 1 << 30);
}

child.on("exit", (code, signal) => {
  if (signal) {
    reRaiseSignal(signal);
    return;
  }
  process.exit(code ?? 1);
});
