/**
 * #526 / #600 / #617: engine field stays effective across the initial / auto-resume /
 * explicit-resume typed request for all seven resumable seats; resume also
 * projects engine onto invocation.json. Engine present→absent resume clears
 * invocation.engine (authoritative seat axis).
 *
 * Drives the real public entry (`runAkRole`) with the minimal host-neutral host
 * (`createMinimalHost`) so the proof exercises the production composition root.
 *
 * - Initial/auto: five core seats (judge/coder/fixer/reviewer/merger).
 * - Explicit: all seven resumable seats (+ countersign / gleaner-left).
 * - Unset: engine-bearing run → unset-engine → resume clears invocation.engine.
 *
 * Contract surface is typed only: `request.engine` and `invocation.engine`.
 * Zero free-text / continuation-prompt oracle (anchoring constitution).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { createMinimalHost } from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { packageRoot, withHermeticHome } from "../helpers/pi-test-harness.ts";
import { mkdir as mkdirDir } from "node:fs/promises";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { GLEANER_LEFT_OUTPUT_TOOL_NAME } from "../../src/gleaner-left-contracts.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  JUDGE_OUTPUT_TOOL_NAME,
  MERGER_OUTPUT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
} from "../../src/role-runtime.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { installHermesFixture } from "../helpers/hermes-fixture.ts";

const ENGINE = "kimi";

type CoreSeat = "judge" | "coder" | "fixer" | "reviewer" | "merger";
type Seat = CoreSeat | "countersign" | "gleaner-left";

/** Seat → terminating tool + accepted details (single table, no nested ternaries). */
const SEAT_TERMINAL: Record<
  Seat,
  { readonly toolName: string; readonly details: Record<string, unknown> }
> = {
  judge: { toolName: JUDGE_OUTPUT_TOOL_NAME, details: { judgeStatus: "converged" } },
  coder: { toolName: CODER_OUTPUT_TOOL_NAME, details: { status: "completed", report: "engine proof" } },
  fixer: {
    toolName: FIXER_OUTPUT_TOOL_NAME,
    details: {
      status: "completed",
      report: "engine proof",
      classResults: [{
        name: "engine-resume",
        disposition: "completed",
        searchScope: "engine-resume",
        exceptions: [],
        commitSha: "0".repeat(40),
      }],
    },
  },
  reviewer: {
    toolName: REVIEWER_OUTPUT_TOOL_NAME,
    details: {
      status: "completed",
      version: 2,
      outcomes: { standards: { status: "pass", findings: [] }, spec: { status: "pass", findings: [] } },
      reports: { standards: "ok", spec: "ok" },
    },
  },
  merger: {
    toolName: MERGER_OUTPUT_TOOL_NAME,
    details: { status: "escalate", attemptId: "", diagnosis: "need escalate", report: "merger proof" },
  },
  countersign: {
    toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
    details: { countersignStatus: "converged" },
  },
  "gleaner-left": {
    toolName: GLEANER_LEFT_OUTPUT_TOOL_NAME,
    details: { status: "completed", findings: [] },
  },
};

/**
 * Materialize the durable principal's Pi session file at its authoritative
 * coordinates (decoded from the request principal, no path guessing). A
 * resumable run requires an existing session file: the auto-resume loop's
 * principal-availability gate and `loadResumableRun` both check it.
 */
async function seedPrincipalSession(request: { principal: unknown }): Promise<string> {
  const { sessionDirectory, sessionFile } = piDurablePrincipalAuthority.decode(
    request.principal,
  );
  await mkdirDir(sessionDirectory, { recursive: true });
  await writeFile(sessionFile, "", "utf8");
  return sessionFile;
}

async function seedTerminalSession(input: {
  seat: Seat;
  sessionFile: string;
  cwd: string;
  home: string;
  runId: string;
  runDirectory: string;
}): Promise<void> {
  const { seat, sessionFile, cwd, home, runId, runDirectory } = input;
  const { toolName, details: baseDetails } = SEAT_TERMINAL[seat];
  const details =
    seat === "merger" ? { ...baseDetails, attemptId: runId } : baseDetails;
  const entries = [];
  if (seat === "merger") {
    const skillPath = join(packageRoot, "resources/methods/resolving-merge-conflicts/SKILL.md");
    entries.push({
      type: "message",
      message: {
        role: "user",
        content: `<skill name="resolving-merge-conflicts" location="${skillPath}">\nmerge instructions\n</skill>\n\nComplete the merge.`,
      },
    });
  }
  entries.push({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "r1",
      toolName,
      isError: false,
      details,
    },
  });
  await writeFile(
    sessionFile,
    entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf8",
  );
  await sealAcceptedSubmission({
    cwd,
    home,
    runId,
    runDirectory,
    role: seat as TerminalRoleName,
    details,
    toolCallId: "r1",
  });
}

function baseArgs(seat: Seat, project: string): string[] {
  switch (seat) {
    case "judge":
      return ["judge", "--project", project, "engine detour proof"];
    case "coder":
      return ["coder", "--project", project, "engine detour proof"];
    case "fixer":
      return ["fixer", "--project", project, "engine detour proof"];
    case "reviewer":
      return ["reviewer", "--project", project, "--base", "HEAD", "engine detour proof"];
    case "merger":
      return ["merger", "--project", project, "engine detour proof"];
    case "countersign":
      // Unbound ticket: resume does not re-resolve; it still carries engine.
      return ["countersign", "--project", project, "engine detour proof"];
    case "gleaner-left":
      return ["gleaner-left", "--project", project, "--base", "HEAD", "engine detour proof"];
  }
}

/** Merger requires an ordinary in-progress merge to derive its envelope. */
async function seedMergeProject(project: string): Promise<void> {
  seedGitProject(project);
  await writeFile(join(project, "shared.txt"), "base\n", "utf8");
  execFileSync("git", ["add", "shared.txt"], { cwd: project });
  execFileSync("git", ["commit", "-m", "base"], { cwd: project });
  execFileSync("git", ["checkout", "-b", "feature-branch"], { cwd: project });
  await writeFile(join(project, "shared.txt"), "feature\n", "utf8");
  execFileSync("git", ["add", "shared.txt"], { cwd: project });
  execFileSync("git", ["commit", "-m", "feature"], { cwd: project });
  execFileSync("git", ["checkout", "main"], { cwd: project });
  await writeFile(join(project, "shared.txt"), "main\n", "utf8");
  execFileSync("git", ["add", "shared.txt"], { cwd: project });
  execFileSync("git", ["commit", "-m", "main"], { cwd: project });
  // Leave a conflicting merge in progress (no commit) so the envelope derives.
  try {
    execFileSync("git", ["merge", "--no-commit", "--no-ff", "feature-branch"], {
      cwd: project,
    });
  } catch {
    // Conflict is expected; the merge remains in progress.
  }
}

async function readInvocationEngine(runDirectory: string): Promise<unknown> {
  const invocation = JSON.parse(
    await readFile(join(runDirectory, "invocation.json"), "utf8"),
  ) as Record<string, unknown>;
  return invocation.engine;
}

test("engine stays effective on the initial typed request for all resumable seats", async () => {
  await withHermeticHome({ prefix: "ak-engine-init-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const seats: Seat[] = ["judge", "coder", "fixer", "reviewer", "merger"];
    for (const seat of seats) {
      if (seat === "merger") await seedMergeProject(project);
      let captured: string | undefined;
      const { io } = captureIo();
      await runAkRole([...baseArgs(seat, project), "--engine", ENGINE], {
        packageRoot,
        home,
        cwd: project,
        io,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => `run-engine-init-${seat}`,
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: createMinimalHost((request) => {
          captured = request.engine;
          return Promise.resolve({ code: 0, stderr: "", timedOut: false });
        }),
      });
      assert.equal(captured, ENGINE, `${seat}: initial request must carry engine`);
    }
  });
});

test("engine stays effective across the auto-resume loop (initial + auto payloads) for all resumable seats", async () => {
  await withHermeticHome({ prefix: "ak-engine-auto-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // Enable the single-call auto-resume loop.
    {
      const { io } = captureIo();
      await runAkRole(["config", "set-auto-resume-limit", "2"], { packageRoot, home, io });
    }

    const seats: Seat[] = ["judge", "coder", "fixer", "reviewer", "merger"];
    for (const seat of seats) {
      if (seat === "merger") await seedMergeProject(project);
      const captured: Array<string | undefined> = [];
      let first = true;
      const { io } = captureIo();
      await runAkRole([...baseArgs(seat, project), "engine auto proof", "--engine", ENGINE], {
        packageRoot,
        home,
        cwd: project,
        io,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => `run-engine-auto-${seat}`,
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: createMinimalHost(async (request) => {
          captured.push(request.engine);
          if (first) {
            first = false;
            // Resumability gates (loop + resume load) require the principal session
            // file to exist; seed it through the authoritative coordinates.
            await seedPrincipalSession(request);
            // Faux typed-429: mark the run resumable so the loop retries once.
            await observeTyped429ViaProductionHandler({
              runDirectory: request.runDirectory,
              provider: "xai",
            });
            return { code: 1, stderr: "quota", timedOut: false };
          }
          // Second (auto-resume) dispatch: lawful accepted terminal.
          const { sessionFile } = piDurablePrincipalAuthority.decode(request.principal);
          await seedTerminalSession({
            seat,
            sessionFile,
            cwd: request.cwd,
            home: request.home,
            runId: `run-engine-auto-${seat}`,
            runDirectory: request.runDirectory,
          });
          return { code: 0, stderr: "", timedOut: false };
        }),
      });

      assert.ok(captured.length >= 2, `${seat}: auto-resume must re-dispatch at least once`);
      assert.equal(captured[0], ENGINE, `${seat}: initial request must carry engine`);
      assert.equal(captured[1], ENGINE, `${seat}: auto-resume request must carry engine`);
      assert.ok(
        captured.every((e) => e === ENGINE),
        `${seat}: every auto-resume typed request keeps effective engine`,
      );
    }
  });
});

test("explicit ak-role resume re-projects engine onto the resumed typed request for all resumable seats", async () => {
  await withHermeticHome({ prefix: "ak-engine-resume-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // Shared seat ticket resolver needs hermes on PATH.
    const binDir = join(home, "bin");
    await installHermesFixture(binDir);
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;

    try {
      const seats: Seat[] = [
        "judge",
        "coder",
        "fixer",
        "reviewer",
        "merger",
        "countersign",
        "gleaner-left",
      ];
      for (const seat of seats) {
        if (seat === "merger") await seedMergeProject(project);
        const runId = `run-engine-resume-${seat}`;

        // Create an admitted, resumable run (faux typed-429).
        {
          const { io } = captureIo();
          await runAkRole(baseArgs(seat, project), {
            packageRoot,
            home,
            cwd: project,
            credentials: { "openai-codex": true, xai: true },
            createRunId: () => runId,
            io,
            roleTurnHost: createMinimalHost(async (request) => {
              await seedPrincipalSession(request);
              await observeTyped429ViaProductionHandler({
                runDirectory: request.runDirectory,
                provider: "xai",
              });
              return { code: 1, stderr: "quota", timedOut: false };
            }),
          });
        }

        // Explicit resume takes engine from the config seat (#617 seat table);
        // #453 requires a persistent model before engine.
        {
          const { io, stderr } = captureIo();
          await runAkRole(["config", "set", seat, "xai/grok-4.5:high"], { packageRoot, home, io });
          assert.equal(stderr.join(""), "");
          await runAkRole(["config", "set-engine", seat, ENGINE], { packageRoot, home, io });
          assert.equal(stderr.join(""), "");
        }
        let resumedEngine: string | undefined;
        let resumedInvocationEngine: unknown;
        {
          const { io, stdout, stderr } = captureIo();
          const resumed = await runAkRole(["resume", runId], {
            packageRoot,
            home,
            cwd: project,
            credentials: { "openai-codex": true, xai: true },
            io,
            principalAuthority: piDurablePrincipalAuthority,
            roleTurnHost: createMinimalHost(async (request) => {
              resumedEngine = request.engine;
              resumedInvocationEngine = await readInvocationEngine(request.runDirectory);
              const { sessionFile } = piDurablePrincipalAuthority.decode(request.principal);
              await seedTerminalSession({
                seat,
                sessionFile,
                cwd: request.cwd,
                home: request.home,
                runId,
                runDirectory: request.runDirectory,
              });
              return { code: 0, stderr: "", timedOut: false };
            }),
          });
          assert.equal(resumed.exitCode, 0, stdout.join("") + "\n[stderr] " + stderr.join(""));
        }
        assert.equal(resumedEngine, ENGINE, `${seat}: explicit resume must re-project engine`);
        assert.equal(
          resumedInvocationEngine,
          ENGINE,
          `${seat}: explicit resume must write engine onto invocation.json`,
        );
      }
    } finally {
      if (priorPath === undefined) delete process.env.PATH;
      else process.env.PATH = priorPath;
    }
  });
});

test("explicit resume clears invocation.engine when the live seat has no engine", async () => {
  await withHermeticHome({ prefix: "ak-engine-unset-resume-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "run-engine-unset-resume";

    // Birth leg carries engine onto invocation.
    {
      const { io, stderr } = captureIo();
      await runAkRole(["config", "set", "judge", "xai/grok-4.5:high"], { packageRoot, home, io });
      assert.equal(stderr.join(""), "");
      await runAkRole(["config", "set-engine", "judge", ENGINE], { packageRoot, home, io });
      assert.equal(stderr.join(""), "");
      await runAkRole(["judge", "--project", project, "seed with engine"], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        roleTurnHost: createMinimalHost(async (request) => {
          await seedPrincipalSession(request);
          await observeTyped429ViaProductionHandler({
            runDirectory: request.runDirectory,
            provider: "xai",
          });
          return { code: 1, stderr: "quota", timedOut: false };
        }),
      });
    }

    // Live seat drops engine (#617 acceptance: engine 有/无).
    {
      const { io, stderr } = captureIo();
      const unset = await runAkRole(["config", "unset-engine", "judge"], { packageRoot, home, io });
      assert.equal(unset.exitCode, 0, stderr.join(""));
    }

    let resumedEngine: string | undefined = "sentinel";
    let resumedInvocationEngine: unknown = "sentinel";
    {
      const { io, stdout, stderr } = captureIo();
      const resumed = await runAkRole(["resume", runId], {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        io,
        principalAuthority: piDurablePrincipalAuthority,
        roleTurnHost: createMinimalHost(async (request) => {
          resumedEngine = request.engine;
          resumedInvocationEngine = await readInvocationEngine(request.runDirectory);
          const { sessionFile } = piDurablePrincipalAuthority.decode(request.principal);
          await seedTerminalSession({
            seat: "judge",
            sessionFile,
            cwd: request.cwd,
            home: request.home,
            runId,
            runDirectory: request.runDirectory,
          });
          return { code: 0, stderr: "", timedOut: false };
        }),
      });
      assert.equal(resumed.exitCode, 0, stdout.join("") + "\n[stderr] " + stderr.join(""));
    }
    assert.equal(resumedEngine, undefined, "resume must not carry engine when seat has none");
    assert.equal(
      resumedInvocationEngine,
      undefined,
      "invocation.engine must be cleared when live seat has no engine",
    );
  });
});
