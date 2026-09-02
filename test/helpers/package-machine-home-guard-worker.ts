/**
 * Cross-process worker for package-machine-home-guard behavior tests (#604 F2).
 * Invoked as: node --import tsx <this> <mode> <coordDir> [id]
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

if (mode === "critical") {
  const id = process.argv[4] ?? String(process.pid);
  await withPackageMachineHomeGuard(async () => {
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

if (mode === "hold-and-mutate") {
  await withPackageMachineHomeGuard(async (guard) => {
    // Mutate host config under the lock; parent will SIGKILL before finally runs.
    await writeFile(
      guard.configPath,
      `${JSON.stringify({ seats: {}, akGuardProbe: process.pid }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(coordDir, "inside"), `${process.pid}\n`, "utf8");
    // Keep the event loop alive until SIGKILL; avoid a bare unsettled Promise.
    await new Promise<void>(() => {
      setInterval(() => {
        /* hold */
      }, 60_000);
    });
  });
  process.exit(0);
}

console.error(`unknown mode: ${mode}`);
process.exit(2);
