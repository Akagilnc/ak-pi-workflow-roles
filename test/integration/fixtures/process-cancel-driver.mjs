/**
 * #855 test driver — mirrors public main.ts process-cancel wiring, with an
 * injectable hanging host so SIGTERM/SIGINT/SIGHUP can be observed end-to-end.
 * Not production code.
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const home = process.env.AK_TEST_PROCESS_CANCEL_HOME;
const project = process.env.AK_TEST_PROCESS_CANCEL_PROJECT;
const packageRoot = process.env.AK_TEST_PROCESS_CANCEL_PACKAGE_ROOT;
const readyFile = process.env.AK_TEST_PROCESS_CANCEL_READY;
const childPidFile = process.env.AK_TEST_PROCESS_CANCEL_CHILD_PID;
const resultFile = process.env.AK_TEST_PROCESS_CANCEL_RESULT;
const runId = process.env.AK_TEST_PROCESS_CANCEL_RUN_ID ?? "01a0sig00-0000-7000-8000-000000000001";

if (!home || !project || !packageRoot || !readyFile || !childPidFile || !resultFile) {
  console.error("process-cancel-driver: missing AK_TEST_PROCESS_CANCEL_* env");
  process.exit(2);
}

const { installProcessCancelHandlers } = await import(
  join(packageRoot, "src/public-cli/process-cancel.ts")
);
const { runAkRole } = await import(join(packageRoot, "src/public-cli/cli.ts"));
const { piDurablePrincipalAuthority } = await import(
  join(packageRoot, "src/pi/durable-principal.ts")
);

const processCancel = installProcessCancelHandlers();

/** Hang until parent abort; spawn a real child and SIGTERM it on cancel (host contract). */
const hangingHost = {
  async executeTurn(request) {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    const pid = child.pid;
    if (typeof pid !== "number" || pid <= 0) {
      throw new Error("hanging host failed to spawn child");
    }
    await writeFile(childPidFile, `${pid}\n`, "utf8");
    await writeFile(readyFile, "ready\n", "utf8");

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* already exiting */
        }
        child.once("close", () => resolve(undefined));
        // If close never fires, still settle after a short grace.
        setTimeout(() => resolve(undefined), 2000);
      };
      if (request.signal?.aborted === true) finish();
      else request.signal?.addEventListener("abort", finish, { once: true });
    });

    return {
      code: 143,
      stderr: "",
      timedOut: false,
    };
  },
};

let exitCode = 1;
let diagnostic;
let runState;
let runDirectory;

try {
  const result = await runAkRole(
    ["judge", "--model", "test/caller-seat:high", "--project", project, "process-cancel probe"],
    {
      packageRoot,
      home,
      cwd: project,
      principalAuthority: piDurablePrincipalAuthority,
      credentials: { "openai-codex": true, xai: true },
      createRunId: () => runId,
      signal: processCancel.signal,
      roleTurnHost: hangingHost,
      io: {
        stdout: () => {},
        stderr: () => {},
      },
    },
  );
  exitCode =
    processCancel.receivedSignal() !== undefined && result.exitCode === 0
      ? 1
      : result.exitCode;

  const outcome = result.terminal?.roleOutcome;
  if (outcome && typeof outcome === "object" && "diagnostic" in outcome) {
    diagnostic = outcome.diagnostic;
  }
  const settledRunId =
    typeof result.terminal?.runId === "string" ? result.terminal.runId : runId;
  // Unbound placement under book runs/ — same as production admit before ticket bind.
  const { resolveBookKeyFromGit } = await import(
    join(packageRoot, "src/activation-ledger-git.ts")
  );
  const bookKey = resolveBookKeyFromGit(project);
  runDirectory = join(
    home,
    ".ak-roles",
    "books",
    bookKey,
    "unbound",
    "runs",
    `${settledRunId}@judge`,
  );
  try {
    const { readFile } = await import("node:fs/promises");
    const raw = JSON.parse(await readFile(join(runDirectory, "run-state.json"), "utf8"));
    runState = raw.state;
  } catch {
    runState = undefined;
  }
} catch (error) {
  diagnostic = error instanceof Error ? error.message : String(error);
  exitCode = 1;
} finally {
  processCancel.dispose();
  await mkdir(home, { recursive: true });
  await writeFile(
    resultFile,
    `${JSON.stringify({ exitCode, diagnostic, runState, runDirectory }, null, 2)}\n`,
    "utf8",
  );
  process.exitCode = exitCode;
}
