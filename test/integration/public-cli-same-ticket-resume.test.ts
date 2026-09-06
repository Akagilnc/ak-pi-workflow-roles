/**
 * #637 — one public-entry tracer via runAkRole (cli.ts seat-table resolution):
 * first summons mints + seals; same-ticket re-summons resume that run under the
 * live seat-table model with a new court attempt and different source-run material.
 * Temp home is worktree-owned and always cleaned.
 *
 * Host is the real Pi argv host with a faux spawn runner that seals through the
 * production submission ledger. Contract: same-run routing + seat axes + sealed
 * re-summons still dispatch (not short-circuit) + new source-run pointer distinct.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import {
  issuePiDurablePrincipalCoordinates,
  piDurablePrincipalAuthority,
} from "../../src/pi/durable-principal.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { writeRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
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

/** Second retained source run under the machine ledger book (different id/path). */
async function seedSecondSourceRun(home: string, project: string): Promise<string> {
  const coords = issuePiDurablePrincipalCoordinates({
    cwd: project,
    runId: SECOND_SOURCE_RUN_ID,
    role: CANONICAL_SOURCE_ROLE,
    home,
  });
  await mkdir(coords.sessionDirectory, { recursive: true });
  const admittedRequestPath = join(coords.runDirectory, "admitted-request.json");
  await writeFile(
    coords.sessionFile,
    `${JSON.stringify({ type: "message", message: { role: "user", content: "second draft" } })}\n`,
    "utf8",
  );
  await writeFile(
    admittedRequestPath,
    `${JSON.stringify({
      role: CANONICAL_SOURCE_ROLE,
      runId: SECOND_SOURCE_RUN_ID,
      ticketNumber: 637,
    })}\n`,
    "utf8",
  );
  await writeRoleRunState(coords.runDirectory, {
    runId: SECOND_SOURCE_RUN_ID,
    role: CANONICAL_SOURCE_ROLE,
    state: "terminal",
    bookKey: coords.bookKey,
    projectRoot: project,
    sessionDirectory: coords.sessionDirectory,
    sessionFile: coords.sessionFile,
    admittedRequestPath,
  });
  const { realpath } = await import("node:fs/promises");
  return await realpath(coords.runDirectory);
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

test("#637 public notary via runAkRole: sealed first→re-summons same run with distinct source-run", async () => {
  await mkdir(WORKTREE_SCRATCH, { recursive: true });
  const home = await mkdtemp(join(WORKTREE_SCRATCH, "home-"));
  try {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const firstSourcePath = await seedCanonicalSourceRun(home, project);
    const secondSourcePath = await seedSecondSourceRun(home, project);
    assert.notEqual(
      firstSourcePath,
      secondSourcePath,
      "fixture must materialize two distinct source-run directories",
    );

    // Stamp ticket #637 on the first source so the seat binds and can resume.
    const firstAdmittedPath = join(firstSourcePath, "admitted-request.json");
    const firstAdmittedRaw = JSON.parse(await readFile(firstAdmittedPath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      firstAdmittedPath,
      `${JSON.stringify({ ...firstAdmittedRaw, ticketNumber: 637 }, null, 2)}\n`,
      "utf8",
    );

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
      kind: RoleTurnRequest["continuation"]["kind"];
      model?: RoleTurnRequest["model"];
      sourceRun?: string;
      courtAttemptId?: string;
    }> = [];

    const notaryDetails = { status: "pass", findings: [] as unknown[] };
    const baseRunner = scriptedTerminatingToolSession({
      role: "notary",
      toolName: NOTARY_OUTPUT_TOOL_NAME,
      details: notaryDetails,
    });
    let dispatchOrdinal = 0;
    const host = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: async (args, options) => {
        dispatchOrdinal += 1;
        // Capture request facts via argv + spawn env (court attempt / run dir).
        const runDirectory = options.env.AK_ROLE_RUN_DIR ?? "";
        const courtAttemptId = options.env.AK_ROLE_COURT_ATTEMPT;
        const sourceRunFlag = (() => {
          const i = args.indexOf("--ak-notary-source-run");
          return i >= 0 ? args[i + 1] : undefined;
        })();
        seen.push({
          runId: runIdFromDirectory(runDirectory),
          runDirectory,
          kind: dispatchOrdinal === 1 ? "initial" : "resume",
          model: (() => {
            const pi = args.indexOf("--provider");
            const mi = args.indexOf("--model");
            const ti = args.indexOf("--thinking");
            if (pi < 0 || mi < 0) return undefined;
            return {
              provider: args[pi + 1]!,
              model: args[mi + 1]!,
              ...(ti < 0 ? {} : { thinking: args[ti + 1] }),
            };
          })(),
          ...(sourceRunFlag === undefined ? {} : { sourceRun: sourceRunFlag }),
          ...(typeof courtAttemptId === "string" && courtAttemptId.length > 0
            ? { courtAttemptId }
            : {}),
        });
        return baseRunner(args, options);
      },
    });

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
    assert.ok(seen[0]!.sourceRun, "first summons delivers source-run pointer");
    assert.equal(
      seen[0]!.courtAttemptId,
      undefined,
      "first mint has no court-attempt id (session-stable sole-final)",
    );
    const firstSourcePointer = seen[0]!.sourceRun!;

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

    // Second summons uses a different same-ticket source-run after the first sealed.
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
    assert.ok(seen[1]!.sourceRun, "re-summons must deliver this turn's source-run pointer");
    assert.notEqual(
      seen[1]!.sourceRun,
      firstSourcePointer,
      "second summons source-run pointer must differ from the first",
    );
    assert.ok(
      seen[1]!.sourceRun!.includes(SECOND_SOURCE_RUN_ID),
      `second source-run must point at ${SECOND_SOURCE_RUN_ID}, got ${seen[1]!.sourceRun}`,
    );
    assert.ok(
      seen[1]!.courtAttemptId,
      "sealed re-summons must open a new court-attempt id for submission ledger",
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
    await rm(home, { recursive: true, force: true });
  }
});
