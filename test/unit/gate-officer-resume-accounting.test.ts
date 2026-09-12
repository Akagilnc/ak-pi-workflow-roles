/**
 * #753 / #786 / #879 class: gate-officer same-parent resume + gate-round accounting.
 * - Multiple pointers to one officer session must not multiply rounds.
 * - Direct officer pointer booking upserts a stable leaf per officer.
 * - Nth review turn dialogue differs per parent submission (#879 differential).
 * - This-court officer receipt from settlement payloads only — no sole-row guess.
 * - Station-child host-transition omits priorNativePaths (with/without differential).
 * - Court-scoped settlement: this-court outcome; empty scope → no outcome; history kept.
 * - Station-child 0081 case dossier hangs as attachment, not dialogue body.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { readAnalystGateCyclesFromAuditorRoles } from "../../src/analyst-gate-cycles-read.ts";
import { bookDirectOfficerRunPointer } from "../../src/archivist-record-entry.ts";
import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import { projectGatekeeperRun } from "../../src/gatekeeper-role.ts";
import type { RoleTurnRequest } from "../../src/host-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { appendPiSessionCustomEntry, createPiRoleTurnHost } from "../../src/pi/role-turn-host.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { publicCliConfigPath } from "../../src/public-cli/config.ts";
import type { AdmittedNotaryInvocation } from "../../src/public-cli/invocation.ts";
import { parseNotaryArgv } from "../../src/public-cli/invocation.ts";
import { runPublicNotary } from "../../src/public-cli/notary-run.ts";
import {
  attachRecordedSubmissions,
  trySettleNotaryTerminalResult,
} from "../../src/public-cli/settlement.ts";
import {
  createSubmissionLedgerHost,
  readRecordedSubmissions,
} from "../../src/submission-ledger.ts";
import type { HostContext, HostToolDefinition, RoleHost } from "../../src/host-contracts.ts";
import { Type } from "typebox";
import { captureIo } from "../helpers/failure-settlement-kit.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
import { seedCanonicalSourceRun } from "../helpers/notary-fixtures.ts";
import { packageRoot, seedGitRepository } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";

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
        // #879: no RoleTurnRequest.materials cross-host seam.
        assert.equal(
          "materials" in request,
          false,
          "station-child officer must not grow a materials field on RoleTurnRequest",
        );
        return baseHost.executeTurn(request);
      },
    };
    const io = captureIo().io;

    // Seed a same-parent officer run so the next gate summons resumes it.
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
      io,
      parseNotaryArgv,
    );
    assert.equal(first.exitCode, 0);
    assert.equal(prompts.length, 1);

    const roundBodies = [
      { countersignStatus: "converged", note: "GATE-BODY-ROUND-1" },
      { countersignStatus: "converged", note: "GATE-BODY-ROUND-2" },
      { countersignStatus: "converged", note: "GATE-BODY-ROUND-3" },
    ] as const;

    for (let i = 0; i < roundBodies.length; i += 1) {
      const body = roundBodies[i]!;
      const projected = await projectGatekeeperRun({
        context: {
          cwd: project,
          sessionManager: {
            getSessionFile: () => join(sourceRunPath, "session", "session.jsonl"),
            // Header-only / stale leaf must not be the content source (#879).
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
      const resumePrompt = prompts[i + 1]!;
      // Nth turn must receive a non-empty parent body relay (not the #860
      // same-every-time constant). No marker includes / prompt===body lock.
      assert.ok(
        resumePrompt.length > 0,
        `round ${i + 1} dialogue must carry parent body bytes`,
      );
      assert.ok(
        projected.summoned?.runDirectory,
        "officer run binding must remain (pointer channel independent of content)",
      );
      // Real post-admission → trySettle path: this-court roleOutcome vs full submissions.
      const terminal = projected.summoned?.terminal;
      assert.ok(terminal !== undefined, `round ${i + 1} must settle a terminal`);
      const outcome = terminal!.roleOutcome;
      assert.equal(outcome.kind, "accepted");
      if (outcome.kind === "accepted") {
        assert.ok(
          (outcome.payloads?.length ?? 0) >= 1,
          `round ${i + 1} settlement roleOutcome must carry this-court payload(s)`,
        );
        assert.ok(
          (terminal!.submissions?.length ?? 0) >= (outcome.payloads?.length ?? 0),
          `round ${i + 1} submissions must keep at least this-court rows (history may grow)`,
        );
      }
    }
    assert.equal(prompts.length, 1 + roundBodies.length);
    // Differential: each gate round's dialogue differs — not one frozen constant
    // replayed every turn (#860 bug shape). Round bodies are distinct objects.
    assert.notEqual(prompts[1], prompts[2], "round 1 and 2 dialogue must differ");
    assert.notEqual(prompts[2], prompts[3], "round 2 and 3 dialogue must differ");
    assert.notEqual(prompts[1], prompts[3], "round 1 and 3 dialogue must differ");
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

test("#879 this-court receipt from settlement payloads; history stays on submissions", async () => {
  const thisCourt = { status: "bounce", findings: ["second"] };
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
          payloads: [thisCourt],
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "officer-run",
        submissions: [
          { status: "pass", findings: ["first"] },
          thisCourt,
        ],
      },
    }),
  });
  assert.equal(projected.result.status, "bounce");
  if (projected.result.status === "bounce") {
    assert.deepEqual(projected.result.receipt, thisCourt);
  }
  assert.deepEqual(projected.summoned?.terminal?.submissions, [
    { status: "pass", findings: ["first"] },
    thisCourt,
  ]);
});

test("#879 undivided submissions without scoped payloads are not this-court identity", async () => {
  // Multi-row undivided history: must not last-wins.
  const multi = await projectGatekeeperRun({
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
  assert.equal(multi.result.status, "bounce");
  if (multi.result.status === "bounce") {
    assert.notDeepEqual(
      multi.result.receipt,
      { status: "bounce", findings: ["second"] },
      "must not last-wins undivided multi-row submissions",
    );
  }

  // Sole unbound row: also not this-court identity (#879 delete sole-row guess).
  const sole = await projectGatekeeperRun({
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
        submissions: [{ status: "pass", findings: ["only"] }],
      },
    }),
  });
  // Without scoped payloads, queue uses outcome.status face — not the sole submissions row.
  assert.equal(sole.result.status, "pass");
  if (sole.result.status === "pass") {
    assert.notDeepEqual(
      sole.result.receipt,
      { status: "pass", findings: ["only"] },
      "must not guess sole unbound submissions row as this-court receipt",
    );
  }
});

test("#879 non-three-state then lawful pass converges; parent sees this-court pass only", async () => {
  const thisCourt = { status: "pass", findings: ["ok"] };
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
          payloads: [thisCourt],
        },
        navigator: { disposition: "no-advice" },
        artifacts: [],
        runId: "officer-run",
        submissions: [
          { status: "other", note: "first" },
          thisCourt,
        ],
      },
    }),
  });
  assert.equal(projected.result.status, "pass");
  if (projected.result.status === "pass") {
    assert.deepEqual(projected.result.receipt, thisCourt);
  }
  assert.deepEqual(projected.summoned?.terminal?.submissions, [
    { status: "other", note: "first" },
    thisCourt,
  ]);
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

test("#879 host-transition differential: station-child officer omits priorNativePaths; non-officer keeps them", async () => {
  await withTempRoot("ak-transition-diff-", async (home) => {
    const runDirectory = join(home, "run");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const priorPath = join(home, "prior-sitian.jsonl");
    await writeFile(priorPath, "{}", "utf8");
    const peer = "PEER-BODY-TRANSITION-DIFF";

    async function captureAcpPrompt(options: {
      readonly stationChild?: boolean;
      readonly role: string;
    }): Promise<string> {
      const prompts: string[] = [];
      const connection: AcpConnection = {
        async request(method, params) {
          if (method === "initialize") return { protocolVersion: 1 };
          if (method === "session/new") return { sessionId: "sess-879-diff" };
          if (method === "session/prompt") {
            const parts = params.prompt as ReadonlyArray<{ type?: string; text?: string }> | undefined;
            prompts.push(parts?.map((part) => part.text ?? "").join("") ?? "");
            return { stopReason: "end_turn" };
          }
          if (method === "session/close") return {};
          return {};
        },
        notify() {},
        async close() {},
      };
      const host = createAcpRoleTurnHost({
        hostName: "grok-build",
        modelPassing: "argv",
        boundResume: "session/new",
        sessionIdentity: {
          async load() {
            return undefined;
          },
          async bind() {},
          resolveSessionFile: () => join(runDirectory, "session", "session.jsonl"),
        },
        connect: async () => connection,
        prepare: async (request) => ({
          mcpServers: [{ name: "ak-probe", type: "stdio" }],
          systemPrompt: { body: "probe", materials: [] },
          prompt: request.continuation.prompt,
          jsonSchema: { type: "object" },
          terminatingToolName: "ak_notary_output",
          async ingestStructuredOutput() {},
          async closeRound() {
            return { accepted: true as const };
          },
        }),
      });
      const activation =
        options.role === "notary"
          ? ({ role: "notary", sourceRun: join(home, "parent") } as const)
          : ({ role: "judge" } as const);
      const result = await host.executeTurn({
        principal: fixturePrincipal(join(runDirectory, "session")),
        activation,
        methods: [],
        continuation: { kind: "resume", prompt: peer },
        cwd: home,
        home,
        agentDir: join(home, "agent"),
        runDirectory,
        ...(options.stationChild === undefined ? {} : { stationChild: options.stationChild }),
        hostTransition: {
          priorNativeKind: "sitian",
          priorNativePaths: [priorPath],
        },
      });
      assert.equal(result.code, 0, JSON.stringify(result));
      return prompts[0] ?? "";
    }

    // Differential: station-child officer omits prior paths; non-officer keeps them.
    const officerPrompt = await captureAcpPrompt({ stationChild: true, role: "notary" });
    const plainPrompt = await captureAcpPrompt({ role: "judge" });
    assert.equal(officerPrompt.includes(priorPath), false);
    assert.equal(plainPrompt.includes(priorPath), true);
    // Peer body present on both; no prompt===peer byte lock.
    assert.equal(officerPrompt.includes(peer), true);
    assert.equal(plainPrompt.includes(peer), true);
  });
});

test("#879 Pi adapter transition differential: station-child officer omits sitian priorNativePaths", async () => {
  await withTempRoot("ak-pi-officer-prior-", async (home) => {
    const runDirectory = join(home, "run");
    await mkdir(join(runDirectory, "session"), { recursive: true });
    const sessionFile = join(runDirectory, "session", "session.jsonl");
    await writeFile(sessionFile, "", "utf8");
    const priorPath = join(home, "prior-sitian.jsonl");
    await writeFile(priorPath, "{}", "utf8");
    const peer = "PEER-BODY-FOR-PI-BOUNDARY";

    async function capturePiPrompt(options: {
      readonly stationChild?: boolean;
      readonly role: "notary" | "judge";
    }): Promise<string> {
      let capturedArgs: readonly string[] | undefined;
      const host = createPiRoleTurnHost({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        spawnRunner: async (args) => {
          capturedArgs = args;
          return { code: 0, stderr: "", timedOut: false };
        },
      });
      const result = await host.executeTurn({
        principal: fixturePrincipal(join(runDirectory, "session"), sessionFile),
        activation:
          options.role === "notary"
            ? { role: "notary", sourceRun: join(home, "parent-run") }
            : { role: "judge" },
        methods: [],
        continuation: { kind: "resume", prompt: peer },
        cwd: home,
        home,
        agentDir: join(home, ".pi"),
        runDirectory,
        ...(options.stationChild === undefined ? {} : { stationChild: options.stationChild }),
        hostTransition: {
          priorNativeKind: "sitian",
          priorNativePaths: [priorPath],
        },
      });
      assert.equal(result.code, 0);
      assert.ok(capturedArgs !== undefined);
      return capturedArgs![capturedArgs!.length - 1]!;
    }

    const officerPrompt = await capturePiPrompt({ stationChild: true, role: "notary" });
    const plainPrompt = await capturePiPrompt({ role: "judge" });
    assert.equal(officerPrompt.includes(priorPath), false);
    assert.equal(plainPrompt.includes(priorPath), true);
    assert.equal(officerPrompt.includes(peer), true);
    assert.equal(plainPrompt.includes(peer), true);
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

    let registered: HostToolDefinition | undefined;
    const host = {
      deliverSubmissionRejection() {},
      registerTool(tool: HostToolDefinition) {
        registered = tool;
      },
      on() {},
    } as unknown as RoleHost;
    const pipeline = createSubmissionLedgerHost(
      host,
      new Map([[NOTARY_OUTPUT_TOOL_NAME, "notary"]]),
      undefined,
      async () => {},
      { home: root },
    );
    pipeline.registerTool({
      name: NOTARY_OUTPUT_TOOL_NAME,
      label: "output",
      description: "",
      parameters: Type.Object({}),
      execute: async (_id, params) => ({
        content: [],
        details: params,
        terminate: true,
      }),
    });
    const context = {
      cwd: root,
      mode: "json",
      model: undefined,
      sessionManager: {
        getHeader: () => ({ type: "session", id: `${runId}:attempt` }),
        getLeafEntry: () => undefined,
        getLeafId: () => null,
        getEntries: () => [],
        getSessionDir: () => sessionDirectory,
        getSessionFile: () => sessionFile,
      },
      abort() {
        throw new Error("ledger must not abort");
      },
    } as unknown as HostContext;

    const priorRun = process.env.AK_ROLE_RUN_DIR;
    const priorCourt = process.env.AK_ROLE_COURT_ATTEMPT;
    process.env.AK_ROLE_RUN_DIR = runDir;
    try {
      process.env.AK_ROLE_COURT_ATTEMPT = "court-1";
      await registered!.execute("c1", { status: "pass", findings: ["first"] }, undefined, undefined, context);
      process.env.AK_ROLE_COURT_ATTEMPT = "court-2";
      await registered!.execute("c2", { status: "bounce", findings: ["second"] }, undefined, undefined, context);

      const all = await readRecordedSubmissions(root, runId, root);
      assert.deepEqual(all, [
        { status: "pass", findings: ["first"] },
        { status: "bounce", findings: ["second"] },
      ]);

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
        } as AdmittedNotaryInvocation["sourceRun"],
      };

      // Court-2 seal: this-court roleOutcome only.
      const settled = await trySettleNotaryTerminalResult(
        admitted,
        piDurablePrincipalAuthority,
        { courtAttemptId: "court-2" },
      );
      assert.ok(settled !== undefined, "court-2 must settle");
      assert.equal(settled!.roleOutcome.kind, "accepted");
      if (settled!.roleOutcome.kind === "accepted") {
        assert.deepEqual(settled!.roleOutcome.payloads, [
          { status: "bounce", findings: ["second"] },
        ]);
      }
      const withHistory = await attachRecordedSubmissions(admitted, settled!, {
        courtAttemptId: "court-2",
      });
      assert.deepEqual(withHistory.submissions, all);
      if (withHistory.roleOutcome.kind === "accepted") {
        assert.deepEqual(withHistory.roleOutcome.payloads, [
          { status: "bounce", findings: ["second"] },
        ]);
      }

      // Scope present + zero this-court rows → no this-court outcome (no history fallback).
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

      // Gate parent return consumes settlement-scoped payloads.
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
        assert.deepEqual(projected.result.receipt, { status: "bounce", findings: ["second"] });
      }
      assert.deepEqual(projected.summoned?.terminal?.submissions, all);
    } finally {
      if (priorRun === undefined) delete process.env.AK_ROLE_RUN_DIR;
      else process.env.AK_ROLE_RUN_DIR = priorRun;
      if (priorCourt === undefined) delete process.env.AK_ROLE_COURT_ATTEMPT;
      else process.env.AK_ROLE_COURT_ATTEMPT = priorCourt;
    }
  });
});

test("#879 station-child officer: case dossier via attach transport, peer body intact", async () => {
  await withTempRoot("ak-officer-dossier-attach-", async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sourceRunPath = await seedCanonicalSourceRun(home, project, { ticketNumber: 879 });

    // Seed ticket provenance volume so 0081 has a real pointer target.
    const { resolveTicketProvenanceVolume } = await import("../../src/ticket-provenance.ts");
    const volume = resolveTicketProvenanceVolume(879, project, home);
    await mkdir(join(volume.humanViewFile, ".."), { recursive: true });
    await writeFile(volume.humanViewFile, "# 879 provenance\n", "utf8");
    await writeFile(volume.recordFile, "", "utf8");

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
        // Real send boundary: host sees the projected continuation.
        prompts.push(request.continuation.prompt);
        runDirs.push(request.runDirectory);
        assert.equal("materials" in request, false);
        return baseHost.executeTurn(request);
      },
    };

    const body = { countersignStatus: "converged", note: "DOSSIER-ATTACH-BODY" };
    const { readableGateItem } = await import("../../src/readable-gate-item.ts");
    const peerBody = readableGateItem(body);
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
    const sent = prompts[prompts.length - 1]!;

    // Peer dialogue instruction is the parent payload (prefix); attach transport
    // rides after via existing buildInstructionTransportPrompt shape.
    assert.equal(
      sent.startsWith(peerBody),
      true,
      "send-boundary prompt must keep parent payload as dialogue instruction prefix",
    );

    // Frozen attachment under run/attachments/case-dossier/ + path projected to seat.
    const officerRun = projected.summoned?.runDirectory ?? runDirs[runDirs.length - 1];
    assert.ok(officerRun, "officer run directory must exist");
    const { readdir, access } = await import("node:fs/promises");
    const attachRoot = join(officerRun!, "attachments");
    let foundPath: string | undefined;
    const top = await readdir(attachRoot);
    for (const name of top) {
      if (!name.includes("case-dossier")) continue;
      const files = await readdir(join(attachRoot, name));
      for (const file of files) {
        if (!file.includes("case-dossier-pointer")) continue;
        foundPath = join(attachRoot, name, file);
        const text = await readFile(foundPath, "utf8");
        assert.equal(text.includes(volume.humanViewFile), true);
        assert.equal(text.includes(volume.recordFile), true);
      }
    }
    assert.ok(foundPath, "0081 case dossier must hang as run attachment");
    // Send boundary must project the frozen path (existing attach transport).
    assert.equal(
      sent.includes(foundPath!),
      true,
      "send-boundary prompt must project frozen case-dossier path to the seat",
    );
    // Dossier volume paths live in the attachment file, not spliced as body rewrite
    // of the peer payload prefix.
    assert.equal(sent.startsWith(peerBody), true);
    // No leftover run-local staging copy.
    await assert.rejects(
      () => access(join(officerRun!, ".case-dossier-stage")),
      /ENOENT/,
    );
  });
});
