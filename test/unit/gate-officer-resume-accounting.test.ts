/**
 * #753 / #786 class: gate-officer same-parent resume + gate-round accounting.
 * - Multiple pointers to one officer session must not multiply rounds.
 * - Direct officer pointer booking upserts a stable leaf per officer.
 * - Same-parent notary resume delivers verbatim submission body via real seat entry (#786).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { readAnalystGateCyclesFromAuditorRoles } from "../../src/analyst-gate-cycles-read.ts";
import { bookDirectOfficerRunPointer } from "../../src/archivist-record-entry.ts";
import {
  buildGateOfficerReviewInstruction,
  readLatestSubmissionArguments,
} from "../../src/auditor-dossier-tool.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { parseNotaryArgv } from "../../src/public-cli/invocation.ts";
import { runPublicNotary } from "../../src/public-cli/notary-run.ts";
import { RESUME_TRANSPORT_ENVELOPE } from "../../src/public-cli/run-lifecycle.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
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

test("#786 buildGateOfficerReviewInstruction relays submission body verbatim", () => {
  const BODY_MARKER = "GATE-SUBMISSION-BODY-MARKER-786";
  const submission = { status: "completed", report: BODY_MARKER };
  const leaf = {
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "c1", name: "ak_coder_output", arguments: submission }],
    },
  };
  const extracted = readLatestSubmissionArguments({
    sessionManager: { getEntries: () => [leaf] },
  });
  assert.deepEqual(extracted, submission);
  // Contract: instruction IS the body relay (readableGateItem), not a path substitute.
  assert.equal(
    buildGateOfficerReviewInstruction({ submission: extracted }),
    JSON.stringify(submission),
  );
});

test("#786 notary same-parent resume delivers verbatim submission body via real seat entry", async () => {
  await withTempRoot("ak-gate-resume-body-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 786 });

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
      { ...envBase, createRunId: () => "01a078600-0000-7000-8000-0000000n001" },
      io,
      parseNotaryArgv,
    );
    assert.equal(first.exitCode, 0);
    assert.equal(prompts.length, 1);

    // 2) Real seat entry: gateReviewInstruction is the face summonGateOfficer writes.
    // Contract: resume prompt carries the submission body bytes, not path pointers / bare envelope.
    // Do not lock builder framing / template wording — only the body marker.
    const BODY_MARKER = "GATE-SUBMISSION-BODY-MARKER-786";
    const submission = { status: "completed", report: BODY_MARKER };
    const gateReviewInstruction = JSON.stringify(submission);
    const resumed = await runPublicNotary(
      ["--source-run", sourceRunPath],
      {
        ...envBase,
        gateReviewInstruction,
        createRunId: () => "01a078600-0000-7000-8000-0000000n002",
      },
      io,
      parseNotaryArgv,
    );
    assert.equal(resumed.exitCode, 0);
    assert.equal(prompts.length, 2);
    const resumePrompt = prompts[1]!;
    assert.equal(
      resumePrompt.includes(BODY_MARKER),
      true,
      "resume prompt must carry verbatim submission body",
    );
    assert.notEqual(
      resumePrompt,
      RESUME_TRANSPORT_ENVELOPE,
      "resume must not be bare envelope when submission body rides",
    );
  });
});
