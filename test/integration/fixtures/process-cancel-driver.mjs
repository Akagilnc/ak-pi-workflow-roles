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

/** Count turns so the parent can assert cancel does not auto-resume-re-dispatch. */
let turnCount = 0;

/**
 * Hang until parent abort; spawn a real child and SIGTERM it on cancel (host contract).
 * Principal is forced available so a missing skipAutoResume would re-dispatch (#855 p1).
 */
const hangingHost = {
  async executeTurn(request) {
    turnCount += 1;
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
      let graceTimer;
      const finish = () => {
        if (settled) return;
        settled = true;
        try {
          child.kill("SIGTERM");
        } catch {
          /* already exiting */
        }
        const done = () => {
          if (graceTimer !== undefined) clearTimeout(graceTimer);
          resolve(undefined);
        };
        child.once("close", done);
        // If close never fires, still settle after a short grace — clear on close.
        graceTimer = setTimeout(done, 2000);
      };
      if (request.signal?.aborted === true) finish();
      else request.signal?.addEventListener("abort", finish, { once: true });
    });

    if (process.env.AK_TEST_PROCESS_CANCEL_THROW === "1") {
      const error = new Error("HOST ORIGINAL THROW");
      error.name = "HostOriginal";
      error.knownCause = "provider";
      error.details = { owned: "OWNED" };
      throw error;
    }
    return {
      code: 1,
      stderr: "",
      timedOut: false,
      knownFailure: {
        diagnostic: "HOST ORIGINAL",
        identity: { name: "HostReported", code: "HOST" },
        details: { report: "HOST ORIGINAL" },
      },
    };
  },
};

const principalAuthority = piDurablePrincipalAuthority;

let exitCode = 1;
let diagnostic;
let cause;
let identity;
let details;
let packageFact;
let runState;
let runDirectory;

try {
  const result = await runAkRole(
    ["judge", "--model", "test/caller-seat:high", "--project", project, "process-cancel probe"],
    {
      packageRoot,
      home,
      cwd: project,
      principalAuthority,
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
  if (outcome && typeof outcome === "object") {
    if ("diagnostic" in outcome) diagnostic = outcome.diagnostic;
    if ("cause" in outcome) cause = outcome.cause;
    if ("identity" in outcome) identity = outcome.identity;
    if ("details" in outcome) details = outcome.details;
  }
  const errorArtifact = result.terminal?.artifacts?.find((item) => item.kind === "error");
  if (errorArtifact?.path) {
    const { readFile } = await import("node:fs/promises");
    // The artifact ref names the run's current.json; the error is its terminal section.
    const { terminal } = JSON.parse(await readFile(errorArtifact.path, "utf8"));
    if (terminal?.face !== "error") throw new Error(`error artifact ref does not name an error terminal: ${terminal?.face}`);
    const errorBody = terminal.body;
    packageFact = errorBody.packageFact;
    if (details === undefined) details = errorBody.details;
    if (identity === undefined) identity = errorBody.identity;
    if (cause === undefined) cause = errorBody.cause;
    if (diagnostic === undefined) diagnostic = errorBody.diagnostic;
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
    const raw = JSON.parse(await readFile(join(runDirectory, "current.json"), "utf8"));
    runState = raw.runState?.state;
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
    `${JSON.stringify({ exitCode, diagnostic, cause, identity, details, packageFact, runState, runDirectory, turnCount }, null, 2)}\n`,
    "utf8",
  );
  process.exitCode = exitCode;
}
