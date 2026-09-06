/**
 * #637 — one public-entry tracer via runAkRole (cli.ts seat-table resolution):
 * first summons mints + seals; same-ticket re-summons resume that run under the
 * live seat-table model with a new court attempt and different source-run material;
 * second court no-seal then bare resume continues the open court (not prior seal).
 * Temp home is worktree-owned and always cleaned.
 *
 * Observation face is RoleTurnRequest (continuation / activation / model /
 * courtAttemptId). Sealing goes through roleTurnHostFromLegacyPiRunner → production
 * submission ledger. Wrapper only records structured request fields.
 * scriptedTerminatingToolSession overwrites the volume — proves request/settlement
 * only, not real host volume memory.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  CANONICAL_SOURCE_ROLE,
  CANONICAL_SOURCE_RUN_ID,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import {
  packageRoot,
  seedGitRepository,
} from "../helpers/pi-test-harness.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";

/** Worktree-owned scratch root — deletion boundary is this tree only. */
const WORKTREE_SCRATCH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".tmp-same-ticket-resume",
);

const SECOND_SOURCE_RUN_ID = "01a0637b-1111-7111-8111-00000000f002";

type SeenTurn = {
  runId: string;
  runDirectory: string;
  kind: RoleTurnRequest["continuation"]["kind"];
  model?: RoleTurnRequest["model"];
  sourceRun?: string;
  courtAttemptId?: string;
};

function seedGitProject(root: string): void {
  seedGitRepository(root);
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
    { cwd: root },
  );
}

function runIdFromDirectory(runDirectory: string): string {
  const base = runDirectory.split(/[\\/]/).pop() ?? "";
  const at = base.indexOf("@");
  return at === -1 ? base : base.slice(0, at);
}

async function listBookRunDirs(home: string): Promise<string[]> {
  const booksRoot = join(home, ".ak-roles", "books");
  const books = await readdir(booksRoot).catch(() => [] as string[]);
  const dirs: string[] = [];
  for (const b of books) {
    const runsDir = join(booksRoot, b, "runs");
    const entries = await readdir(runsDir).catch(() => [] as string[]);
    for (const entry of entries) {
      dirs.push(join(runsDir, entry));
    }
  }
  return dirs;
}

/** Shared notary scratch: git project + two source-runs under one ticket. */
async function openNotaryScratch(prefix: string): Promise<{
  home: string;
  project: string;
  firstSourcePath: string;
  secondSourcePath: string;
  io: { stdout: (t: string) => void; stderr: (t: string) => void };
  credentials: { readonly "openai-codex": true; readonly xai: true };
}> {
  await mkdir(WORKTREE_SCRATCH, { recursive: true });
  const home = await mkdtemp(join(WORKTREE_SCRATCH, prefix));
  const project = join(home, "project");
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  const firstSourcePath = await seedCanonicalSourceRun(home, project, {
    ticketNumber: 637,
  });
  const secondSourcePath = await seedCanonicalSourceRun(home, project, {
    runId: SECOND_SOURCE_RUN_ID,
    ticketNumber: 637,
    sessionContent: "second draft",
  });
  assert.notEqual(
    firstSourcePath,
    secondSourcePath,
    "fixture must materialize two distinct source-run directories",
  );
  return {
    home,
    project,
    firstSourcePath,
    secondSourcePath,
    io: { stdout: (_t: string) => {}, stderr: (_t: string) => {} },
    credentials: { "openai-codex": true, xai: true } as const,
  };
}

/** Observe structured RoleTurnRequest; seal via inner production-ledger host. */
function observingSealHost(inner: RoleTurnHost, seen: SeenTurn[]): RoleTurnHost {
  return {
    executeTurn: async (request) => {
      const sourceRun =
        request.activation.role === "notary" ? request.activation.sourceRun : undefined;
      seen.push({
        runId: runIdFromDirectory(request.runDirectory),
        runDirectory: request.runDirectory,
        kind: request.continuation.kind,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(sourceRun === undefined ? {} : { sourceRun }),
        ...(request.courtAttemptId === undefined
          ? {}
          : { courtAttemptId: request.courtAttemptId }),
      });
      return inner.executeTurn(request);
    },
  };
}

test("#637 public notary via runAkRole: sealed first→re-summons same run with distinct source-run", async () => {
  const scratch = await openNotaryScratch("home-");
  try {
    const { home, project, firstSourcePath, secondSourcePath, io, credentials } = scratch;
    assert.equal(
      (
        await runAkRole(
          ["config", "set", "notary", "faux/birth-model:high"],
          { home, packageRoot, io },
        )
      ).exitCode,
      0,
    );

    const seen: SeenTurn[] = [];
    const sealHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "pass", findings: [] },
      }),
    });
    const host = observingSealHost(sealHost, seen);

    const first = await runAkRole(
      ["notary", "--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a063700-0000-7000-8000-00000000n001",
      },
    );
    assert.equal(first.exitCode, 0, "first sealed notary must accept");
    assert.equal(seen.length, 1, "first public notary must dispatch one turn");
    assert.equal(seen[0]!.kind, "initial", "first summons is initial");
    assert.equal(seen[0]!.model?.model, "birth-model");
    assert.equal(seen[0]!.model?.thinking, "high");
    assert.equal(
      seen[0]!.sourceRun,
      firstSourcePath,
      "first summons activation.sourceRun is the first retained path",
    );
    assert.equal(
      seen[0]!.courtAttemptId,
      undefined,
      "first mint has no court-attempt id (session-stable sole-final)",
    );

    const notaryRunsAfterFirst = (await listBookRunDirs(home)).filter((d) =>
      d.includes("@notary"),
    );
    assert.equal(notaryRunsAfterFirst.length, 1, "first summons creates exactly one notary run");

    assert.equal(
      (
        await runAkRole(
          ["config", "set", "notary", "faux/live-seat-model:low"],
          { home, packageRoot, io },
        )
      ).exitCode,
      0,
    );

    const second = await runAkRole(
      ["notary", "--source-run", `${SECOND_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a063700-0000-7000-8000-00000000n002",
      },
    );
    assert.equal(second.exitCode, 0, "sealed re-summons must still accept on new court turn");
    assert.equal(seen.length, 2, "second public notary must dispatch one turn after seal");
    assert.equal(seen[1]!.kind, "resume", "same-ticket re-summons must resume");
    assert.equal(
      seen[1]!.runDirectory,
      seen[0]!.runDirectory,
      "second summons must continue the same run directory",
    );
    assert.equal(seen[1]!.runId, seen[0]!.runId, "second summons must keep the same run id");
    assert.equal(
      seen[1]!.model?.model,
      "live-seat-model",
      "resume must take the live seat-table model (cli.ts resolveEffectiveSeat)",
    );
    assert.equal(
      seen[1]!.model?.thinking,
      "low",
      "resume must take the live seat-table thinking",
    );
    assert.equal(
      seen[1]!.sourceRun,
      secondSourcePath,
      "second summons activation.sourceRun is the second retained path",
    );
    assert.notEqual(
      seen[1]!.sourceRun,
      seen[0]!.sourceRun,
      "second source-run pointer must differ from the first",
    );
    assert.ok(
      typeof seen[1]!.courtAttemptId === "string" && seen[1]!.courtAttemptId.length > 0,
      "sealed re-summons must carry a courtAttemptId on the request",
    );
    assert.notEqual(
      seen[1]!.courtAttemptId,
      seen[0]!.runId,
      "court-attempt id is not the run id",
    );

    const notaryRunsAfterSecond = (await listBookRunDirs(home)).filter((d) =>
      d.includes("@notary"),
    );
    assert.equal(
      notaryRunsAfterSecond.length,
      1,
      "second summons must not mint a new notary run directory",
    );
  } finally {
    await rm(scratch.home, { recursive: true, force: true });
  }
});

test("#637 public notary: second court no-seal → bare resume continues open court", async () => {
  const scratch = await openNotaryScratch("home-noseal-");
  try {
    const { home, project, secondSourcePath, io, credentials } = scratch;
    assert.equal(
      (
        await runAkRole(["config", "set", "notary", "faux/birth-model:high"], {
          home,
          packageRoot,
          io,
        })
      ).exitCode,
      0,
    );

    const seen: SeenTurn[] = [];
    let turn = 0;
    const inner = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (extraArgs, options) => {
        turn += 1;
        if (turn === 1) {
          return scriptedTerminatingToolSession({
            role: "notary",
            toolName: NOTARY_OUTPUT_TOOL_NAME,
            details: { status: "pass", findings: [] },
          })(extraArgs, options);
        }
        if (turn === 2) {
          // Second court: runner exits cleanly without sealing — prior pass must not wash.
          return scriptedTerminatingToolSession({
            role: "notary",
            toolName: NOTARY_OUTPUT_TOOL_NAME,
            details: { status: "pass", findings: [] },
            seal: false,
          })(extraArgs, options);
        }
        // Bare resume of open court: seal this court turn.
        return scriptedTerminatingToolSession({
          role: "notary",
          toolName: NOTARY_OUTPUT_TOOL_NAME,
          details: { status: "pass", findings: [] },
        })(extraArgs, options);
      },
    });
    const host = observingSealHost(inner, seen);

    const first = await runAkRole(
      ["notary", "--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a063700-0000-7000-8000-00000000n011",
      },
    );
    assert.equal(first.exitCode, 0, "first sealed notary must accept");
    assert.equal(first.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      first.terminal?.roleOutcome.kind === "accepted"
        ? first.terminal.roleOutcome.status
        : undefined,
      "pass",
    );

    const second = await runAkRole(
      ["notary", "--source-run", `${SECOND_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a063700-0000-7000-8000-00000000n012",
      },
    );
    assert.notEqual(second.exitCode, 0, "second court without seal must not exit as success");
    assert.notEqual(
      second.terminal?.roleOutcome.kind,
      "accepted",
      "second court must not present the first sealed pass",
    );
    assert.equal(turn, 2, "second summons must dispatch a real turn");
    assert.equal(seen.length, 2);
    assert.ok(
      typeof seen[1]!.courtAttemptId === "string" && seen[1]!.courtAttemptId.length > 0,
      "second court opens a courtAttemptId",
    );
    assert.equal(
      seen[1]!.sourceRun,
      secondSourcePath,
      "second court activation carries this summons' source-run",
    );
    const openCourtAttemptId = seen[1]!.courtAttemptId!;
    const runId = seen[0]!.runId;

    // Bare manual resume must continue the open second court — not present first pass.
    const resumed = await runAkRole(["resume", runId], {
      home,
      packageRoot,
      cwd: project,
      credentials,
      io,
      roleTurnHost: host,
    });
    assert.equal(turn, 3, "bare resume must dispatch a real continuation turn");
    assert.equal(seen.length, 3, "bare resume must observe one more turn request");
    assert.equal(seen[2]!.kind, "resume", "bare resume continuation kind is resume");
    assert.equal(
      seen[2]!.runDirectory,
      seen[0]!.runDirectory,
      "bare resume stays on the same run directory",
    );
    assert.equal(
      seen[2]!.courtAttemptId,
      openCourtAttemptId,
      "bare resume must continue the open courtAttemptId, not mint a new court",
    );
    assert.equal(
      seen[2]!.sourceRun,
      secondSourcePath,
      "bare resume must keep open-court source-run, not birth source-run",
    );
    assert.equal(resumed.exitCode, 0, "open-court resume that seals must accept");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? resumed.terminal.roleOutcome.status
        : undefined,
      "pass",
    );

    // After open court seals, further bare resume is run-scoped sealed-idempotent (no new turn).
    const turnsBeforeIdempotent = turn;
    const idempotent = await runAkRole(["resume", runId], {
      home,
      packageRoot,
      cwd: project,
      credentials,
      io,
      roleTurnHost: host,
    });
    assert.equal(
      turn,
      turnsBeforeIdempotent,
      "sealed bare resume must not dispatch another turn",
    );
    assert.equal(idempotent.exitCode, 0);
    assert.equal(idempotent.terminal?.roleOutcome.kind, "accepted");
  } finally {
    await rm(scratch.home, { recursive: true, force: true });
  }
});
