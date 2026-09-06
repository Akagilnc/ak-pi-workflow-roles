/**
 * #637 — one public-entry tracer via runAkRole (cli.ts seat-table resolution):
 * first summons mints a run; same-ticket re-summons resume that run under the
 * live seat-table model. Temp home is worktree-owned and always cleaned.
 *
 * Host is a minimal request observer (not a Pi restore mock). Settlement may be
 * failure without a sealed receipt — the contract is same-run routing + seat
 * axes on the projected request after cli.ts resolveEffectiveSeat.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { RoleTurnRequest } from "../../src/host-contracts.ts";
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
import { createMinimalHost } from "../helpers/role-turn-host-fixture.ts";

/** Worktree-owned scratch root — deletion boundary is this tree only. */
const WORKTREE_SCRATCH = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".tmp-same-ticket-resume",
);

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

/** Materialize the principal session file so resume availability checks pass. */
async function ensureSessionPrincipal(sessionFile: string): Promise<void> {
  await mkdir(dirname(sessionFile), { recursive: true });
  try {
    await readFile(sessionFile);
  } catch {
    await writeFile(
      sessionFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "test-principal",
        timestamp: "2026-09-06T00:00:00.000Z",
        cwd: "/tmp",
      })}\n`,
      "utf8",
    );
  }
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

test("#637 public notary via runAkRole: first→re-summons resume same run under live seat model", async () => {
  await mkdir(WORKTREE_SCRATCH, { recursive: true });
  const home = await mkdtemp(join(WORKTREE_SCRATCH, "home-"));
  try {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project);
    const admittedPath = join(sourceRunPath, "admitted-request.json");
    const admittedRaw = JSON.parse(await readFile(admittedPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      admittedPath,
      `${JSON.stringify({ ...admittedRaw, ticketNumber: 637 }, null, 2)}\n`,
      "utf8",
    );

    // Seed seat table through the public config entry (cli.ts resolveEffectiveSeat path).
    const io = {
      stdout: (_t: string) => {},
      stderr: (_t: string) => {},
    };
    const credentials = { "openai-codex": true, xai: true } as const;
    assert.equal(
      (
        await runAkRole(
          ["config", "set", "notary", "faux/birth-model:high"],
          { home, packageRoot, io },
        )
      ).exitCode,
      0,
    );

    const seen: Array<{
      runId: string;
      runDirectory: string;
      sessionFile: string;
      kind: RoleTurnRequest["continuation"]["kind"];
      model?: RoleTurnRequest["model"];
      sourceRun?: string;
    }> = [];
    const host = createMinimalHost(async (request) => {
      const sessionFile = piDurablePrincipalAuthority.decode(request.principal).sessionFile;
      await ensureSessionPrincipal(sessionFile);
      const sourceRun =
        request.activation.role === "notary" ? request.activation.sourceRun : undefined;
      seen.push({
        runId: runIdFromDirectory(request.runDirectory),
        runDirectory: request.runDirectory,
        sessionFile,
        kind: request.continuation.kind,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(sourceRun === undefined ? {} : { sourceRun }),
      });
      // No sealed receipt — failure settlement still left the run resumable.
      return { code: 0, stderr: "", timedOut: false };
    });

    await runAkRole(
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
    assert.equal(seen.length, 1, "first public notary must dispatch one turn");
    assert.equal(seen[0]!.kind, "initial", "first summons is initial");
    assert.equal(seen[0]!.model?.model, "birth-model");
    assert.equal(seen[0]!.model?.thinking, "high");
    assert.ok(seen[0]!.sourceRun, "first summons delivers source-run pointer");

    const notaryRunsAfterFirst = (await listBookRunDirs(home)).filter((d) =>
      d.includes("@notary"),
    );
    assert.equal(notaryRunsAfterFirst.length, 1, "first summons creates exactly one notary run");

    // Live seat table drifts before the second summons — still via public config entry.
    assert.equal(
      (
        await runAkRole(
          ["config", "set", "notary", "faux/live-seat-model:low"],
          { home, packageRoot, io },
        )
      ).exitCode,
      0,
    );

    await runAkRole(
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
    assert.equal(seen.length, 2, "second public notary must dispatch one turn");
    assert.equal(seen[1]!.kind, "resume", "same-ticket re-summons must resume");
    assert.equal(
      seen[1]!.runDirectory,
      seen[0]!.runDirectory,
      "second summons must continue the same run directory",
    );
    assert.equal(seen[1]!.runId, seen[0]!.runId, "second summons must keep the same run id");
    assert.equal(
      seen[1]!.sessionFile,
      seen[0]!.sessionFile,
      "second summons must reopen the same session principal",
    );
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
    assert.ok(
      seen[1]!.sourceRun,
      "same-ticket re-summons must still deliver this turn's source-run pointer",
    );
    // Request model is post-cli seat resolution, pre-Pi argv. Pi actual session
    // restore is proven by the role-turn-host always emitting --thinking (and
    // in-process setThinkingLevel) — not by mocking Pi restore here.

    const notaryRunsAfterSecond = (await listBookRunDirs(home)).filter((d) =>
      d.includes("@notary"),
    );
    assert.equal(
      notaryRunsAfterSecond.length,
      1,
      "second summons must not mint a new notary run directory",
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
