/**
 * Cross-process worker for package-machine-home-guard behavior tests (#604 F2).
 * Invoked as: node --import tsx <this> <mode> <coordDir> [id]
 *
 * Crash simulation uses process.exit from inside the critical section so the
 * guard's async finally does not run — never SIGKILL (global hard rule 9).
 *
 * Optional env AK_GUARD_PACKAGE_HOME overrides the package home root so absence
 * proofs can run against a hermetic tree without touching the host seat table.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { withPackageMachineHomeGuard } from "./package-machine-home-guard.ts";

const mode = process.argv[2];
const coordDir = process.argv[3];
if (typeof mode !== "string" || typeof coordDir !== "string" || mode.length === 0 || coordDir.length === 0) {
  console.error("usage: package-machine-home-guard-worker <mode> <coordDir> [id]");
  process.exit(2);
}

await mkdir(coordDir, { recursive: true });

function guardOptions(): { packageHome?: string } {
  const packageHome = process.env.AK_GUARD_PACKAGE_HOME;
  return typeof packageHome === "string" && packageHome.length > 0
    ? { packageHome }
    : {};
}

if (mode === "critical") {
  const id = process.argv[4] ?? String(process.pid);
  await withPackageMachineHomeGuard(guardOptions(), async () => {
    await appendFile(
      join(coordDir, "log.jsonl"),
      `${JSON.stringify({ id, event: "enter", t: Date.now(), pid: process.pid })}\n`,
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 250));
    await appendFile(
      join(coordDir, "log.jsonl"),
      `${JSON.stringify({ id, event: "exit", t: Date.now(), pid: process.pid })}\n`,
      "utf8",
    );
  });
  process.exit(0);
}

if (mode === "hold-and-mutate-exit") {
  // Mutate config under the lock, signal readiness, then exit the process
  // without unwinding the guard finally (lock + absence/presence backup remain).
  await withPackageMachineHomeGuard(guardOptions(), async (guard) => {
    await writeFile(
      guard.configPath,
      `${JSON.stringify({ seats: {}, akGuardProbe: process.pid }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(coordDir, "inside"), `${process.pid}\n`, "utf8");
    // Intentional crash path: process.exit skips async finally on the guard.
    process.exit(99);
  });
  process.exit(0);
}

if (mode === "reclaim-stale") {
  // Compete to enter after a stale lock is already on disk (parent plants it).
  // Success = acquired, ran scenario, released cleanly (exit 0).
  const id = process.argv[4] ?? String(process.pid);
  await withPackageMachineHomeGuard(guardOptions(), async () => {
    await appendFile(
      join(coordDir, "reclaim.jsonl"),
      `${JSON.stringify({ id, event: "entered", t: Date.now(), pid: process.pid })}\n`,
      "utf8",
    );
    await new Promise((resolve) => setTimeout(resolve, 80));
    await appendFile(
      join(coordDir, "reclaim.jsonl"),
      `${JSON.stringify({ id, event: "left", t: Date.now(), pid: process.pid })}\n`,
      "utf8",
    );
  });
  process.exit(0);
}

console.error(`unknown mode: ${mode}`);
process.exit(2);
