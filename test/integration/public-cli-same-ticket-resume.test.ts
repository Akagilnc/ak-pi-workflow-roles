/**
 * #637 — one public-entry tracer: first summons mints a run; same-ticket
 * re-summons resume that run; live seat-table model/thinking ride the resume turn.
 * Temp home stays under os.tmpdir; this suite does not delete it (deletion
 * boundary = worktree-owned paths only).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { runPublicNotary } from "../../src/public-cli/notary-run.ts";
import { parseNotaryArgv } from "../../src/public-cli/invocation.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import {
  CANONICAL_SOURCE_ROLE,
  CANONICAL_SOURCE_RUN_ID,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import {
  packageRoot,
  seedGitRepository,
} from "../helpers/pi-test-harness.ts";

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

test("#637 public notary: first→re-summons resume same run under live seat model", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-same-ticket-resume-"));
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

  const seen: Array<{
    runId: string;
    runDirectory: string;
    sessionFile: string;
    kind: RoleTurnRequest["continuation"]["kind"];
    model?: RoleTurnRequest["model"];
  }> = [];
  const host = {
    async executeTurn(request: RoleTurnRequest) {
      const sessionFile = piDurablePrincipalAuthority.decode(request.principal).sessionFile;
      await ensureSessionPrincipal(sessionFile);
      seen.push({
        runId: runIdFromDirectory(request.runDirectory),
        runDirectory: request.runDirectory,
        sessionFile,
        kind: request.continuation.kind,
        ...(request.model === undefined ? {} : { model: request.model }),
      });
      return { code: 0, stderr: "", timedOut: false };
    },
  };

  const io = {
    stdout: (_t: string) => {},
    stderr: (_t: string) => {},
  };
  const envBase = {
    packageRoot,
    home,
    agentDir: join(home, "agent"),
    cwd: project,
    principalAuthority: piDurablePrincipalAuthority,
    roleTurnHost: host,
    sessionAppender: appendPiSessionCustomEntry,
    host: "pi" as const,
    model: { provider: "faux", model: "birth-model", thinking: "high" as const },
  };

  const first = await runPublicNotary(
    ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
    { ...envBase, createRunId: () => "01a063700-0000-7000-8000-00000000n001" },
    io,
    parseNotaryArgv,
  );
  assert.equal(seen.length, 1, "first public notary must dispatch one turn");
  assert.equal(seen[0]!.kind, "initial", "first summons is initial");
  assert.equal(first.admitted?.runId, "01a063700-0000-7000-8000-00000000n001");
  assert.equal(first.admitted?.runDirectory, seen[0]!.runDirectory);
  assert.equal(seen[0]!.model?.model, "birth-model");
  assert.equal(seen[0]!.model?.thinking, "high");

  const notaryRunsAfterFirst = (await listBookRunDirs(home)).filter((d) =>
    d.includes("@notary"),
  );
  assert.equal(notaryRunsAfterFirst.length, 1, "first summons creates exactly one notary run");

  // Live seat table drifts before the second summons.
  const second = await runPublicNotary(
    ["--source-run", `${CANONICAL_SOURCE_RUN_ID}@${CANONICAL_SOURCE_ROLE}`],
    {
      ...envBase,
      createRunId: () => "01a063700-0000-7000-8000-00000000n002",
      model: { provider: "faux", model: "live-seat-model", thinking: "low" as const },
    },
    io,
    parseNotaryArgv,
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
    second.admitted?.runId,
    first.admitted?.runId,
    "admitted identity on resume is the prior run",
  );
  assert.equal(
    seen[1]!.model?.model,
    "live-seat-model",
    "resume must take the live seat-table model",
  );
  assert.equal(seen[1]!.model?.thinking, "low", "resume must take the live seat-table thinking");

  const notaryRunsAfterSecond = (await listBookRunDirs(home)).filter((d) =>
    d.includes("@notary"),
  );
  assert.equal(
    notaryRunsAfterSecond.length,
    1,
    "second summons must not mint a new notary run directory",
  );
  // No rm(home): deletion boundary is worktree-owned paths only.
});
