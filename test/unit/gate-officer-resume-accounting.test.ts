/**
 * #753 class: gate-officer same-parent resume materials + gate-round accounting.
 * - Multiple pointers to one officer session must not multiply rounds.
 * - Direct officer pointer booking upserts a stable leaf per officer.
 * - Same-parent notary resume delivers gate review materials via real seat entry.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { readAnalystGateCyclesFromAuditorRoles } from "../../src/analyst-gate-cycles-read.ts";
import { bookDirectOfficerRunPointer } from "../../src/archivist-record-entry.ts";
import { gateSubmissionCandidatePath } from "../../src/auditor-dossier-tool.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { parseNotaryArgv } from "../../src/public-cli/invocation.ts";
import { runPublicNotary } from "../../src/public-cli/notary-run.ts";
import { RESUME_TRANSPORT_ENVELOPE } from "../../src/public-cli/run-lifecycle.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import {
  CANONICAL_SOURCE_ROLE,
  seedCanonicalSourceRun,
} from "../helpers/notary-fixtures.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";

function iso(ms: number): string {
  return new Date(Date.parse("2026-09-08T00:00:00.000Z") + ms).toISOString();
}

async function writeThreeBounceOfficerSession(sessionFile: string): Promise<void> {
  await mkdir(join(sessionFile, ".."), { recursive: true });
  const chunks: string[] = [];
  for (let i = 0; i < 3; i += 1) {
    chunks.push(
      gateToolSessionJsonl({
        id: `notary-bounce-${i + 1}`,
        startedAt: iso(i * 60_000),
        endedAt: iso(i * 60_000 + 10_000),
        toolName: "ak_notary_output",
        args: {
          status: "bounce",
          findings: [`finding-${i + 1}`],
        },
        includeHeader: i === 0,
      }),
    );
  }
  await writeFile(sessionFile, chunks.join(""), "utf8");
}

test("#753 multiple pointers to same officer session count seals once each", async () => {
  await withTempRoot("ak-gate-pointer-dedupe-", async (root) => {
    const officerSession = join(root, "officer", "session", "session.jsonl");
    await writeThreeBounceOfficerSession(officerSession);
    const auditorRoles = join(root, "parent", "session", "auditor-roles");
    await mkdir(auditorRoles, { recursive: true });
    // Historical multi-mint shape (pre-upsert): three pointers, one session.
    for (const name of ["notary-aaa.pointer.json", "notary-bbb.pointer.json", "notary-ccc.pointer.json"]) {
      await writeFile(
        join(auditorRoles, name),
        `${JSON.stringify({
          version: 1,
          kind: "direct-officer-run-pointer",
          officer: "notary",
          sessionFile: officerSession,
          runDirectory: join(root, "officer"),
        })}\n`,
        "utf8",
      );
    }

    const rounds = await readAnalystGateCyclesFromAuditorRoles(auditorRoles);
    assert.equal(rounds.length, 3, "3 seals via 3 pointers must stay 3 rounds, not 9");
    assert.deepEqual(
      rounds.map((r) => r.status),
      ["bounce", "bounce", "bounce"],
    );
    assert.deepEqual(
      rounds.map((r) => r.findingsCount),
      [1, 1, 1],
    );
  });
});

test("#753 bookDirectOfficerRunPointer upserts stable leaf per officer", async () => {
  await withTempRoot("ak-gate-pointer-upsert-", async (root) => {
    const parentSession = join(root, "parent", "session", "session.jsonl");
    await mkdir(join(parentSession, ".."), { recursive: true });
    await writeFile(parentSession, "", "utf8");
    const firstSession = join(root, "officer-a", "session", "session.jsonl");
    const secondSession = join(root, "officer-b", "session", "session.jsonl");

    bookDirectOfficerRunPointer({
      parentSessionFile: parentSession,
      officer: "notary",
      sessionFile: firstSession,
      runDirectory: join(root, "officer-a"),
    });
    bookDirectOfficerRunPointer({
      parentSessionFile: parentSession,
      officer: "notary",
      sessionFile: secondSession,
      runDirectory: join(root, "officer-b"),
    });

    const nest = join(root, "parent", "session", "auditor-roles");
    const { readdir } = await import("node:fs/promises");
    const names = (await readdir(nest)).sort();
    assert.deepEqual(names, ["notary.pointer.json"]);
    const body = JSON.parse(await readFile(join(nest, "notary.pointer.json"), "utf8")) as {
      sessionFile: string;
      runDirectory?: string;
    };
    assert.equal(body.sessionFile, secondSession);
    assert.equal(body.runDirectory, join(root, "officer-b"));
  });
});

function seedGitProject(root: string): void {
  seedGitRepository(root);
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
    { cwd: root },
  );
}

test("#753 notary same-parent resume delivers gate materials via real seat entry", async () => {
  await withTempRoot("ak-gate-resume-materials-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 753 });
    const candidatePath = gateSubmissionCandidatePath(sourceRunPath);
    await mkdir(join(candidatePath, ".."), { recursive: true });
    await writeFile(
      candidatePath,
      `${JSON.stringify({ type: "message", message: { role: "assistant", content: [] } })}\n`,
      "utf8",
    );

    const prompts: string[] = [];
    const baseHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "bounce", findings: ["x"] },
      }),
    });
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        prompts.push(request.continuation.prompt);
        return baseHost.executeTurn(request);
      },
    };
    const envBase = {
      home,
      agentDir: join(home, ".pi"),
      packageRoot,
      cwd: project,
      principalAuthority: piDurablePrincipalAuthority,
      sessionAppender: appendPiSessionCustomEntry,
      roleTurnHost: host,
    } as const;
    const io = captureIo().io;

    // 1) Fresh mint establishes the same-parent notary run.
    const first = await runPublicNotary(
      ["--source-run", sourceRunPath],
      { ...envBase, createRunId: () => "01a075300-0000-7000-8000-0000000n001" },
      io,
      parseNotaryArgv,
    );
    assert.equal(first.exitCode, 0);
    assert.equal(prompts.length, 1);

    // 2) Real seat entry: gateReviewInstruction is the face summonGateOfficer writes.
    // Contract: resume prompt carries source-run + candidate path tokens, not bare envelope.
    // Do not lock builder Chinese / template wording.
    const gateReviewInstruction = [
      "GATE-REVIEW-MATERIALS",
      sourceRunPath,
      candidatePath,
    ].join("\n");
    const resumed = await runPublicNotary(
      ["--source-run", sourceRunPath],
      {
        ...envBase,
        gateReviewInstruction,
        createRunId: () => "01a075300-0000-7000-8000-0000000n002",
      },
      io,
      parseNotaryArgv,
    );
    assert.equal(resumed.exitCode, 0);
    assert.equal(prompts.length, 2);
    const resumePrompt = prompts[1]!;
    assert.equal(resumePrompt.includes(sourceRunPath), true, "resume prompt must name source run");
    assert.equal(resumePrompt.includes(candidatePath), true, "resume prompt must name candidate path");
    assert.notEqual(
      resumePrompt,
      RESUME_TRANSPORT_ENVELOPE,
      "resume must not be bare envelope when gate materials ride",
    );
  });
});
