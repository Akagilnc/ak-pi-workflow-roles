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
import { projectGatekeeperRun } from "../../src/gatekeeper-role.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { publicCliConfigPath } from "../../src/public-cli/config.ts";
import { parseNotaryArgv } from "../../src/public-cli/invocation.ts";
import { runPublicNotary } from "../../src/public-cli/notary-run.ts";
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

test("#836 projectGatekeeperRun summons officer with whole run directory pointer only", async () => {
  await withTempRoot("ak-gate-resume-body-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 786 });

    const BODY_MARKER = "GATE-SUBMISSION-BODY-MARKER-786";
    const leaf = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-parent-1",
            name: "ak_coder_output",
            arguments: { status: "completed", report: BODY_MARKER },
          },
        ],
      },
    };

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
    const io = captureIo().io;

    const first = await runPublicNotary(
      ["--source-run", sourceRunPath],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: host,
        createRunId: () => "01a078600-0000-7000-8000-0000000n001",
      },
      io,
      parseNotaryArgv,
    );
    assert.equal(first.exitCode, 0);
    assert.equal(prompts.length, 1);

    // #836: code no longer picks latest toolCall leaf as submission body (A7.1–A7.3).
    // Officer gets the whole run directory pointer and finds materials themselves.
    const projected = await projectGatekeeperRun({
      context: {
        cwd: project,
        sessionManager: {
          getSessionFile: () => join(sourceRunPath, "session", "session.jsonl"),
          getEntries: () => [leaf],
        },
      } as never,
      subject: { kind: "countersign_verdict" },
      runDirectory: sourceRunPath,
      home,
      packageRoot,
      roleTurnHost: host,
      createRunId: () => "01a078600-0000-7000-8000-0000000n002",
    });
    assert.equal(projected.result.status, "bounce");
    assert.equal(prompts.length, 2);
    const resumePrompt = prompts[1]!;
    assert.equal(
      resumePrompt.includes(BODY_MARKER),
      false,
      "code must not inject parent submission body; officer reads the run directory",
    );
    assert.equal(
      resumePrompt.includes("请重读") || resumePrompt.includes("卷宗指针") || resumePrompt.includes(sourceRunPath),
      true,
      "resume must carry path pointer (请重读 / 卷宗指针 / run path)",
    );
  });
});

test("#836 host abort coexists with recorded officer payload — does not wash to bounce", async () => {
  const bounce = { status: "bounce", findings: ["keep-me"] };
  const projected = await projectGatekeeperRun({
    context: {
      cwd: process.cwd(),
      sessionManager: { getSessionFile: () => "/tmp/unused" },
    } as never,
    subject: { kind: "countersign_verdict" },
    runDirectory: "/tmp/parent-run",
    summonOfficer: async () => ({
      exitCode: 1,
      terminal: {
        roleOutcome: {
          kind: "failure",
          role: "notary",
          cause: "output",
          diagnostic: "This operation was aborted",
          decisiveFacts: { cause: "output" },
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "officer-run",
        submissions: [bounce],
      },
    }),
  });
  assert.equal(projected.result.status, "transport_failure");
  if (projected.result.status === "transport_failure") {
    assert.match(projected.result.reason, /This operation was aborted/);
    assert.deepEqual(projected.result.submission, [bounce]);
  }
});

test("#836 all recorded payloads kept; queue reads the latest conclusion", async () => {
  const projected = await projectGatekeeperRun({
    context: {
      cwd: process.cwd(),
      sessionManager: { getSessionFile: () => "/tmp/unused" },
    } as never,
    subject: { kind: "countersign_verdict" },
    runDirectory: "/tmp/parent-run",
    summonOfficer: async () => ({
      exitCode: 0,
      terminal: {
        roleOutcome: {
          kind: "accepted",
          role: "notary",
          status: "bounce",
          decisiveFacts: { status: "bounce" },
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "officer-run",
        submissions: [
          { status: "pass", findings: ["first"] },
          { status: "bounce", findings: ["second"] },
        ],
      },
    }),
  });
  assert.equal(projected.result.status, "bounce");
  if (projected.result.status === "bounce") {
    assert.deepEqual(projected.result.receipt, [
      { status: "pass", findings: ["first"] },
      { status: "bounce", findings: ["second"] },
    ]);
  }
});

test("#836 non-three-state then lawful pass converges; both payloads remain", async () => {
  const projected = await projectGatekeeperRun({
    context: {
      cwd: process.cwd(),
      sessionManager: { getSessionFile: () => "/tmp/unused" },
    } as never,
    subject: { kind: "countersign_verdict" },
    runDirectory: "/tmp/parent-run",
    summonOfficer: async () => ({
      exitCode: 0,
      terminal: {
        roleOutcome: {
          kind: "accepted",
          role: "notary",
          status: "pass",
          decisiveFacts: { status: "pass" },
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "officer-run",
        submissions: [
          { status: "other", note: "first" },
          { status: "pass", findings: ["ok"] },
        ],
      },
    }),
  });
  assert.equal(projected.result.status, "pass");
  if (projected.result.status === "pass") {
    assert.deepEqual(projected.result.receipt, [
      { status: "other", note: "first" },
      { status: "pass", findings: ["ok"] },
    ]);
  }
});

test("#821 projectGatekeeperRun → summonGateOfficer uses officer seat host, not parent invocation host", async () => {
  await withTempRoot("ak-gate-officer-seat-host-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 821 });

    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      publicCliConfigPath(home),
      `${JSON.stringify({
        seats: { notary: { provider: "openai-codex", model: "gpt-5.6-sol", host: "pi" } },
      })}\n`,
      "utf8",
    );
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(join(home, ".pi", "agent", "auth.json"), `${JSON.stringify({ "openai-codex": {} })}\n`, "utf8");

    // Parent live --host differs from the officer seat default (pi).
    await writeFile(
      join(sourceRunPath, "invocation.json"),
      `${JSON.stringify({
        role: "countersign",
        runId: "01a082100-0000-7000-8000-0000000p001",
        host: "claude",
        model: "sonnet",
      })}\n`,
      "utf8",
    );

    const leaf = {
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "call-parent-host",
            name: "ak_countersign_output",
            arguments: { countersignStatus: "converged", note: "seat-owned-host" },
          },
        ],
      },
    };

    const baseHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "pass", findings: [] },
      }),
    });
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        return baseHost.executeTurn(request);
      },
    };

    const projected = await projectGatekeeperRun({
      context: {
        cwd: project,
        sessionManager: {
          getSessionFile: () => join(sourceRunPath, "session", "session.jsonl"),
          getEntries: () => [leaf],
        },
      } as never,
      subject: { kind: "countersign_verdict" },
      runDirectory: sourceRunPath,
      home,
      packageRoot,
      roleTurnHost: host,
      createRunId: () => "01a082100-0000-7000-8000-0000000n821",
    });
    assert.equal(projected.result.status, "pass");
    assert.ok(projected.summoned?.runDirectory, "nested officer run must mint");
    const nestedInvocation = JSON.parse(
      await readFile(join(projected.summoned!.runDirectory!, "invocation.json"), "utf8"),
    ) as { host?: string; model?: string; provider?: string };
    assert.equal(
      nestedInvocation.host,
      "pi",
      "nested officer must start on own seat host (default pi), not parent invocation host",
    );
    assert.notEqual(
      nestedInvocation.host,
      "claude",
      "parent invocation host must not be forced onto the nested officer",
    );
    assert.equal(nestedInvocation.provider, "openai-codex");
    assert.equal(
      nestedInvocation.model,
      "gpt-5.6-sol",
      "nested officer must record own seat model, not parent invocation model",
    );
    assert.notEqual(nestedInvocation.model, "sonnet");
  });
});
