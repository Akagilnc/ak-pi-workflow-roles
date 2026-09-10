/**
 * #637 — one public-entry tracer via runAkRole (cli.ts seat-table resolution):
 * first summons mints + seals pass → seat-table switch → same-ticket re-summons
 * resume that run under the live seat-table model with a new court attempt and
 * different source-run material (second court does not seal) → bare resume
 * continues the open court and seals a lawful non-pass status → further bare
 * resume after seal still reaches the host (pass-through #833).
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
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  acquireRunWriterLease,
  readCurrentCourt,
} from "../../src/public-cli/run-lifecycle.ts";
import {
  installGhFixture,
} from "../helpers/hermes-fixture.ts";
import { payloadFacts, payloadStatus } from "../helpers/terminal-payload.ts";
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

/**
 * Find a frozen attachment file by content under a run's attachments tree.
 * #836: presenting a same-parent no-new-seal court as accepted (ledger
 * honesty) clears currentCourt immediately — the admission-time attachment
 * freeze itself already happened and is durable on disk regardless, so its
 * identity is recovered from the tree directly rather than from
 * currentCourt.summons.attachmentPaths (gone once the court clears).
 */
async function findFrozenAttachmentWithContent(
  dir: string,
  content: string,
): Promise<string | undefined> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await findFrozenAttachmentWithContent(full, content);
      if (nested !== undefined) return nested;
    } else {
      const text = await readFile(full, "utf8").catch(() => undefined);
      if (text === content) return full;
    }
  }
  return undefined;
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
          // Cross-parent mint under the same ticket (#747): seal pass on a new run.
          return scriptedTerminatingToolSession({
            role: "notary",
            toolName: NOTARY_OUTPUT_TOOL_NAME,
            details: { status: "pass", findings: [] },
          })(extraArgs, options);
        }
        if (turn === 3) {
          // Same-parent court: exit without sealing — prior pass must not wash.
          return scriptedTerminatingToolSession({
            role: "notary",
            toolName: NOTARY_OUTPUT_TOOL_NAME,
            details: { status: "pass", findings: [] },
            seal: false,
          })(extraArgs, options);
        }
        if (turn === 4) {
          // Bare resume of open court: seal this court turn with lawful non-pass.
          return scriptedTerminatingToolSession({
            role: "notary",
            toolName: NOTARY_OUTPUT_TOOL_NAME,
            details: secondCourtSeal,
          })(extraArgs, options);
        }
        // Bare resume after sealed court: pass-through, no re-seal (#833).
        return scriptedTerminatingToolSession({
          role: "notary",
          toolName: NOTARY_OUTPUT_TOOL_NAME,
          details: secondCourtSeal,
          seal: false,
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
        ? payloadStatus(first.terminal.roleOutcome)
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
    const firstRunId = seen[0]!.runId;
    const firstRunDirectory = seen[0]!.runDirectory;

    const notaryRunsAfterFirst = (await listBookRunDirs(home)).filter((d) =>
      d.includes("@notary"),
    );
    assert.equal(notaryRunsAfterFirst.length, 1, "first summons creates exactly one notary run");

    // 2) Same-ticket distinct parent ordinary summons must mint (#747) — old ticket key would resume.
    const crossParent = await runAkRole(
      ["notary", "--source-run", `${SECOND_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a063700-0000-7000-8000-00000000n0cp",
      },
    );
    assert.equal(crossParent.exitCode, 0, "distinct-parent ordinary summons must mint and seal");
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.kind, "initial", "distinct parent must not resume the first run");
    assert.notEqual(seen[1]!.runId, firstRunId);
    assert.notEqual(seen[1]!.runDirectory, firstRunDirectory);
    assert.equal(seen[1]!.sourceRun, secondSourcePath);
    const notaryRunsAfterCross = (await listBookRunDirs(home)).filter((d) =>
      d.includes("@notary"),
    );
    assert.equal(
      notaryRunsAfterCross.length,
      2,
      "same-ticket distinct parent must leave two notary run directories",
    );

    // 3) Live seat-table switch before same-parent re-summons (#747).
    assert.equal(
      (
        await runAkRole(
          ["config", "set", "notary", "faux/live-seat-model:low"],
          { home, packageRoot, io },
        )
      ).exitCode,
      0,
    );

    // 4) Same parent (--source-run) court on the first leg: resume, no seal → not pass.
    const second = await runAkRole(
      ["notary", "--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
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
    // #836: courtAttempt is a recording tag, not a visibility gate — a
    // same-parent court that dispatches without recording a new submission
    // still honestly presents whatever the run's ledger already holds (the
    // first court's sealed pass), not an invented "not accepted" status.
    assert.equal(second.exitCode, 0, "same-parent court without a new seal still presents the run's ledger honestly");
    assert.equal(
      second.terminal?.roleOutcome.kind,
      "accepted",
      "ledger still holds the first court's accepted payload",
    );
    assert.equal(
      second.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatus(second.terminal.roleOutcome)
        : undefined,
      "pass",
      "presented payload is the first court's pass — never re-invented for the new court",
    );
    assert.equal(turn, 3, "same-parent court must dispatch a real turn");
    assert.equal(seen.length, 3, "same-parent court must dispatch one turn after cross-parent mint");
    assert.equal(seen[2]!.kind, "resume", "same-parent re-summons must resume");
    assert.equal(
      seen[2]!.runDirectory,
      firstRunDirectory,
      "same-parent summons continues the first parent run, not the cross-parent mint",
    );
    assert.equal(seen[2]!.runId, firstRunId, "same-parent summons must keep the first run id");
    assert.equal(
      seen[2]!.model?.model,
      "live-seat-model",
      "resume must take the live seat-table model (cli.ts resolveEffectiveSeat)",
    );
    assert.equal(
      seen[2]!.model?.thinking,
      "low",
      "resume must take the live seat-table thinking",
    );
    assert.equal(
      seen[2]!.sourceRun,
      firstSourcePath,
      "same-parent resume keeps the parent source-run path",
    );
    assert.ok(
      typeof seen[2]!.courtAttemptId === "string" && seen[2]!.courtAttemptId.length > 0,
      "sealed re-summons must carry a courtAttemptId on the request",
    );
    assert.notEqual(
      seen[2]!.courtAttemptId,
      firstRunId,
      "court-attempt id is not the run id",
    );

    const notaryRunsAfterSameParent = (await listBookRunDirs(home)).filter((d) =>
      d.includes("@notary"),
    );
    assert.equal(
      notaryRunsAfterSameParent.length,
      2,
      "same-parent court must not mint a third notary run directory",
    );

    const openCourtAttemptId = seen[2]!.courtAttemptId!;
    const runId = firstRunId;

    // 5) Bare manual resume continues the open court — not prior seal.
    const resumed = await runAkRole(["resume", runId], {
      home,
      packageRoot,
      cwd: project,
      credentials,
      io,
      roleTurnHost: host,
    });
    assert.equal(turn, 4, "bare resume must dispatch a real continuation turn");
    assert.equal(seen.length, 4, "bare resume must observe one more turn request");
    assert.equal(seen[3]!.kind, "resume", "bare resume continuation kind is resume");
    assert.equal(
      seen[3]!.runDirectory,
      firstRunDirectory,
      "bare resume stays on the same run directory",
    );
    // #836: presenting the same-parent court's dispatch as accepted (step 4)
    // already cleared that court's current-court marker — same as any other
    // accepted presentation does. This bare resume therefore reaches the
    // host as a plain post-terminal pass-through (#833), not a continuation
    // of a still-open court; courtAttemptId is a recording tag, not a
    // continuity invariant code enforces.
    assert.equal(
      seen[3]!.courtAttemptId,
      undefined,
      "bare resume after an already-presented-accepted court is a pass-through, not an open-court continuation",
    );
    assert.equal(
      seen[3]!.sourceRun,
      firstSourcePath,
      "bare resume must keep the same-parent source-run",
    );
    assert.equal(resumed.exitCode, 0, "open-court resume that seals must accept");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      resumed.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatus(resumed.terminal.roleOutcome)
        : undefined,
      secondCourtSeal.status,
      "open-court seal status must be the lawful non-pass, not first-court pass",
    );

    // 6) After open court seals non-pass, further bare resume still reaches the
    // host (#833 pass-through). No re-seal → settlement keeps the open-court status.
    const turnsBeforeBare = turn;
    const bareAfterSeal = await runAkRole(["resume", runId], {
      home,
      packageRoot,
      cwd: project,
      credentials,
      io,
      roleTurnHost: host,
    });
    assert.equal(
      turn,
      turnsBeforeBare + 1,
      "sealed bare resume must reach the host",
    );
    assert.equal(bareAfterSeal.exitCode, 0);
    assert.equal(bareAfterSeal.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      bareAfterSeal.terminal?.roleOutcome.kind === "accepted"
        ? payloadStatus(bareAfterSeal.terminal.roleOutcome)
        : undefined,
      secondCourtSeal.status,
      "bare resume after seal keeps the open-court non-pass status",
    );
  } finally {
    await rm(scratch.home, { recursive: true, force: true });
    await rm(WORKTREE_SCRATCH, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("#637 public inspector: freeze-once attachment identity survives a no-seal court and a fresh resume-with-message court", async () => {
  await mkdir(WORKTREE_SCRATCH, { recursive: true });
  const home = await mkdtemp(join(WORKTREE_SCRATCH, "home-materials-"));
  const priorPath = process.env.PATH;
  try {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const parentRunPath = await seedCanonicalSourceRun(home, project, {
      ticketNumber: 637,
    });
    const otherParentRunPath = await seedCanonicalSourceRun(home, project, {
      runId: SECOND_SOURCE_RUN_ID,
      ticketNumber: 637,
      sessionContent: "other parent",
    });
    const binDir = join(home, "bin");
    await mkdir(binDir, { recursive: true });
    // Worktree-owned home walks up to package.json type:module; force CJS for fixture bins.
    await writeFile(join(binDir, "package.json"), '{"type":"commonjs"}\n', "utf8");
    // Gate inspector instruction is 卷宗指针 only (#747); no seat ticket recognizer.
    await installGhFixture(binDir, {
      issues: { 637: { body: "#637 materials court", comments: [] } },
    });
    process.env.PATH = `${binDir}:${priorPath ?? ""}`;


    const external = join(home, "external-attachment.md");
    await writeFile(external, "court-material-v1\n", "utf8");
    const instruction = `卷宗指针：${parentRunPath}`;
    const otherInstruction = `卷宗指针：${otherParentRunPath}`;
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
          // Cross-parent mint under the same ticket (#747).
          return scriptedTerminatingToolSession({
            role: "inspector",
            toolName: INSPECTOR_OUTPUT_TOOL_NAME,
            details: { status: "pass", findings: [] },
          })(extraArgs, options);
        }
        if (turn === 3) {
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

    // 2) Same-ticket distinct parent 卷宗指针 must mint (#747).
    const crossParent = await runAkRole(
      ["inspector", otherInstruction, "--attach", external],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a063700-0000-7000-8000-00000000i0cp",
      },
    );
    assert.equal(crossParent.exitCode, 0, "distinct-parent inspector must mint and seal");
    assert.equal(seen[1]!.kind, "initial", "distinct parent must not resume");
    assert.notEqual(seen[1]!.runId, runId);
    const inspectorRunsAfterCross = (await listBookRunDirs(home)).filter((d) =>
      d.includes("@inspector"),
    );
    assert.equal(
      inspectorRunsAfterCross.length,
      2,
      "same-ticket distinct parent must leave two inspector run directories",
    );

    // 3) Same-parent (卷宗指针) re-summons opens a new court with attachment materials (no seal).
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
    // #836: courtAttempt is a recording tag, not a visibility gate — a
    // same-parent court that dispatches without recording a new submission
    // still honestly presents whatever the run's ledger already holds.
    assert.equal(second.exitCode, 0, "same-parent court without a new seal still presents the run's ledger honestly");
    assert.equal(second.terminal?.roleOutcome.kind, "accepted", "ledger still holds the first court's accepted payload");
    assert.equal(seen.length, 3);
    assert.equal(seen[2]!.kind, "resume");
    assert.equal(seen[2]!.runDirectory, runDirectory);
    assert.ok(
      typeof seen[2]!.courtAttemptId === "string" && seen[2]!.courtAttemptId.length > 0,
    );
    const openCourtAttemptId = seen[2]!.courtAttemptId!;

    // #836: presenting the same-parent court's dispatch as accepted already
    // cleared its current-court marker (same as any other accepted
    // presentation). The admission-time attachment freeze itself already
    // happened and is durable on disk regardless — recover its identity from
    // the tree directly rather than from currentCourt (now gone).
    assert.equal(
      await readCurrentCourt(runDirectory),
      undefined,
      "presenting the ledger's accepted payload clears currentCourt, same as any other accepted presentation",
    );
    const frozenPath = await findFrozenAttachmentWithContent(
      join(runDirectory, "attachments"),
      "court-material-v1\n",
    );
    assert.ok(frozenPath !== undefined, "admission-time freeze must be durable on disk");
    assert.ok(
      frozenPath!.startsWith(join(runDirectory, "attachments")),
      "frozen attachment must be the in-run freeze identity",
    );
    assert.notEqual(frozenPath, external, "frozen attachment must not keep the external original path");

    const freezeDirsAfterOpen = await readdir(join(runDirectory, "attachments"));
    // birth admit freeze + one summons freeze directory
    assert.ok(freezeDirsAfterOpen.length >= 1);

    // External original changes after the court accepted the freeze snapshot.
    await writeFile(external, "external-changed-after-freeze\n", "utf8");
    await rm(external, { force: true });

    // 4) Resume with a caller message after an already-presented-accepted
    // court dispatches a new court (#833) — the prior court already closed
    // when step 3 presented its accepted payload, so this mints its own
    // fresh courtAttemptId rather than continuing the closed one.
    const resumed = await runAkRole(["resume", runId, "caller-resume-message"], {
      home,
      packageRoot,
      cwd: project,
      credentials,
      io,
      roleTurnHost: host,
    });
    assert.equal(turn, 4, "resume with message must dispatch a real turn");
    assert.equal(seen.length, 4);
    assert.equal(seen[3]!.kind, "resume");
    assert.ok(
      typeof seen[3]!.courtAttemptId === "string" && seen[3]!.courtAttemptId.length > 0,
      "resume with message mints its own court",
    );
    assert.notEqual(
      seen[3]!.courtAttemptId,
      openCourtAttemptId,
      "the closed court from step 3 is not reopened — this is a fresh court",
    );
    assert.equal(seen[3]!.runDirectory, runDirectory);
    assert.equal(resumed.exitCode, 0, "new-court resume on frozen materials must accept");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");

    // Reuse must not mint another summons freeze directory from the missing external path.
    const freezeDirsAfterResume = await readdir(join(runDirectory, "attachments"));
    assert.equal(
      freezeDirsAfterResume.length,
      freezeDirsAfterOpen.length,
      "resume must reuse frozen paths; no additional freeze directory",
    );
    assert.equal(
      await readFile(frozenPath!, "utf8"),
      "court-material-v1\n",
      "accepted freeze snapshot bytes must remain",
    );
    assert.equal(
      await readCurrentCourt(runDirectory),
      undefined,
      "sealed new court clears currentCourt",
    );
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    await rm(home, { recursive: true, force: true });
    await rm(WORKTREE_SCRATCH, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("#675/#637 public auditor: same-parent re-summons resume prior run under live seat axes", async () => {
  const scratch = await openNotaryScratch("home-auditor-");
  try {
    const { home, project, firstSourcePath, secondSourcePath, io, credentials } = scratch;
    // Auditor resume key is --source-run parent path (#747), not ticket number.
    assert.equal(
      (
        await runAkRole(
          ["config", "set", "auditor", "faux/birth-auditor:high"],
          { home, packageRoot, io },
        )
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
            role: "auditor",
            toolName: AUDITOR_OUTPUT_TOOL_NAME,
            details: {
              status: "pass",
              violations: [],
              conflicts: [],
              decisionGate: null,
            },
          })(extraArgs, options);
        }
        if (turn === 2) {
          // Same-parent court: exit without seal so prior pass does not wash.
          return scriptedTerminatingToolSession({
            role: "auditor",
            toolName: AUDITOR_OUTPUT_TOOL_NAME,
            details: {
              status: "pass",
              violations: [],
              conflicts: [],
              decisionGate: null,
            },
            seal: false,
          })(extraArgs, options);
        }
        // Distinct-parent mint under the same ticket (#747).
        return scriptedTerminatingToolSession({
          role: "auditor",
          toolName: AUDITOR_OUTPUT_TOOL_NAME,
          details: {
            status: "pass",
            violations: [],
            conflicts: [],
            decisionGate: null,
          },
        })(extraArgs, options);
      },
    });
    const host = observingSealHost(inner, seen);

    const first = await runAkRole(
      [
        "auditor",
        "--subject",
        "judge",
        "--source-run",
        `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`,
        "审：本 run 是否合规。",
      ],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a067500-0000-7000-8000-00000000a001",
      },
    );
    assert.equal(first.exitCode, 0, "first sealed auditor must accept");
    assert.equal(first.terminal?.roleOutcome.kind, "accepted");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.kind, "initial");
    assert.equal(seen[0]!.model?.model, "birth-auditor");
    assert.equal(seen[0]!.model?.thinking, "high");

    const auditorRunsAfterFirst = (await listBookRunDirs(home)).filter((d) =>
      d.includes("@auditor"),
    );
    assert.equal(auditorRunsAfterFirst.length, 1, "first auditor summons mints exactly one run");

    // Live seat-table switch before same-parent re-summons (#697 axes on resume).
    assert.equal(
      (
        await runAkRole(
          ["config", "set", "auditor", "faux/live-auditor:low"],
          { home, packageRoot, io },
        )
      ).exitCode,
      0,
    );

    const firstRunId = seen[0]!.runId;
    const firstRunDirectory = seen[0]!.runDirectory;

    // Same parent --source-run → resume.
    const second = await runAkRole(
      [
        "auditor",
        "--subject",
        "judge",
        "--source-run",
        `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`,
        "审：二次传召。",
      ],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a067500-0000-7000-8000-00000000a002",
      },
    );
    // #836: courtAttempt is a recording tag, not a visibility gate — a
    // same-parent court that dispatches without recording a new submission
    // still honestly presents whatever the run's ledger already holds.
    assert.equal(second.exitCode, 0, "second court without a new seal still presents the run's ledger honestly");
    assert.equal(second.terminal?.roleOutcome.kind, "accepted", "ledger still holds the first court's accepted payload");
    assert.equal(turn, 2, "second auditor summons must dispatch a real turn");
    assert.equal(seen.length, 2);
    assert.equal(seen[1]!.kind, "resume", "same-parent auditor re-summons must resume");
    assert.equal(
      seen[1]!.runDirectory,
      firstRunDirectory,
      "second auditor summons continues the same run directory",
    );
    assert.equal(seen[1]!.runId, firstRunId);
    assert.equal(
      seen[1]!.model?.model,
      "live-auditor",
      "resume must take live seat-table model",
    );
    assert.equal(
      seen[1]!.model?.thinking,
      "low",
      "resume must take live seat-table thinking",
    );
    assert.ok(
      typeof seen[1]!.courtAttemptId === "string" && seen[1]!.courtAttemptId.length > 0,
      "sealed re-summons must open a courtAttemptId",
    );

    const auditorRunsAfterSecond = (await listBookRunDirs(home)).filter((d) =>
      d.includes("@auditor"),
    );
    assert.equal(
      auditorRunsAfterSecond.length,
      1,
      "same-parent second auditor summons must not mint a new run directory",
    );

    // Same-ticket distinct parent ordinary summons must mint (#747) — old ticket key would resume.
    const crossParent = await runAkRole(
      [
        "auditor",
        "--subject",
        "judge",
        "--source-run",
        `${SECOND_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`,
        "审：换父腿。",
      ],
      {
        home,
        packageRoot,
        cwd: project,
        credentials,
        io,
        roleTurnHost: host,
        createRunId: () => "01a067500-0000-7000-8000-00000000a003",
      },
    );
    assert.equal(crossParent.exitCode, 0, "distinct-parent auditor must mint and seal");
    assert.equal(seen[seen.length - 1]!.kind, "initial", "distinct parent must not resume");
    assert.notEqual(seen[seen.length - 1]!.runId, firstRunId);
    const auditorRunsAfterCross = (await listBookRunDirs(home)).filter((d) =>
      d.includes("@auditor"),
    );
    assert.equal(
      auditorRunsAfterCross.length,
      2,
      "same-ticket distinct parent must leave two auditor run directories",
    );
    void firstSourcePath;
    void secondSourcePath;
  } finally {
    await rm(scratch.home, { recursive: true, force: true });
    await rm(WORKTREE_SCRATCH, { recursive: true, force: true }).catch(() => undefined);
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

    // 2) Explicit fresh summons: same parent, new verb → distinct run (explicit-fresh-summons).
    const fresh = await runAkRole(
      [
        "new",
        "notary",
        "--source-run",
        `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`,
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
    assert.equal(seen[1]!.sourceRun, firstSourcePath);
    const freshRunId = seen[1]!.runId;
    const freshRunDirectory = seen[1]!.runDirectory;

    const notaryRuns = (await listBookRunDirs(home)).filter((d) => d.includes("@notary"));
    assert.equal(notaryRuns.length, 2, "ordinary + new must leave two notary run directories");

    // 3) Ordinary same-parent summons auto-resumes the latest leg under that parent
    // (explicit-fresh-summons + #747 parent key — not the birth leg).
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
    assert.equal(third.exitCode, 0, "auto-resume of latest same-parent leg must accept");
    assert.equal(seen.length, 3, "third summons must dispatch one resume turn");
    assert.equal(seen[2]!.kind, "resume", "ordinary same-parent re-summons still auto-resumes");
    assert.equal(seen[2]!.runId, freshRunId, "auto-resume must track the latest same-parent leg");
    assert.equal(seen[2]!.runDirectory, freshRunDirectory);
    assert.notEqual(seen[2]!.runId, firstRunId);
    void secondSourcePath;
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

    // Same parent path so lookup resumes into the leased run (#747).
    const blocked = await runAkRole(
      ["notary", "--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
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
    await rm(WORKTREE_SCRATCH, { recursive: true, force: true }).catch(() => undefined);
  }
});
