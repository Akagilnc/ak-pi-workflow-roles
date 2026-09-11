import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #635 / #709 / #771 — seat ticket identity from the public CLI true entry
 * (no --ticket / no frontmatter). Mechanical layer never matches summons text
 * against book-known numbers. Typed identity arrives only from:
 * - 起居郎 LLM assertion (countersign court station / diarist seat)
 * - --source-run admitted form (notary / auditor)
 * - already-bound resume
 * Asserts typed ticketNumber on admitted-request.json + invocation.json only
 * when a typed source provided it.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import test from "node:test";

import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
} from "../../src/package-contracts/worker-output.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { runPublicCoder } from "../../src/public-cli/coder-run.ts";
import { runPublicCountersign } from "../../src/public-cli/countersign-run.ts";
import { CliUsageError } from "../../src/public-cli/cli-errors.ts";
import { runPublicFixer } from "../../src/public-cli/fixer-run.ts";
import {
  bindAdmittedTicketNumber,
  parseCoderArgv,
  parseCountersignArgv,
  parseFixerArgv,
  parseJudgeArgv,
  parseNotaryArgv,
} from "../../src/public-cli/invocation.ts";
import { runPublicJudge } from "../../src/public-cli/judge-run.ts";
import { runPublicNotary } from "../../src/public-cli/notary-run.ts";
import { installGhFixture } from "../helpers/hermes-fixture.ts";
import {
  CANONICAL_SOURCE_RUN_ID,
  CANONICAL_SOURCE_ROLE,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { ensureTicketProvenanceVolume } from "../../src/ticket-provenance.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function withTempHome(
  run: (home: string) => Promise<void>,
): Promise<void> {
  await withTempRoot("ak-seat-self-ticket-", async (home) => {
    const binDir = join(home, "bin");
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;
    await withPrimaryAwareCleanup(
      () => run(home),
      async () => {
        if (priorPath === undefined) delete process.env.PATH;
        else process.env.PATH = priorPath;
      },
    );
  });
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

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "seat-ticket@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Seat Ticket"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], {
    cwd: root,
  });
}

async function withSeatProject(
  run: (ctx: { home: string; project: string }) => Promise<void>,
): Promise<void> {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    execFileSync(
      "git",
      ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
      { cwd: project },
    );
    await installGhFixture(join(home, "bin"), {
      issues: {
        582: { body: "issue 582 body", comments: [] },
      },
    });
    // Volume may exist; seats must not mechanically bind from it + summons text.
    ensureTicketProvenanceVolume(582, project, home);
    await run({ home, project });
  });
}

function baseEnv(input: {
  home: string;
  project: string;
  runId: string;
  role: "coder" | "fixer" | "judge" | "countersign" | "notary";
  toolName: string;
  details: unknown;
  /** Countersign court station: may bind a typed ticket (起居郎 handoff face). */
  runCourtDiaristStation?: (
    admitted: { ticketNumber?: number; runDirectory: string },
  ) => Promise<void>;
}) {
  const host = roleTurnHostFromLegacyPiRunner({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: scriptedTerminatingToolSession({
      role: input.role,
      toolName: input.toolName,
      details: input.details,
    }),
  });
  return {
    home: input.home,
    agentDir: join(input.home, ".pi"),
    packageRoot,
    cwd: input.project,
    principalAuthority: piDurablePrincipalAuthority,
    sessionAppender: appendPiSessionCustomEntry,
    roleTurnHost: host,
    createRunId: () => input.runId,
    // #742: body-path tests stub the court diarist station (no real nested seat).
    ...(input.role === "countersign"
      ? {
          runCourtDiaristStation:
            input.runCourtDiaristStation ?? (async () => undefined),
        }
      : {}),
  };
}

async function assertDurableTicket(
  runDirectory: string,
  expected: number,
): Promise<void> {
  const admitted = JSON.parse(
    await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
  ) as { ticketNumber?: number };
  const invocation = JSON.parse(
    await readFile(join(runDirectory, "invocation.json"), "utf8"),
  ) as { ticketNumber?: number };
  assert.equal(admitted.ticketNumber, expected);
  assert.equal(invocation.ticketNumber, expected);
}

async function assertDurableUnbound(runDirectory: string): Promise<void> {
  const admitted = JSON.parse(
    await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
  ) as { ticketNumber?: number };
  const invocation = JSON.parse(
    await readFile(join(runDirectory, "invocation.json"), "utf8"),
  ) as { ticketNumber?: number };
  assert.equal(admitted.ticketNumber, undefined);
  assert.equal(invocation.ticketNumber, undefined);
}

test("public coder without --ticket: no mechanical bind from summons text", async () => {
  await withSeatProject(async ({ home, project }) => {
    const result = await runPublicCoder(
      ["apply", "Implement the fix for ticket #582."],
      baseEnv({
        home,
        project,
        runId: "01a063500-0000-7000-8000-00000000coder",
        role: "coder",
        toolName: CODER_OUTPUT_TOOL_NAME,
        details: { status: "completed", report: "done" },
      }),
      captureIo().io,
      parseCoderArgv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, undefined);
    await assertDurableUnbound(result.admitted!.runDirectory);
  });
});

test("public fixer without --ticket: no mechanical bind from summons text", async () => {
  await withSeatProject(async ({ home, project }) => {
    const result = await runPublicFixer(
      ["apply", "Repair the regression on ticket #582."],
      baseEnv({
        home,
        project,
        runId: "01a063500-0000-7000-8000-00000000fixer",
        role: "fixer",
        toolName: FIXER_OUTPUT_TOOL_NAME,
        details: { status: "completed", report: "repaired", classResults: [{ name: "main", disposition: "completed", searchScope: "src", exceptions: [], commitSha: "abc1234" }] },
      }),
      captureIo().io,
      parseFixerArgv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, undefined);
    await assertDurableUnbound(result.admitted!.runDirectory);
  });
});

test("public judge without --ticket: no mechanical bind from summons text", async () => {
  await withSeatProject(async ({ home, project }) => {
    const result = await runPublicJudge(
      ["Adjudicate whether ticket #582 may proceed."],
      baseEnv({
        home,
        project,
        runId: "01a063500-0000-7000-8000-00000000judge",
        role: "judge",
        toolName: JUDGE_OUTPUT_TOOL_NAME,
        details: { judgeStatus: "converged" },
      }),
      captureIo().io,
      parseJudgeArgv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, undefined);
    await assertDurableUnbound(result.admitted!.runDirectory);
  });
});

test("public countersign without --ticket: binds only via 起居郎 typed handoff", async () => {
  await withSeatProject(async ({ home, project }) => {
    const result = await runPublicCountersign(
      ["裁：继续审票 #582 是否足以开工。"],
      baseEnv({
        home,
        project,
        runId: "01a063500-0000-7000-8000-00000000csign",
        role: "countersign",
        toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
        details: { countersignStatus: "converged", note: "署" },
        // Court station face: 起居郎 asserted #582 (typed handoff, not prose match).
        runCourtDiaristStation: async (admitted) => {
          await bindAdmittedTicketNumber(
            admitted as Parameters<typeof bindAdmittedTicketNumber>[0],
            582,
          );
        },
      }),
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.admitted?.ticketNumber, 582);
    assert.equal(
      result.admitted!.runDirectory.includes(`${sep}${result.admitted!.bookKey}${sep}582${sep}runs${sep}`),
      true,
    );
    assert.equal(
      existsSync(join(home, ".ak-roles", "books", result.admitted!.bookKey, "unbound", "runs", `${result.admitted!.runId}@countersign`)),
      false,
    );
    await assertDurableTicket(result.admitted!.runDirectory, 582);
  });
});

test("countersign and notary reject --ticket as unknown option (exit 2)", async () => {
  assert.throws(
    () => parseCountersignArgv(["--ticket", "582", "裁"]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      /unknown countersign option: --ticket/.test(
        error instanceof Error ? error.message : String(error),
      ),
  );
  assert.throws(
    () =>
      parseNotaryArgv([
        "--source-run",
        "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge",
        "--ticket",
        "582",
      ]),
    (error: unknown) =>
      error instanceof CliUsageError &&
      /unknown notary option: --ticket/.test(
        error instanceof Error ? error.message : String(error),
      ),
  );

  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const countersign = await runPublicCountersign(
      ["--ticket", "582", "裁"],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: {
          async executeTurn(_request: RoleTurnRequest) {
            throw new Error("turn must not start on unknown option");
          },
        },
        createRunId: () => "01a063500-0000-7000-8000-00000000rej1",
      },
      captureIo().io,
      parseCountersignArgv,
    );
    assert.equal(countersign.exitCode, 2);
    assert.equal(countersign.admitted, undefined);
  });
});

test("notary ticketNumber comes from --source-run admitted form, not a CLI flag", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    await writeFile(
      join(sourceRunPath, "admitted-request.json"),
      `${JSON.stringify({
        role: CANONICAL_SOURCE_ROLE,
        runId: CANONICAL_SOURCE_RUN_ID,
        ticketNumber: 582,
      })}\n`,
      "utf8",
    );

    // #742: bound notary materials carry the ticket's 起居录 paths (feature observation).
    const { resolveTicketProvenanceVolume } = await import(
      "../../src/ticket-provenance.ts"
    );
    const volume = resolveTicketProvenanceVolume(582, project, home);
    await mkdir(volume.volumeDir, { recursive: true });
    await writeFile(volume.humanViewFile, "# 起居录 · #582\n", "utf8");
    await writeFile(volume.recordFile, "{}\n", "utf8");

    let turnPrompt = "";
    const baseHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "pass", findings: [] },
      }),
    });
    const notaryIo = captureIo();
    const result = await runPublicNotary(
      ["--source-run", sourceRunPath],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: {
          async executeTurn(request: RoleTurnRequest) {
            turnPrompt = request.continuation.prompt;
            return baseHost.executeTurn(request);
          },
        },
        createRunId: () => "01a063500-0000-7000-8000-0000000notary",
      },
      notaryIo.io,
      parseNotaryArgv,
    );
    assert.equal(result.exitCode, 0, notaryIo.stderr.join(""));
    assert.equal(result.admitted?.ticketNumber, 582);
    await assertDurableTicket(result.admitted!.runDirectory, 582);
    assert.ok(turnPrompt.includes(volume.humanViewFile));
    assert.ok(turnPrompt.includes(volume.recordFile));
  });
});
