/**
 * Medium #753 / #821 / #879 gate-officer resume accounting (FS / real officer entry).
 * Unit coverage: test/unit/gate-officer-resume-accounting.test.ts
 * - Multiple pointers to one officer session must not multiply rounds (#753).
 * - Direct officer pointer booking upserts a stable leaf per officer (#753).
 * - Officer seat host is not parent invocation host (#821).
 * - Nth review turn binds Nth typed payload structure (not pairwise dialogue).
 * - Court-scoped settlement: this-court outcome; empty scope → no outcome; history kept.
 * - Station-child 0081 dossier folds via systemPrompt.materials, not dialogue.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
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
import type { AdmittedNotaryInvocation } from "../../src/public-cli/invocation.ts";
import { parseNotaryArgv } from "../../src/public-cli/invocation.ts";
import { runPublicNotary } from "../../src/public-cli/notary-run.ts";
import {
  attachRecordedSubmissions,
  trySettleNotaryTerminalResult,
} from "../../src/public-cli/settlement.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";

function seedGitProject(root: string): void {
  seedGitRepository(root);
  execFileSync(
    "git",
    ["remote", "add", "origin", "git@github.com:Akagilnc/ak-pi-workflow-roles.git"],
    { cwd: root },
  );
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

test("#879 Nth officer turn receives Nth parent submission — not history array", async () => {
  await withTempRoot("ak-gate-resume-body-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 879 });

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
        assert.equal(
          "materials" in request,
          false,
          "station-child officer must not grow a materials field on RoleTurnRequest",
        );
        return baseHost.executeTurn(request);
      },
    };

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
        createRunId: () => "01a087900-0000-7000-8000-0000000n001",
      },
      captureIo().io,
      parseNotaryArgv,
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
        home,
        packageRoot,
        roleTurnHost: host,
        createRunId: () => `01a087900-0000-7000-8000-0000000n00${i + 2}`,
      });
      assert.equal(projected.result.status, "bounce");
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

    const first = { status: "pass", findings: ["first"] };
    const second = { status: "bounce", findings: ["second"] };
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
      admittedRequestPath: join(runDir, "admitted-request.json"),
      sourceRunPath: join(root, "parent-source"),
      sourceRun: {
        runDirectory: join(root, "parent-source"),
        runId: "parent",
        role: "countersign",
      },
    };

    const settled = await trySettleNotaryTerminalResult(
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

    const emptyCourt = await trySettleNotaryTerminalResult(
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
    assert.equal(projected.result.status, "bounce");
    if (projected.result.status === "bounce") {
      assert.deepEqual(projected.result.receipt, second);
    }
    assert.deepEqual(projected.summoned?.terminal?.submissions, [first, second]);
  });
});

test("#879 station-child officer: case dossier once via shared envelope readingMaterial; dialogue = peer only", async () => {
  await withTempRoot("ak-officer-dossier-attach-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 879 });

    const prompts: string[] = [];
    const runDirs: string[] = [];
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
        prompts.push(request.continuation.prompt);
        runDirs.push(request.runDirectory);
        assert.equal("materials" in request, false);
        return baseHost.executeTurn(request);
      },
    };

    const body = { countersignStatus: "converged", note: "DOSSIER-ATTACH-BODY" };
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
      home,
      packageRoot,
      roleTurnHost: host,
      createRunId: () => "01a087900-0000-7000-8000-0000000d001",
    });
    assert.equal(projected.result.status, "pass");
    assert.ok(prompts.length >= 1);
    assert.deepEqual(JSON.parse(prompts[prompts.length - 1]!), body);

    const officerRun = projected.summoned?.runDirectory ?? runDirs[runDirs.length - 1];
    assert.ok(officerRun, "officer run directory must exist");

    const socketDir = await mkdtemp(join(tmpdir(), "ak-879-env-"));
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
    });
    try {
      assert.deepEqual(JSON.parse(prepared.prompt), body);
      const dossiers = prepared.systemPrompt.materials.filter(
        (material) =>
          typeof material === "object"
          && material !== null
          && (material as { kind?: unknown }).kind === "case-dossier-pointer",
      );
      assert.equal(dossiers.length, 1);
      const dossier = dossiers[0] as { kind?: unknown; frozenPath?: unknown };
      assert.equal(dossier.kind, "case-dossier-pointer");
      assert.equal(typeof dossier.frozenPath, "string");
      assert.ok(typeof dossier.frozenPath === "string" && dossier.frozenPath.length > 0);
      await access(dossier.frozenPath as string);
    } finally {
      await prepared.dispose?.();
    }

    await assert.rejects(
      () => access(join(officerRun!, ".case-dossier-stage")),
      (error: unknown) =>
        error instanceof Error
        && (error as NodeJS.ErrnoException).code === "ENOENT",
    );
  });
});
