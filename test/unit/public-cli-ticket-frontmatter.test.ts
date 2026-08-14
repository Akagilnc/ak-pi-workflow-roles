/**
 * #176 typed ticket face — parse contract + one real public-runner tracer.
 * Positive path goes through runAkRole (production admission entry), not admit*
 * helpers: freeze/admit → two typed durable pages → resume → board.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../../src/activation-ledger-topology.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { loadResumableJudgeRun } from "../../src/public-cli/run-lifecycle.ts";
import {
  parseTicketNumberFrontmatter,
  resolveTicketNumberFromAttachmentBodies,
} from "../../src/ticket-frontmatter.ts";
import {
  buildTicketTrajectoryBookIndex,
  loadTicketTrajectoryRuns,
  loadUnboundTrajectoryRuns,
} from "../../src/ticket-trajectory.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { observeTyped429ViaProductionHandler } from "../helpers/typed-429-observation.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-ticket-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "ticket@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Ticket Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

async function writeSessionProviderStop(
  sessionDir: string,
  input: { provider: string; errorMessage: string },
): Promise<void> {
  await writeFile(
    join(sessionDir, "session.jsonl"),
    [
      JSON.stringify({
        type: "message",
        message: {
          role: "user",
          content: [{ type: "text", text: "go" }],
        },
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          stopReason: "error",
          errorMessage: input.errorMessage,
          provider: input.provider,
          model: "probe",
          api: "openai-responses",
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
}

test("parseTicketNumberFrontmatter reads only typed frontmatter field", () => {
  assert.equal(
    parseTicketNumberFrontmatter("---\nticketNumber: 176\n---\n# free text 999\n"),
    176,
  );
  assert.equal(parseTicketNumberFrontmatter("# free text ticketNumber: 176\n"), undefined);
  assert.equal(parseTicketNumberFrontmatter("---\ntitle: x\n---\n"), undefined);
  assert.equal(parseTicketNumberFrontmatter("---\nticketNumber: 0\n---\n"), undefined);
  assert.equal(
    resolveTicketNumberFromAttachmentBodies([
      "---\nticketNumber: 176\n---\n",
      "---\nticketNumber: 177\n---\n",
    ]),
    undefined,
  );
  assert.equal(
    resolveTicketNumberFromAttachmentBodies([
      "plain",
      "---\nticketNumber: 176\n---\n",
    ]),
    176,
  );
});

test("public runner without typed face admits unbound and stays off the board", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const plain = join(home, "note.txt");
    await writeFile(plain, "no frontmatter", "utf8");
    const runId = "run-no-ticket";
    const { io } = captureIo();
    await runAkRole(
      ["judge", "--project", project, "--attach", plain, "review unbound"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await writeFile(join(sessionDir, "session.jsonl"), "", "utf8");
          return {
            code: 1,
            stderr: "fail\n",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    const ledgerHome = resolveActivationLedgerHome(() => home);
    const bookKey = resolveBookKeyFromGit(project);
    const bookDir = activationBookDirectory(ledgerHome, bookKey);
    const runDirectory = join(bookDir, "runs", `${runId}@judge`);
    assert.equal(existsSync(runDirectory), true);

    const admitted = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(admitted.ticketNumber, undefined);
    const invocation = JSON.parse(
      await readFile(join(runDirectory, "invocation.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(invocation.ticketNumber, undefined);

    const index = await buildTicketTrajectoryBookIndex(bookDir);
    assert.equal(index.unboundRuns.some((r) => r.runFolder === `${runId}@judge`), true);
    const ticketRuns = await loadTicketTrajectoryRuns(bookDir, 176, index);
    assert.equal(ticketRuns.some((r) => r.runId === `${runId}@judge`), false);
    const unbound = await loadUnboundTrajectoryRuns(bookDir, index);
    assert.equal(unbound.some((r) => r.run.runId === `${runId}@judge`), true);
  });
});

test("public runner typed face: freeze/admit → durable pages → resume → board", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const ticketFace = join(home, "ticket-176.md");
    await writeFile(
      ticketFace,
      "---\nticketNumber: 176\n---\n# #176 progress board\nprose must not bind\n",
      "utf8",
    );
    const runId = "run-with-ticket";
    const { io } = captureIo();
    const first = await runAkRole(
      ["judge", "--project", project, "--attach", ticketFace, "quota interrupted"],
      {
        packageRoot,
        home,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => runId,
        io,
        piRunner: async (args) => {
          const sessionDir = args[args.indexOf("--session-dir") + 1]!;
          await mkdir(sessionDir, { recursive: true });
          await observeTyped429ViaProductionHandler({
            runDirectory: join(sessionDir, ".."),
            provider: "openai-codex",
          });
          await writeSessionProviderStop(sessionDir, {
            provider: "openai-codex",
            errorMessage: "upstream declined",
          });
          return {
            code: 1,
            stderr: "fail\n",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );
    assert.ok(first.terminal?.resume, "typed-face run must be resumable after 429");

    const ledgerHome = resolveActivationLedgerHome(() => home);
    const bookKey = resolveBookKeyFromGit(project);
    const bookDir = activationBookDirectory(ledgerHome, bookKey);
    const runDirectory = join(bookDir, "runs", `${runId}@judge`);
    assert.equal(existsSync(runDirectory), true);

    // Frozen attachment retains the typed field.
    const attachmentsDir = join(runDirectory, "attachments");
    assert.equal(existsSync(attachmentsDir), true);
    const names = await readdir(attachmentsDir);
    assert.ok(names.length >= 1, "typed face must be frozen under attachments/");
    const frozen = await readFile(join(attachmentsDir, names[0]!), "utf8");
    assert.equal(parseTicketNumberFrontmatter(frozen), 176);

    // Two durable typed pages.
    const admittedRequest = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(admittedRequest.ticketNumber, 176);
    const invocation = JSON.parse(
      await readFile(join(runDirectory, "invocation.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(invocation.ticketNumber, 176);

    const loaded = await loadResumableJudgeRun(home, runId);
    assert.equal(loaded.admitted.ticketNumber, 176);

    // Resume keeps the typed field.
    const resumed = await runAkRole(["resume", runId], {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true, xai: true },
      io: captureIo().io,
      piRunner: async (args) => {
        const sessionDir = args[args.indexOf("--session-dir") + 1]!;
        await writeFile(
          join(sessionDir, "session.jsonl"),
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolName: JUDGE_OUTPUT_TOOL_NAME,
              isError: false,
              details: { judgeStatus: "converged" },
            },
          })}\n`,
          "utf8",
        );
        return {
          code: 0,
          stderr: "",
          timedOut: false,
          args: [...args],
        };
      },
    });
    assert.equal(resumed.exitCode, 0, "resume should settle");
    const after = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(after.ticketNumber, 176);

    // Board joins the flat run by typed invocation ticketNumber.
    const index = await buildTicketTrajectoryBookIndex(bookDir);
    const ticketRuns = await loadTicketTrajectoryRuns(bookDir, 176, index);
    assert.equal(ticketRuns.some((r) => r.runId === `${runId}@judge`), true);
    const other = await loadTicketTrajectoryRuns(bookDir, 177, index);
    assert.equal(other.some((r) => r.runId === `${runId}@judge`), false);
    const unbound = await loadUnboundTrajectoryRuns(bookDir, index);
    assert.equal(unbound.some((r) => r.run.runId === `${runId}@judge`), false);
  });
});
