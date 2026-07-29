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

function writeLauncherFailure() {
  // Fixed sanitized JSON — never interpolate attacker-controlled text.
  console.error(
    JSON.stringify({
      recorder: {
        status: "failed",
        code: "spawn-failed",
        message: "failed to spawn child process",
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
} catch {
  writeLauncherFailure();
  process.exit(125);
}

const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

child.on("error", () => {
  writeLauncherFailure();
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
