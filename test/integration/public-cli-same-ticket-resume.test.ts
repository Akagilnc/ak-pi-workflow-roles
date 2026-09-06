/**
 * #637 — one public-entry tracer via runAkRole (cli.ts seat-table resolution):
 * first summons mints + seals pass → seat-table switch → same-ticket re-summons
 * resume that run under the live seat-table model with a new court attempt and
 * different source-run material (second court does not seal) → bare resume
 * continues the open court and seals a lawful non-pass status → further bare
 * resume is sealed-idempotent on that same non-pass status.
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
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { ensureTicketProvenanceVolume } from "../../src/ticket-provenance.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  acquireRunWriterLease,
  readCurrentCourt,
} from "../../src/public-cli/run-lifecycle.ts";
import {
  installGhFixture,
  installHermesFixture,
} from "../helpers/hermes-fixture.ts";
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

test("#637 public notary tracer: first seal → seat switch → second court no-seal → bare resume non-pass → idempotent", async () => {
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

    /** Lawful non-pass seal for the open second court (distinct from first pass). */
    const secondCourtSeal = {
      status: "bounce" as const,
      disposition: "rewrite" as const,
      findings: ["second-court-non-pass"],
    };

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
        // Bare resume of open court: seal this court turn with lawful non-pass.
        return scriptedTerminatingToolSession({
          role: "notary",
          toolName: NOTARY_OUTPUT_TOOL_NAME,
          details: secondCourtSeal,
        })(extraArgs, options);
      },
    });
    const host = observingSealHost(inner, seen);

    // 1) First summons seals pass on a fresh run.
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
    assert.equal(first.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      first.terminal?.roleOutcome.kind === "accepted"
        ? first.terminal.roleOutcome.status
        : undefined,
      "pass",
    );
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

    // 2) Live seat-table switch before same-ticket re-summons.
    assert.equal(
      (
        await runAkRole(
          ["config", "set", "notary", "faux/live-seat-model:low"],
          { home, packageRoot, io },
        )
      ).exitCode,
      0,
    );

    // 3) Second court: resume same run, distinct source-run, no seal → not pass.
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
    assert.notEqual(second.exitCode, 0, "second court without seal must not exit as success");
    assert.notEqual(
      second.terminal?.roleOutcome.kind,
      "accepted",
      "second court must not present the first sealed pass",
    );
    assert.equal(turn, 2, "second summons must dispatch a real turn");
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

    const openCourtAttemptId = seen[1]!.courtAttemptId!;
    const runId = seen[0]!.runId;

    // 4) Bare manual resume continues the open second court — not prior seal.
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
      secondCourtSeal.status,
      "open-court seal status must be the lawful non-pass, not first-court pass",
    );

    // 5) After open court seals non-pass, further bare resume is run-scoped
    // sealed-idempotent on that same status (not the first-court pass).
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
    assert.equal(
      idempotent.terminal?.roleOutcome.kind === "accepted"
        ? idempotent.terminal.roleOutcome.status
        : undefined,
      secondCourtSeal.status,
      "idempotent bare resume must present the open-court non-pass status",
    );
  } finally {
    await rm(scratch.home, { recursive: true, force: true });
  }
});

test("#637 public inspector: freeze-once currentCourt + bare resume message keeps open court", async () => {
  await mkdir(WORKTREE_SCRATCH, { recursive: true });
  const home = await mkdtemp(join(WORKTREE_SCRATCH, "home-materials-"));
  const priorPath = process.env.PATH;
  try {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const binDir = join(home, "bin");
    await mkdir(binDir, { recursive: true });
    // Worktree-owned home walks up to package.json type:module; force CJS for fixture bins.
    await writeFile(join(binDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
    await installHermesFixture(binDir);
    // #709: same-ticket resume reuses an identity this book already records.
    ensureTicketProvenanceVolume(637, project, home);
    await installGhFixture(binDir, {
      issues: { 637: { body: "#637 materials court", comments: [] } },
    });
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;


    const external = join(home, "external-attachment.md");
    await writeFile(external, "court-material-v1\n", "utf8");
    const instruction = "inspect ticket #637 materials";
    const io = { stdout: (_t: string) => {}, stderr: (_t: string) => {} };
    const credentials = { "openai-codex": true, xai: true } as const;

    const seen: SeenTurn[] = [];
    let turn = 0;
    const inner = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (extraArgs, options) => {
        turn += 1;
        if (turn === 1) {
          return scriptedTerminatingToolSession({
            role: "inspector",
            toolName: INSPECTOR_OUTPUT_TOOL_NAME,
            details: { status: "pass", findings: [] },
          })(extraArgs, options);
        }
        if (turn === 2) {
          return scriptedTerminatingToolSession({
            role: "inspector",
            toolName: INSPECTOR_OUTPUT_TOOL_NAME,
            details: { status: "pass", findings: [] },
            seal: false,
          })(extraArgs, options);
        }
        return scriptedTerminatingToolSession({
          role: "inspector",
          toolName: INSPECTOR_OUTPUT_TOOL_NAME,
          details: { status: "pass", findings: [] },
        })(extraArgs, options);
      },
    });
    const host = observingSealHost(inner, seen);

    // 1) First inspector summons seals (birth freeze under admitted attachments).
    const first = await runAkRole(
      ["inspector", instruction, "--attach", external],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a063700-0000-7000-8000-00000000i001",
      },
    );
    assert.equal(first.exitCode, 0, "first sealed inspector must accept");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.kind, "initial");
    const runDirectory = seen[0]!.runDirectory;
    const runId = seen[0]!.runId;

    // 2) Same-ticket re-summons opens a new court with attachment materials (no seal).
    const second = await runAkRole(
      ["inspector", instruction, "--attach", external],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a063700-0000-7000-8000-00000000i002",
      },
    );
    assert.notEqual(second.exitCode, 0, "second court without seal must not succeed");
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.kind, "resume");
    assert.equal(seen[1]!.runDirectory, runDirectory);
    assert.ok(
      typeof seen[1]!.courtAttemptId === "string" && seen[1]!.courtAttemptId.length > 0,
    );
    const openCourtAttemptId = seen[1]!.courtAttemptId!;

    const openCourt = await readCurrentCourt(runDirectory);
    assert.ok(openCourt !== undefined, "unsealed second court must persist currentCourt");
    assert.equal(openCourt!.courtAttemptId, openCourtAttemptId);
    const frozenPaths = openCourt!.summons?.attachmentPaths ?? [];
    assert.equal(frozenPaths.length, 1, "currentCourt must carry this court\'s attachment identity");
    assert.ok(
      frozenPaths[0]!.startsWith(join(runDirectory, "attachments")),
      "currentCourt attachmentPaths must be the in-run freeze identity",
    );
    assert.notEqual(
      frozenPaths[0],
      external,
      "currentCourt must not keep the external original path",
    );
    assert.equal(await readFile(frozenPaths[0]!, "utf8"), "court-material-v1\n");

    const freezeDirsAfterOpen = await readdir(join(runDirectory, "attachments"));
    // birth admit freeze + one summons freeze directory
    assert.ok(freezeDirsAfterOpen.length >= 1);

    // External original changes after the court accepted the freeze snapshot.
    await writeFile(external, "external-changed-after-freeze\n", "utf8");
    await rm(external, { force: true });

    // 3) Bare resume with caller message continues open court on frozen materials.
    const resumed = await runAkRole(["resume", runId, "caller-resume-message"], {
      home,
      packageRoot,
      cwd: project,
      credentials,
      io,
      roleTurnHost: host,
    });
    assert.equal(turn, 3, "bare resume with message must dispatch a real turn");
    assert.equal(seen.length, 3);
    assert.equal(seen[2]!.kind, "resume");
    assert.equal(
      seen[2]!.courtAttemptId,
      openCourtAttemptId,
      "caller message resume must continue the open courtAttemptId",
    );
    assert.equal(seen[2]!.runDirectory, runDirectory);
    assert.equal(resumed.exitCode, 0, "open-court resume on frozen materials must accept");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");

    // Reuse must not mint another summons freeze directory from the missing external path.
    const freezeDirsAfterResume = await readdir(join(runDirectory, "attachments"));
    assert.equal(
      freezeDirsAfterResume.length,
      freezeDirsAfterOpen.length,
      "bare resume must reuse frozen paths; no additional freeze directory",
    );
    assert.equal(
      await readFile(frozenPaths[0]!, "utf8"),
      "court-material-v1\n",
      "accepted freeze snapshot bytes must remain",
    );
    assert.equal(
      await readCurrentCourt(runDirectory),
      undefined,
      "sealed open court clears currentCourt",
    );
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    await rm(home, { recursive: true, force: true });
  }
});

test("#724 public new: same-ticket mint stays; explicit new mints fresh; later auto-resume tracks latest", async () => {
  const scratch = await openNotaryScratch("home-new-");
  try {
    const { home, project, firstSourcePath, secondSourcePath, io, credentials } = scratch;
    const seen: SeenTurn[] = [];
    const inner = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "pass", findings: [] },
      }),
    });
    const host = observingSealHost(inner, seen);

    // 1) Ordinary same-ticket summons mints the first run.
    const first = await runAkRole(
      ["notary", "--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a072400-0000-7000-8000-00000000n001",
      },
    );
    assert.equal(first.exitCode, 0, "first sealed notary must accept");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.kind, "initial");
    assert.equal(seen[0]!.sourceRun, firstSourcePath);
    const firstRunId = seen[0]!.runId;
    const firstRunDirectory = seen[0]!.runDirectory;

    // 2) Explicit fresh summons: same ticket, new verb → distinct run, not resume.
    const fresh = await runAkRole(
      [
        "new",
        "notary",
        "--source-run",
        `${SECOND_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`,
      ],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a072400-0000-7000-8000-00000000n002",
      },
    );
    assert.equal(fresh.exitCode, 0, "ak-role new notary must accept as a fresh mint");
    assert.equal(seen.length, 2, "new must dispatch its own turn");
    assert.equal(seen[1]!.kind, "initial", "new must not resume the prior run");
    assert.notEqual(seen[1]!.runId, firstRunId, "new must mint a different runId");
    assert.notEqual(
      seen[1]!.runDirectory,
      firstRunDirectory,
      "new must own an independent run directory",
    );
    assert.equal(seen[1]!.sourceRun, secondSourcePath);
    const freshRunId = seen[1]!.runId;
    const freshRunDirectory = seen[1]!.runDirectory;

    const notaryRuns = (await listBookRunDirs(home)).filter((d) => d.includes("@notary"));
    assert.equal(notaryRuns.length, 2, "ordinary + new must leave two notary run directories");

    // 3) Later ordinary same-ticket summons auto-resumes the latest (the new leg).
    const third = await runAkRole(
      ["notary", "--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a072400-0000-7000-8000-00000000n003",
      },
    );
    assert.equal(third.exitCode, 0, "auto-resume of latest leg must accept");
    assert.equal(seen.length, 3, "third summons must dispatch one resume turn");
    assert.equal(seen[2]!.kind, "resume", "ordinary re-summons still auto-resumes");
    assert.equal(seen[2]!.runId, freshRunId, "auto-resume must track the latest run, not the first");
    assert.equal(seen[2]!.runDirectory, freshRunDirectory);
    assert.notEqual(seen[2]!.runId, firstRunId);
  } finally {
    await rm(scratch.home, { recursive: true, force: true });
  }
});

test("#637 held writer lease: re-summons must not record a new currentCourt", async () => {
  const scratch = await openNotaryScratch("home-lease-");
  let heldLease: Awaited<ReturnType<typeof acquireRunWriterLease>> | undefined;
  try {
    const { home, project, io, credentials } = scratch;
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
        createRunId: () => "01a063700-0000-7000-8000-00000000n021",
      },
    );
    assert.equal(first.exitCode, 0);
    assert.equal(seen.length, 1);
    const runDirectory = seen[0]!.runDirectory;

    assert.equal(
      await readCurrentCourt(runDirectory),
      undefined,
      "sealed first court leaves no open currentCourt",
    );

    heldLease = await acquireRunWriterLease(runDirectory);

    const blocked = await runAkRole(
      ["notary", "--source-run", `${SECOND_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a063700-0000-7000-8000-00000000n022",
      },
    );
    assert.notEqual(blocked.exitCode, 0, "held lease must reject the re-summons");
    assert.equal(
      seen.length,
      1,
      "held lease must not dispatch a second court turn",
    );
    assert.equal(
      await readCurrentCourt(runDirectory),
      undefined,
      "held-lease rejection must not persist a new currentCourt before acquire",
    );
  } finally {
    if (heldLease !== undefined) await heldLease.release();
    await rm(scratch.home, { recursive: true, force: true });
  }
});
