/**
 * Medium #753 / #821 / #879 gate-officer resume accounting (FS / real officer entry).
 * Unit coverage: test/unit/gate-officer-resume-accounting.test.ts
 * - Multiple archived pointers to one officer session must not multiply rounds (#753).
 * - Officer seat host is not parent invocation host (#821).
 * - Nth review turn binds Nth typed payload structure (not pairwise dialogue).
 * - Court-scoped settlement: this-court outcome; empty scope → no outcome; history kept.
 * - Station-child: #1092 drops case-dossier pointer delivery; dialogue stays peer-only.
 */
import { readCurrentSection, seedCurrentSection } from "../helpers/run-dossier-fixture.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readAnalystGateCyclesFromOfficers } from "../../src/analyst-gate-cycles-read.ts";
import { OFFICER_POINTER_RECORD_KIND } from "../../src/archivist-record-pointer.ts";
import { reportRunRecord } from "../../src/sitian-facade.ts";
import { projectGatekeeperRun } from "../../src/gatekeeper-role.ts";
import { createDefaultGateOfficerSummon } from "../../src/submission-gate.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { publicCliConfigPath } from "../../src/public-cli/config.ts";
import type { AdmittedNotaryInvocation } from "../../src/public-cli/invocation.ts";
import { parsePublicSeatArgv } from "../../src/public-cli/invocation.ts";
import { runPublicInstructionSeat } from "../../src/public-cli/instruction-seat-run.ts";
import {
  attachRecordedSubmissions,
  trySettlePublicSeat,
} from "../../src/public-cli/settlement.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { packageRoot, seedRoleRepo as seedGitProject } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";

/** A parent run inside a ledger home: the appender only books records for a real run leaf. */
function parentRunDirectory(root: string): string {
  return join(root, ".ak-roles", "books", "gate-pointers", "runs", "01a0753-parent-7000-8000-000000000001@judge");
}

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
          status: "continue",
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
    const parentRun = parentRunDirectory(root);
    // Historical multi-mint shape (pre-upsert): three pointers, one session.
    for (const name of ["notary-aaa", "notary-bbb", "notary-ccc"]) {
      reportRunRecord(parentRun, OFFICER_POINTER_RECORD_KIND, {
        version: 1,
        kind: "direct-officer-run-pointer",
        officer: name,
        sessionFile: officerSession,
        runDirectory: join(root, "officer"),
      }, "submission-gate");
    }

    const rounds = await readAnalystGateCyclesFromOfficers(parentRun);
    assert.equal(rounds.length, 3, "3 seals via 3 pointers must stay 3 rounds, not 9");
    assert.deepEqual(
      rounds.map((r) => r.status),
      ["continue", "continue", "continue"],
    );
    assert.deepEqual(
      rounds.map((r) => r.findingsCount),
      [1, 1, 1],
    );
  });
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

    seedCurrentSection(sourceRunPath, "invocation", {
      role: "countersign",
      runId: "01a082100-0000-7000-8000-0000000p001",
      host: "claude",
      model: "sonnet",
    });

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
        details: { status: "converged", findings: [] },
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
      summonOfficer: createDefaultGateOfficerSummon({
        cwd: project,
        home,
        packageRoot,
        roleTurnHost: host,
        createRunId: () => "01a082100-0000-7000-8000-0000000n821",
      }),
    });
    assert.equal(projected.result.status, "converged");
    assert.ok(projected.summoned?.runDirectory, "nested officer run must mint");
    const nestedInvocation = readCurrentSection(projected.summoned!.runDirectory!, "invocation") as {
      host?: string; model?: string; provider?: string;
    };
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

test("#879 Nth officer turn receives Nth parent submission — not history array", async () => {
  await withTempRoot("ak-gate-resume-body-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 879 });
    // #178: officer summons resolve model from the live seat table only (no package fill-in).
    // Same caller-seat + auth write as #821 in this file — not a parallel seed helper.
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      publicCliConfigPath(home),
      `${JSON.stringify({
        seats: { notary: { provider: "openai-codex", model: "gpt-5.6-sol" } },
      })}\n`,
      "utf8",
    );
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      join(home, ".pi", "agent", "auth.json"),
      `${JSON.stringify({ "openai-codex": {} })}\n`,
      "utf8",
    );

    const prompts: string[] = [];
    const baseHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "continue", findings: ["x"] },
      }),
    });
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        prompts.push(request.continuation.prompt);
        assert.equal(
          "materials" in request,
          false,
          "station-child officer must not grow a materials field on RoleTurnRequest",
        );
        return baseHost.executeTurn(request);
      },
    };

    const first = await runPublicInstructionSeat(
      ["--source-run", sourceRunPath],
      {
        home,
        agentDir: join(home, ".pi"),
        packageRoot,
        cwd: project,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
        roleTurnHost: host,
        createRunId: () => "01a087900-0000-7000-8000-0000000n001",
      },
      captureIo().io,
      "notary",
      (args) => parsePublicSeatArgv("notary", args),
    );
    assert.equal(first.exitCode, 0);
    assert.equal(prompts.length, 1);

    const roundBodies = [
      { countersignStatus: "converged", note: "GATE-BODY-ROUND-1" },
      { countersignStatus: "converged", note: "GATE-BODY-ROUND-2" },
    ] as const;

    for (let i = 0; i < roundBodies.length; i += 1) {
      const body = roundBodies[i]!;
      const projected = await projectGatekeeperRun({
        context: {
          cwd: project,
          sessionManager: {
            getSessionFile: () => join(sourceRunPath, "session", "session.jsonl"),
            getEntries: () => [],
          },
        } as never,
        subject: { kind: "countersign_verdict" },
        runDirectory: sourceRunPath,
        submission: body,
      summonOfficer: createDefaultGateOfficerSummon({
        cwd: project,
        home,
        packageRoot,
        roleTurnHost: host,
        createRunId: () => `01a087900-0000-7000-8000-0000000n00${i + 2}`,
      }),
    });
      assert.equal(projected.result.status, "continue");
      assert.deepEqual(JSON.parse(prompts[i + 1]!), body);
      const terminal = projected.summoned?.terminal;
      assert.ok(terminal !== undefined, `round ${i + 1} must settle a terminal`);
      assert.equal(terminal!.roleOutcome.kind, "accepted");
      if (terminal!.roleOutcome.kind === "accepted") {
        assert.ok((terminal!.roleOutcome.payloads?.length ?? 0) >= 1);
      }
    }
    assert.equal(prompts.length, 1 + roundBodies.length);
  });
});

test("#879 court-scoped settlement: this-court outcome; empty scope court yields no outcome; history on submissions", async () => {
  await withTempRoot("ak-court-scope-settlement-", async (root) => {
    execFileSync("git", ["init", "-q", root]);
    const runId = "run-ledger";
    const runDir = join(root, ".ak-roles", "books", "test-book", "runs", `${runId}@notary`);
    const sessionDirectory = join(runDir, "session");
    await mkdir(sessionDirectory, { recursive: true });
    const sessionFile = join(sessionDirectory, "session.jsonl");
    await writeFile(sessionFile, "", "utf8");

    const first = { status: "converged", findings: ["first"] };
    const second = { status: "continue", findings: ["second"] };
    await sealAcceptedSubmission({
      cwd: root,
      home: root,
      runId,
      runDirectory: runDir,
      role: "notary",
      details: first,
      toolCallId: "c1",
      courtAttemptId: "court-1",
    });
    await sealAcceptedSubmission({
      cwd: root,
      home: root,
      runId,
      runDirectory: runDir,
      role: "notary",
      details: second,
      toolCallId: "c2",
      courtAttemptId: "court-2",
    });

    const admitted: AdmittedNotaryInvocation = {
      role: "notary",
      runId,
      bookKey: "test-book",
      projectRoot: root,
      instruction: "",
      instructionEmpty: true,
      attachments: [],
      runDirectory: runDir,
      principal: fixturePrincipal(sessionDirectory, sessionFile),
      sourceRunPath: join(root, "parent-source"),
      sourceRun: {
        runDirectory: join(root, "parent-source"),
        runId: "parent",
        role: "countersign",
      },
    };

    const settled = await trySettlePublicSeat(
      admitted,
      piDurablePrincipalAuthority,
      { courtAttemptId: "court-2" },
    );
    assert.ok(settled !== undefined, "court-2 must settle");
    assert.equal(settled!.roleOutcome.kind, "accepted");
    if (settled!.roleOutcome.kind === "accepted") {
      assert.deepEqual(settled!.roleOutcome.payloads, [second]);
    }
    const withHistory = await attachRecordedSubmissions(admitted, settled!, {
      courtAttemptId: "court-2",
    });
    assert.deepEqual(withHistory.submissions, [first, second]);
    if (withHistory.roleOutcome.kind === "accepted") {
      assert.deepEqual(withHistory.roleOutcome.payloads, [second]);
    }

    const emptyCourt = await trySettlePublicSeat(
      admitted,
      piDurablePrincipalAuthority,
      { courtAttemptId: "court-never-sealed" },
    );
    assert.equal(
      emptyCourt,
      undefined,
      "scoped empty court must not fall back to full-run history outcome",
    );

    const projected = await projectGatekeeperRun({
      context: {
        cwd: root,
        sessionManager: { getSessionFile: () => sessionFile },
      } as never,
      subject: { kind: "countersign_verdict" },
      runDirectory: join(root, "parent-run"),
      summonOfficer: async () => ({
        exitCode: 0,
        terminal: withHistory,
      }),
    });
    assert.equal(projected.result.status, "continue");
    if (projected.result.status === "continue") {
      assert.deepEqual(projected.result.receipt, second);
    }
    assert.deepEqual(projected.summoned?.terminal?.submissions, [first, second]);
  });
});

test("#1092 station-child officer: no case-dossier pointer material; dialogue = peer only", async () => {
  await withTempRoot("ak-officer-no-dossier-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 1092 });
    // #178: officer summons need a caller-specified seat model (same pattern as #821 above).
    await mkdir(join(home, ".ak-roles"), { recursive: true });
    await writeFile(
      publicCliConfigPath(home),
      `${JSON.stringify({
        seats: { notary: { provider: "openai-codex", model: "gpt-5.6-sol" } },
      })}\n`,
      "utf8",
    );
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    await writeFile(
      join(home, ".pi", "agent", "auth.json"),
      `${JSON.stringify({ "openai-codex": {} })}\n`,
      "utf8",
    );

    const prompts: string[] = [];
    const runDirs: string[] = [];
    const baseHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "converged", findings: [] },
      }),
    });
    const host = {
      async executeTurn(request: RoleTurnRequest) {
        prompts.push(request.continuation.prompt);
        runDirs.push(request.runDirectory);
        assert.equal("materials" in request, false);
        return baseHost.executeTurn(request);
      },
    };

    const body = { countersignStatus: "converged", note: "NO-DOSSIER-PEER-BODY" };
    const projected = await projectGatekeeperRun({
      context: {
        cwd: project,
        sessionManager: {
          getSessionFile: () => join(sourceRunPath, "session", "session.jsonl"),
          getEntries: () => [],
        },
      } as never,
      subject: { kind: "countersign_verdict" },
      runDirectory: sourceRunPath,
      submission: body,
      summonOfficer: createDefaultGateOfficerSummon({
        cwd: project,
        home,
        packageRoot,
        roleTurnHost: host,
        createRunId: () => "01a0109200007000800000000000d1",
      }),
    });
    assert.equal(projected.result.status, "converged");
    assert.ok(prompts.length >= 1);
    assert.deepEqual(JSON.parse(prompts[prompts.length - 1]!), body);

    const officerRun = projected.summoned?.runDirectory ?? runDirs[runDirs.length - 1];
    assert.ok(officerRun, "officer run directory must exist");

    await assert.rejects(
      () => access(join(officerRun!, "attachments", "case-dossier")),
      (error: unknown) =>
        error instanceof Error
        && (error as NodeJS.ErrnoException).code === "ENOENT",
    );

    const socketDir = await mkdtemp(join(tmpdir(), "ak-1092-officer-env-"));
    try {
      const prepared = await prepareRoleEnvelope({
        request: {
          principal: fixturePrincipal(join(officerRun!, "session")),
          activation: { role: "judge" },
          methods: [],
          continuation: { kind: "resume", prompt: JSON.stringify(body) },
          cwd: project,
          home,
          agentDir: join(home, "agent"),
          runDirectory: officerRun!,
          stationChild: true,
        },
        dependencies: createRoleRuntimeDependencies(packageRoot),
        socketPath: join(socketDir, "mcp.sock"),
        principalAuthority: piDurablePrincipalAuthority,
    });
      try {
        assert.deepEqual(JSON.parse(prepared.prompt), body);
        const dossiers = prepared.systemPrompt.materials.filter(
          (material) =>
            typeof material === "object"
            && material !== null
            && (material as { kind?: unknown }).kind === "case-dossier-pointer",
        );
        assert.equal(dossiers.length, 0);
      } finally {
        await prepared.dispose?.();
      }
    } finally {
      await rm(socketDir, { recursive: true, force: true });
    }

    await assert.rejects(
      () => access(join(officerRun!, ".case-dossier-stage")),
      (error: unknown) =>
        error instanceof Error
        && (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});