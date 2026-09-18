/**
 * #855: catchable process signals through the public ak-role entry.
 * Table-driven SIGTERM/SIGINT/SIGHUP — one harness, three signals.
 * Asserts: non-zero exit, terminal/run-state carry the signal name, host child gone.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { isolatedTestProcessEnv } from "../helpers/test-process-fixtures.ts";

const CATCHABLE = ["SIGTERM", "SIGINT", "SIGHUP"] as const;
const driverPath = fileURLToPath(
  new URL("./fixtures/process-cancel-driver.mjs", import.meta.url),
);

async function waitForFile(path: string, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await readFile(path, "utf8");
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 25));
    }
  }
  throw new Error(`timed out waiting for ${path}`);
}

test("public entry: SIGTERM/SIGINT/SIGHUP settle non-success with signal name and stop host child", async () => {
  for (const signalName of CATCHABLE) {
    await withTempRoot(`ak-process-cancel-${signalName}-`, async (home) => {
      seedGitRepository(home);
      const project = join(home, "proj");
      await mkdir(project, { recursive: true });
      seedGitRepository(project);
      const agentDir = join(home, ".pi", "agent");
      await mkdir(agentDir, { recursive: true });
      const readyFile = join(home, "ready");
      const childPidFile = join(home, "child.pid");
      const resultFile = join(home, "result.json");

      const env = isolatedTestProcessEnv({
        env: {
          ...process.env,
          AK_TEST_PROCESS_CANCEL_HOME: home,
          AK_TEST_PROCESS_CANCEL_PROJECT: project,
          AK_TEST_PROCESS_CANCEL_PACKAGE_ROOT: packageRoot,
          AK_TEST_PROCESS_CANCEL_READY: readyFile,
          AK_TEST_PROCESS_CANCEL_CHILD_PID: childPidFile,
          AK_TEST_PROCESS_CANCEL_RESULT: resultFile,
          AK_TEST_PROCESS_CANCEL_RUN_ID: `01a0sig00-0000-7000-8000-${signalName.toLowerCase().padEnd(12, "0").slice(0, 12)}`,
        },
        home,
        agentDir,
      });

      const child = spawn(process.execPath, ["--import", "tsx", driverPath], {
        cwd: project,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8").on("data", (c) => {
        stdout += c;
      });
      child.stderr?.setEncoding("utf8").on("data", (c) => {
        stderr += c;
      });

      const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.once("close", (code, sig) => resolve({ code, signal: sig }));
      });

      try {
        await waitForFile(readyFile);
        const hostChildPid = Number.parseInt(await readFile(childPidFile, "utf8"), 10);
        assert.ok(Number.isSafeInteger(hostChildPid) && hostChildPid > 0, `${signalName}: host child pid`);

        child.kill(signalName);
        const exit = await closed;

        // Public process must not present as normal success.
        assert.notEqual(exit.code, 0, `${signalName}: exit code must be non-zero; stderr=${stderr}`);
        // Catchable signals are handled — process should exit with a code, not die on the signal.
        assert.equal(exit.signal, null, `${signalName}: handler must settle instead of dying on signal`);

        const result = JSON.parse(await readFile(resultFile, "utf8")) as {
          exitCode: number;
          diagnostic?: string;
          runState?: string;
          runDirectory?: string;
        };
        assert.notEqual(result.exitCode, 0, `${signalName}: settled exitCode`);
        assert.ok(
          typeof result.diagnostic === "string" && result.diagnostic.includes(signalName),
          `${signalName}: diagnostic must name the signal; got ${result.diagnostic}`,
        );
        assert.equal(result.runState, "terminal", `${signalName}: run-state must be terminal`);

        // Host child must be gone (graceful SIGTERM path).
        await new Promise((r) => setTimeout(r, 50));
        let hostChildAlive = true;
        try {
          process.kill(hostChildPid, 0);
        } catch (error) {
          hostChildAlive = (error as NodeJS.ErrnoException).code !== "ESRCH";
        }
        assert.equal(hostChildAlive, false, `${signalName}: host child must exit`);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await closed.catch(() => undefined);
        }
      }
      void stdout;
    });
  }
});
