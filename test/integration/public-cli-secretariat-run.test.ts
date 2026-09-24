/**
 * Public Secretariat submission-gate path — through-line + escalate branch.
 * Real public CLI entry; faux host activates real secretariat runtime and
 * submits through production gate. Nested countersign goes through real runtime +
 * 符宝郎内闸 (requireSubmissionGate); body rewrite attribution = dirty-ticket real run.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { createAcpRoleTurnHost, type AcpConnection } from "../../src/acp-host/role-turn-host.ts";
import { createHeadlessRoleTurnHost } from "../../src/headless-host/role-turn-host.ts";
import {
  lookupHeadlessHostDescription,
  lookupHostDescription,
} from "../../src/host-descriptions.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { SECRETARIAT_OUTPUT_TOOL_NAME } from "../../src/secretariat-contracts.ts";
import type {
  HostContext,
  RoleHost,
  RoleTurnHost,
  RoleTurnRequest,
} from "../../src/host-contracts.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import {
  findRunDirectoryById,
  readRoleRunState,
} from "../../src/public-cli/run-lifecycle.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import {
  createCountersignRoleRuntime,
  createDiaristRoleRuntime,
  createSecretariatRoleRuntime,
  GatekeeperDecisionError,
} from "../../src/role-runtime.ts";
import { isAuditEscalationProjection } from "../../src/audit-escalation.ts";
import {
  recordAuditEscalationSubmission,
  sealAcceptedSubmission,
} from "../helpers/submission-ledger-fixture.ts";
import { createSessionIdentityAuthority } from "../../src/session-identity.ts";
import { readTicketProvenance } from "../../src/ticket-provenance.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { connect } from "node:net";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  objectPayloads,
  payloadStatusSequence,
} from "../helpers/terminal-payload.ts";
import { MAIN_ROLE_SESSION_MATERIALS } from "../../src/session-opening-materials.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../../src/activation-ledger-topology.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import {
  readSitianRecords,
  resolveSitianRecordPathInLedger,
} from "../../src/sitian-facade.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-public-cli-secretariat-", async (home) => {
    const quiet = captureIo().io;
    await runAkRole(
      [
        "config",
        "set",
        "secretariat",
        "test/caller-seat:high",
        "countersign",
        "test/caller-seat:high",
        "diarist",
        "test/caller-seat:high",
        "notary",
        "test/caller-seat:high",
        "inspector",
        "test/caller-seat:high",
        "auditor",
        "test/caller-seat:high",
        "gatekeeper",
        "test/caller-seat:high",
      ],
      { packageRoot, home, io: quiet },
    );
    return scenario(home);
  });
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function adapter(name: string, host: RoleTurnHost): NamedRoleTurnHostAdapter {
  return { name, create: () => ({ ok: true as const, host }) };
}

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "secretariat@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Secretariat Test"], {
    cwd: root,
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

/** Court diarist details through real accept hook (typed ticket bind or true-unbound). */
function courtDiaristWithDetails(
  details: Record<string, unknown>,
): LegacyFauxPiRunner {
  return async (args, options) => {
    let registered:
      | {
          readonly name: string;
          execute(
            toolCallId: string,
            parameters: unknown,
            signal: undefined,
            onUpdate: undefined,
            ctx: HostContext,
          ): Promise<{ details?: unknown }>;
        }
      | undefined;
    const host = {
      registerTool(tool: unknown) {
        registered = tool as typeof registered;
      },
      on() {},
      getAllTools: () =>
        registered === undefined ? [] : [{ name: registered.name }],
      setActiveTools() {},
      getActiveTools: () =>
        registered === undefined ? [] : [registered.name],
    } as unknown as RoleHost;
    await createDiaristRoleRuntime(host, {
      loadSoul: async () => "起居郎职分（测试装载）",
    }).activate();
    assert.ok(registered);
    const runDir = options.env.AK_ROLE_RUN_DIR ?? "";
    const sessionFile = argvFlagValue(args, "--session") ?? "";
    const result = await registered.execute(
      "call_diarist",
      details,
      undefined,
      undefined,
      {
        cwd: options.cwd,
        mode: "json",
        model: undefined,
        runDirectory: runDir,
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionDir: () => dirname(sessionFile),
          getEntries: () => [],
          getLeafEntry: () => undefined,
          getLeafId: () => null,
        },
        abort() {},
      } as HostContext,
    );
    return scriptedTerminatingToolSession({
      role: "diarist",
      toolName: registered.name,
      details: result.details ?? details,
    })(args, options);
  };
}

/** Court diarist asserts #924 through real accept hook (typed ticket bind). */
function courtDiaristFor924(): LegacyFauxPiRunner {
  return courtDiaristWithDetails({
    status: "completed",
    ticketNumber: 924,
    sessions: [] as const,
  });
}

/**
 * Nested countersign via real createCountersignRoleRuntime + 符宝郎内闸 hook.
 * Gate calls are recorded for external structured assertion (G2).
 */
function nestedCountersignHost(input: {
  packageRoot: string;
  sequence: ReadonlyArray<{ details: unknown; notaryEscalation?: unknown }>;
  gateCalls: Array<{ kind: string }>;
  diaristRunDirectories?: string[];
  countersignRequests?: RoleTurnRequest[];
  /** Override nested 起居郎 (default asserts #924). Omit-ticket cases pass unbound. */
  diaristRunner?: LegacyFauxPiRunner;
}): RoleTurnHost {
  let call = 0;
  const diarist = input.diaristRunner ?? courtDiaristFor924();
  const piRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "diarist") {
      input.diaristRunDirectories?.push(options.env.AK_ROLE_RUN_DIR ?? "");
      return diarist(args, options);
    }
    if (role === "countersign") {
      const step = input.sequence[call] ?? input.sequence.at(-1)!;
      call += 1;

      const tools = new Map<
        string,
        {
          name: string;
          execute: (
            id: string,
            params: unknown,
            signal: undefined,
            onUpdate: undefined,
            ctx: HostContext,
          ) => Promise<{ details?: unknown; terminate?: boolean }>;
        }
      >;
      let active: string[] = [];
      const roleHost = {
        registerTool(tool: {
          name: string;
          execute: (typeof tools extends Map<string, infer V> ? V : never)["execute"];
        }) {
          tools.set(tool.name, tool);
        },
        on() {},
        getAllTools: () => [...tools.keys()].map((name) => ({ name })),
        setActiveTools(names: string[]) {
          active = [...names];
        },
        getActiveTools: () => [...active],
        getFlag() {
          return "secretariat";
        },
        async requireSubmissionGate(options: { subject: { kind: string } }) {
          // Minimal fake 符宝郎内闸 host — records structured pass/escalation.
          input.gateCalls.push({ kind: options.subject.kind });
          if (step.notaryEscalation !== undefined) {
            throw new GatekeeperDecisionError({ status: "escalate", officer: "notary", receipt: step.notaryEscalation });
          }
        },
      } as unknown as RoleHost;

      await createCountersignRoleRuntime(
        roleHost,
        { loadSoul: async () => "给事中职分（测试装载）" },
        {
          failInfrastructure(): never {
            throw new Error("nested countersign infra");
          },
          bindSubmissionNonPass() {},
        },
      ).activate();

      const tool = tools.get("ak_submission_output");
      assert.ok(tool, "shared submission tool missing after real countersign activate");
      const runDir = options.env.AK_ROLE_RUN_DIR ?? "";
      const sessionFile = argvFlagValue(args, "--session") ?? "";
      const ctx = {
        cwd: options.cwd,
        mode: "json",
        model: undefined,
        runDirectory: runDir,
        sessionManager: {
          getSessionFile: () => sessionFile,
          getSessionDir: () => dirname(sessionFile),
          getEntries: () => [],
          getLeafEntry: () => undefined,
          getLeafId: () => null,
        },
        abort() {},
      } as HostContext;

      const executed = await tool.execute(
        `call_countersign_${call}`,
        step.details,
        undefined,
        undefined,
        ctx,
      );
      assert.equal(executed.terminate, true);

      const scripted = await scriptedTerminatingToolSession({
        role: "countersign",
        toolName: "ak_submission_output",
        details: step.details,
      })(args, options);
      return step.notaryEscalation === undefined ? scripted : {
        ...scripted,
        sealedAcceptance: { role: "countersign", details: step.details, outputDetails: executed.details },
      };
    }
    throw new Error(`unexpected nested role: ${role}`);
  };
  const host = roleTurnHostFromLegacyPiRunner({
    packageRoot: input.packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner,
  });
  return {
    executeTurn(request) {
      if (request.activation.role === "countersign") {
        input.countersignRequests?.push(request);
      }
      return host.executeTurn(request);
    },
  };
}

/**
 * Activate the real secretariat runtime through the shared submission gate.
 * `submissionGateHost` drives the production prepareRoleEnvelope.requireSubmissionGate path (no harness
 * reimplementation of the envelope summon closure).
 */
function secretariatHostDrivingRealTools(input: {
  packageRoot: string;
  home: string;
  steps: ReadonlyArray<{ kind: "output"; details: Record<string, unknown> }>;
  countersignSequence: ReadonlyArray<{ details: unknown; notaryEscalation?: unknown }>;
  gateCalls: Array<{ kind: string }>;
  diaristRunDirectories?: string[];
  countersignRequests?: RoleTurnRequest[];
  /** Host key — arms secretariat_verdict gate on output. */
  submissionGateHost: "codex" | "claude" | "grok-build" | "pi";
  /**
   * Nested 给事中 identity 起居郎 override. Parent secretariat identity still
   * uses #924; omit-ticket cases pass unbound so parent board handoff is the
   * sole identity source under test.
   */
  nestedDiaristRunner?: LegacyFauxPiRunner;
  parentDiaristRunner?: LegacyFauxPiRunner;
}): RoleTurnHost {
  // Parent identity 起居郎 always asserts #924 so the secretariat board is bound
  // before the gate; nested 给事中 identity may be overridden (unbound).
  const parentDiaristHost = roleTurnHostFromLegacyPiRunner({
    packageRoot: input.packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: async (args, options) => {
      const role = argvFlagValue(args, "--ak-role");
      if (role === "diarist") {
        input.diaristRunDirectories?.push(options.env.AK_ROLE_RUN_DIR ?? "");
        return (input.parentDiaristRunner ?? courtDiaristFor924())(args, options);
      }
      throw new Error(`parent diarist host unexpected role: ${role}`);
    },
  });

  // Production envelope wiring (home/packageRoot/hostAdapters).
  // Gate entry observed via nested countersignRequests — no harness
  // reimplementation of requireSubmissionGate / createDefaultGateOfficerSummon.
  {
    // Capture narrowed host for the closure (exactOptionalPropertyTypes).
    const submissionGateHost = input.submissionGateHost;
    // Always track nested summons so gate entry is observable without a custom
    // requireSubmissionGate push (tests may omit countersignRequests).
    const nestRequests = input.countersignRequests ?? [];
    const nestedTracked = nestedCountersignHost({
      packageRoot: input.packageRoot,
      sequence: input.countersignSequence,
      gateCalls: input.gateCalls,
      ...(input.diaristRunDirectories === undefined
        ? {}
        : { diaristRunDirectories: input.diaristRunDirectories }),
      countersignRequests: nestRequests,
      ...(input.nestedDiaristRunner === undefined
        ? {}
        : { diaristRunner: input.nestedDiaristRunner }),
    });
    const nestAdapters = [adapter("pi", nestedTracked)];
    return {
      async executeTurn(request: RoleTurnRequest) {
        // Parent 起居郎 binds the secretariat board; nested 给事中 uses nestAdapters.
        if (request.activation.role === "diarist") {
          return parentDiaristHost.executeTurn(request);
        }
        if (request.activation.role !== "secretariat") {
          return nestedTracked.executeTurn(request);
        }
        const socketDir = await mkdtemp(join(tmpdir(), "ak-969-sec-env-"));
        const coords = piDurablePrincipalAuthority.decode(request.principal);
        const prepared = await prepareRoleEnvelope({
          request: {
            ...request,
            host: submissionGateHost,
          },
          dependencies: {
            ...createRoleRuntimeDependencies(input.packageRoot),
            hostAdapters: nestAdapters,
          },
          socketPath: join(socketDir, "mcp.sock"),
          listTerminatingToolOnMcp: false,
          sessionFile: coords.sessionFile,
        });
        try {
          let nestBaseline = nestRequests.length;
          for (const step of input.steps) {
            // Production ingest → beforeAccept → envelope.requireSubmissionGate.
            await prepared.ingestStructuredOutput(step.details);
            const closed = await prepared.closeRound();
            const nestNow = nestRequests.length;
            if (nestNow > nestBaseline) {
              // Each nested 给事中 summon proves one secretariat_verdict entry.
              for (let i = nestBaseline; i < nestNow; i += 1) {
                input.gateCalls.push({ kind: "secretariat_verdict" });
              }
              nestBaseline = nestNow;
            }
            if (!closed.accepted && "retry" in closed && closed.retry !== undefined) {
              // bounce: next output step re-submits. Do not seal this round.
              continue;
            }
            // Ledger seal + durable custom entries ride the production envelope;
            // no parallel sitian/session write from this harness.
          }
          return { code: 0, stderr: "", timedOut: false };
        } finally {
          await prepared.dispose?.();
        }
      },
    };
  }

}

for (const hostName of ["codex", "claude", "grok-build", "pi"] as const) {
test(`${hostName} public entry: converged enters the shared gate`, async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = hostName === "codex"
      ? "01a0sec969-gate-7000-8000-000000000001"
      : hostName === "claude"
        ? "01a0sec969-gate-7000-8000-000000000011"
        : hostName === "grok-build"
          ? "01a0sec969-gate-7000-8000-000000000021"
          : "01a0sec969-gate-7000-8000-000000000031";
    const capture = captureIo();
    const firstTicket = hostName === "pi" ? undefined : 923;
    const gateCalls: Array<{ kind: string }> = [];
    const countersignRequests: RoleTurnRequest[] = [];
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
      gateCalls,
      countersignRequests,
      submissionGateHost: hostName,
      countersignSequence: [
        {
          details: {
            status: "continue",
            fix: { summary: "补齐实际 GitHub issue 身份" },
          },
        },
        { details: { status: "converged", note: "署" } },
      ],
      // Submission gate runs when the terminating output is submitted.
      steps: [
        {
          kind: "output",
          details: { secretariatStatus: "converged", ...(firstTicket === undefined ? {} : { ticketNumber: firstTicket }) },
        },
        {
          kind: "output",
          details: { secretariatStatus: "converged", ticketNumber: 924, note: "已按封驳改" },
        },
      ],
    });
    const result = await runAkRole(
      [
        "secretariat",
        "--model",
        "test/caller-seat:high",
        "--project",
        project,
        "整理票面并送庭。",
      ],
      {
        home,
        packageRoot,
        cwd: project,
        io: capture.io,
        createRunId: () => runId,
        roleTurnHost: host,
        hostAdapters: [adapter("pi", host)],
      },
    );
    assert.equal(result.exitCode, 0, capture.stderr.join(""));
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    // #836: bounce attempt + pass both recorded (调几次记几次); production envelope
    // ledger presents every original payload — not harness-only final seal.
    assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), [
      "converged",
      "converged",
    ]);
    const payloads = objectPayloads(result.terminal.roleOutcome);
    const facts = payloads[payloads.length - 1] as {
      secretariatStatus: string;
      ticketNumber?: number;
    };
    assert.equal(facts.secretariatStatus, "converged");
    assert.equal(facts.ticketNumber, 924);
    assert.equal((payloads[0] as { ticketNumber?: number }).ticketNumber, firstTicket,
      "the initial receipt must remain in the ledger before officer re-submission");
    assert.equal(await findRunDirectoryById(home, runId, undefined, "secretariat"),
      join(home, ".ak-roles", "books", "project", "924", "runs", `${runId}@secretariat`),
      "only the final reviewed ticket owns the run");
    // #969: 公开终局呈现给事中判词与 runId（settlement 唯一权威）.
    const countersignTerminal = result.terminal.roleOutcome.decisiveFacts
      ?.countersignTerminal as
      | { receipt?: unknown; runId?: string }
      | undefined;
    assert.ok(countersignTerminal, "accepted terminal must project countersignTerminal");
    assert.deepEqual(countersignTerminal.receipt, {
      status: "converged",
      note: "署",
    });
    assert.equal(
      typeof countersignTerminal.runId,
      "string",
      "accepted terminal must carry nested 给事中 runId",
    );
    assert.ok(
      (countersignTerminal.runId as string).length > 0,
      "nested runId must be non-empty",
    );
    // Shared gate entered twice (bounce then pass); nested 符宝郎 on 给事中.
    assert.equal(
      gateCalls.filter((c) => c.kind === "secretariat_verdict").length,
      2,
      `secretariat_verdict entries: ${JSON.stringify(gateCalls)}`,
    );
    assert.ok(
      gateCalls.some((c) => c.kind === "countersign_verdict"),
      `expected nested countersign_verdict, got ${JSON.stringify(gateCalls)}`,
    );
    assert.ok(
      countersignRequests.length >= 1,
      "gate must summon countersign",
    );
    // The submission changed #923 to #924: same parent is not same ticket.
    assert.equal(countersignRequests.filter((r) => r.continuation.kind === "resume").length, 0);
  });
});
}


test("#969 non-pi 给事中上呈 ends parent with officer receipt (no rewrite)", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "01a0sec969-cse-7000-8000-000000000003";
    const capture = captureIo();
    const gateCalls: Array<{ kind: string }> = [];
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
      gateCalls,
      submissionGateHost: "codex",
      countersignSequence: [
        {
          details: {
            status: "escalate",
            decisionGate: {
              question: "票面争议上呈？",
              options: ["再议", "准"],
            },
          },
        },
      ],
      steps: [
        {
          kind: "output",
          details: { secretariatStatus: "converged", ticketNumber: 924 },
        },
      ],
    });
    const result = await runAkRole(
      [
        "secretariat",
        "--model",
        "test/caller-seat:high",
        "--project",
        project,
        "整理 #924 票面并送庭。",
      ],
      {
        home,
        packageRoot,
        cwd: project,
        io: capture.io,
        createRunId: () => runId,
        roleTurnHost: host,
        hostAdapters: [adapter("pi", host)],
      },
    );
    assert.equal(result.exitCode, 0, capture.stderr.join(""));
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "audit_escalation");
    const facts = objectPayloads(result.terminal.roleOutcome)[0] as {
      status?: string;
      decisionGate?: { question?: string };
    };
    assert.equal(facts.status, "escalate");
    assert.equal(facts.decisionGate?.question, "票面争议上呈？");
    // #969: 上呈终局呈现给事中判词（payloads）与 runId（decisiveFacts）.
    const countersignTerminal = result.terminal.roleOutcome.decisiveFacts
      ?.countersignTerminal as
      | { receipt?: unknown; runId?: string }
      | undefined;
    assert.ok(countersignTerminal, "escalate terminal must project countersignTerminal");
    assert.deepEqual(countersignTerminal.receipt, {
      status: "escalate",
      decisionGate: {
        question: "票面争议上呈？",
        options: ["再议", "准"],
      },
    });
    assert.equal(
      typeof countersignTerminal.runId,
      "string",
      "escalate terminal must carry nested 给事中 runId",
    );
    assert.ok(
      (countersignTerminal.runId as string).length > 0,
      "nested runId must be non-empty",
    );
    assert.ok(
      gateCalls.some((c) => c.kind === "secretariat_verdict"),
      "must enter secretariat_verdict before 给事中 escalate",
    );
  });
});

test("nested Notary escalation reaches the Secretariat public terminal with its verdict", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const receipt = { status: "escalate", decisionGate: { question: "notary?", options: ["yes"] } };
    const result = await runAkRole(
      ["secretariat", "--model", "test/caller-seat:high", "--project", project, "整理 #924 票面并送庭。"],
      {
        home, packageRoot, cwd: project, io: captureIo().io,
        createRunId: () => "01a0sec1021-nst-7000-8000-000000000001",
        roleTurnHost: secretariatHostDrivingRealTools({
          packageRoot, home, gateCalls: [], submissionGateHost: "codex",
          countersignSequence: [{ details: { status: "converged" }, notaryEscalation: receipt }],
          steps: [{ kind: "output", details: { secretariatStatus: "converged", ticketNumber: 924 } }],
        }),
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.kind, "audit_escalation");
    const countersignTerminal = result.terminal?.roleOutcome.decisiveFacts?.countersignTerminal as { receipt?: unknown } | undefined;
    assert.deepEqual(countersignTerminal?.receipt, receipt);
  });
});

test("public Secretariat gate reads the shared status field from Countersign", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const gateCalls: Array<{ kind: string }> = [];
    const capture = captureIo();
    const result = await runAkRole(
      ["secretariat", "--model", "test/caller-seat:high", "--project", project, "整理并送庭。"],
      {
        home,
        packageRoot,
        cwd: project,
        io: capture.io,
        createRunId: () => "01a0sec1028-shared-status-7000-8000-000000000001",
        roleTurnHost: secretariatHostDrivingRealTools({
          packageRoot,
          home,
          gateCalls,
          submissionGateHost: "codex",
          countersignSequence: [{ details: { status: "converged", note: "署" } }],
          steps: [{ kind: "output", details: { secretariatStatus: "converged", ticketNumber: 924 } }],
        }),
      },
    );

    assert.equal(result.exitCode, 0, capture.stderr.join(""));
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.ok(gateCalls.some((call) => call.kind === "secretariat_verdict"));
  });
});

test("#969 non-pi secretariat escalate skips 给事中 gate", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "01a0sec969-esc-7000-8000-000000000002";
    const capture = captureIo();
    const gateCalls: Array<{ kind: string }> = [];
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
      gateCalls,
      submissionGateHost: "claude",
      // Prior pass books a durable officer entry; parent escalate must not inherit it.
      countersignSequence: [
        { details: { status: "converged", note: "先署" } },
      ],
      steps: [
        {
          kind: "output",
          details: { secretariatStatus: "converged", ticketNumber: 924 },
        },
        {
          kind: "output",
          details: {
            secretariatStatus: "escalate",
            decisionGate: {
              question: "是否拆席？",
              options: ["暂不", "拆"],
            },
          },
        },
      ],
    });
    const result = await runAkRole(
      [
        "secretariat",
        "--model",
        "test/caller-seat:high",
        "--project",
        project,
        "整理 #924；须上呈。",
      ],
      {
        home,
        packageRoot,
        cwd: project,
        io: capture.io,
        createRunId: () => runId,
        roleTurnHost: host,
        hostAdapters: [adapter("pi", host)],
      },
    );
    assert.equal(result.exitCode, 0, capture.stderr.join(""));
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    const payloads = objectPayloads(result.terminal.roleOutcome);
    const facts = payloads[payloads.length - 1] as {
      secretariatStatus: string;
      decisionGate?: { question?: string };
    };
    assert.equal(facts.secretariatStatus, "escalate");
    assert.equal(facts.decisionGate?.question, "是否拆席？");
    assert.equal(
      gateCalls.filter((c) => c.kind === "secretariat_verdict").length,
      1,
      "only prior converged enters secretariat_verdict; escalate skips",
    );
    // Stale prior 给事中署 must not project onto parent-escalate terminal.
    assert.equal(
      result.terminal.roleOutcome.decisiveFacts?.countersignTerminal,
      undefined,
      "parent escalate terminal must not project prior countersignTerminal",
    );
  });
});

for (const preliminaryTicket of [null, 923] as const) {
  test(`Secretariat's submitted issue follows preliminary ${preliminaryTicket ?? "unbound"} diarist identity`, async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sessionPath = join(home, ".claude", "projects", "ticket", "session.jsonl");
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, `${JSON.stringify({ type: "user", uuid: "new-ticket-owner", message: { role: "user", content: "请辨认并建立本票。" }, origin: { kind: "human" } })}\n`, "utf8");
    const gateCalls: Array<{ kind: string }> = [];
    const countersignRequests: RoleTurnRequest[] = [];
    const diaristRunDirectories: string[] = [];
    let parentDiaristFirstTurn = true;
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
      gateCalls,
      countersignRequests,
      diaristRunDirectories,
      submissionGateHost: "codex",
      parentDiaristRunner: (args, options) => {
        const first = parentDiaristFirstTurn;
        parentDiaristFirstTurn = false;
        return courtDiaristWithDetails(first
          ? { status: "completed", ticketNumber: preliminaryTicket,
            sessions: [{ path: sessionPath, ranges: [{ from: { line: 1 }, to: { line: 1 } }] }] }
          : { status: "completed", ticketNumber: 923 })(args, options);
      },
      nestedDiaristRunner: courtDiaristWithDetails({ status: "escalate", reason: "uncertain evidence" }),
      countersignSequence: [{ details: { status: "converged", note: "署" } }],
      steps: [{ kind: "output", details: { secretariatStatus: "converged", ticketNumber: 924 } }],
    });
    const result = await runAkRole(
      ["secretariat", "--model", "test/caller-seat:high", "--project", project, "请辨认并建立本票。"],
      { home, packageRoot, cwd: project, io: captureIo().io,
        createRunId: () => "01a0sec1025-0000-7000-8000-000000000001",
        roleTurnHost: host, hostAdapters: [adapter("pi", host)] },
    );
    assert.equal(result.terminal?.roleOutcome.kind, "audit_escalation");
    const childId = (result.terminal.roleOutcome.decisiveFacts?.countersignTerminal as { runId?: string } | undefined)?.runId;
    assert.ok(childId, "the escalation points at the nested diarist, not parked Countersign");
    const resumed = await runAkRole(["resume", childId],
      { home, packageRoot, cwd: project, io: captureIo().io, roleTurnHost: host, hostAdapters: [adapter("pi", host)] });
    assert.equal(resumed.exitCode, 0);
    assert.equal(resumed.terminal?.roleOutcome.role, "secretariat", "resuming the diarist continues both waiting parents");
    assert.ok(gateCalls.some((call) => call.kind === "secretariat_verdict"),
      "new-issue summons must reach Secretariat before any diarist identity assertion");
    assert.equal(result.exitCode, 0);
    assert.ok(countersignRequests.length > 0, "an unbound gate summons must reach Countersign");
    assert.ok(diaristRunDirectories.some((directory) => directory.includes(join("924", "runs"))),
      "the court diarist receives the submitted issue identity before Countersign reads it");
    const book = join(home, ".ak-roles", "books", "project");
    const runName = "01a0sec1025-0000-7000-8000-000000000001@secretariat";
    assert.equal(
      JSON.parse(await readFile(join(book, "924", "runs", runName, "admitted-request.json"), "utf8")).ticketNumber,
      924,
      "the completed new-ticket run must be archived under its ticket",
    );
    assert.equal((await readTicketProvenance(preliminaryTicket ?? 924, project, home)).lines[0]?.id,
      "new-ticket-owner", "the diarist's own assertion stays intact; only unbound records follow the final issue");
  });
  });
}

test("diarist escalation pauses Secretariat before its turn", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const gateCalls: Array<{ kind: string }> = [];
    let diaristTurns = 0;
    const host = secretariatHostDrivingRealTools({
      packageRoot, home, gateCalls, submissionGateHost: "codex",
      parentDiaristRunner: async (args, options) => {
        diaristTurns += 1;
        return courtDiaristWithDetails(diaristTurns === 1
          ? { status: "escalate", reason: "uncertain bounds" }
          : { status: "converged", ticketNumber: 924 })(args, options);
      },
      nestedDiaristRunner: courtDiaristWithDetails({ status: "completed", ticketNumber: 924 }),
      countersignSequence: [{ details: { status: "converged", note: "署" } }],
      steps: [{ kind: "output", details: { secretariatStatus: "converged", ticketNumber: 924 } }],
    });
    const result = await runAkRole(
      ["secretariat", "--model", "test/caller-seat:high", "--project", project, "请建立本票。"],
      { home, packageRoot, cwd: project, io: captureIo().io,
        roleTurnHost: host, hostAdapters: [adapter("pi", host)] },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.role, "diarist");
    assert.ok(result.terminal);
    assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), ["escalate"]);
    assert.equal(gateCalls.some((call) => call.kind === "secretariat_verdict"), false);
    const childDirectory = await findRunDirectoryById(home, result.terminal.runId!);
    assert.ok(childDirectory);
    await writeFile(join(childDirectory, "session", "session.jsonl"), "", "utf8");
    const resumeIo = captureIo();
    const resumed = await runAkRole(
      ["resume", result.terminal.runId!],
      { home, packageRoot, cwd: project, io: resumeIo.io,
        roleTurnHost: host, hostAdapters: [adapter("pi", host)] },
    );
    assert.equal(resumed.exitCode, 0, resumeIo.stderr.join(""));
    assert.equal(resumed.terminal?.roleOutcome.role, "secretariat");
    assert.equal(gateCalls.some((call) => call.kind === "secretariat_verdict"), true);
  });
});

/** Distinct court attempt ids from ledger subject.attemptId (not row count). */
async function distinctCourtAttemptIds(input: {
  cwd: string;
  home: string;
  runId: string;
  runDirectory: string;
}): Promise<Set<string>> {
  const sessionParent = join(input.runDirectory, "session", "session.jsonl");
  const ptr = resolveSitianRecordPathInLedger(
    {
      level: "event",
      kind: "candidate",
      subject: { runId: input.runId },
      cwd: input.cwd,
      sessionParent,
    },
    resolveActivationLedgerHome(input.home),
  );
  const { records } = await readSitianRecords(ptr.recordFile);
  const ids = new Set<string>();
  for (const record of records) {
    const subject = record.subject as { attemptId?: unknown } | undefined;
    if (typeof subject?.attemptId === "string" && subject.attemptId.length > 0) {
      ids.add(subject.attemptId);
    }
  }
  return ids;
}

/**
 * #969 shortest adapter convergence boundary.
 * Real headless (codex/claude) / ACP (grok-build) adapter → prepareRoleEnvelope
 * production requireSubmissionGate. Nested 给事中 reuses nestedCountersignHost so
 * the envelope summon closure is bitten without copying the full gate flow.
 */
async function adapterBoundaryCase(input: {
  hostName: "codex" | "claude" | "grok-build";
  receipt: Record<string, unknown>;
}): Promise<{ gateEntered: boolean }> {
  return withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    // Must sit under home/.ak-roles so homeFromRunDirectory / nested summons resolve.
    const runDirectory = join(
      home,
      ".ak-roles",
      "books",
      "test-book",
      "unbound",
      "runs",
      "01a0adp969-0000-7000-8000-000000000001@secretariat",
    );
    await mkdir(join(runDirectory, "session"), { recursive: true });
    await writeFile(
      join(runDirectory, "admitted-request.json"),
      `${JSON.stringify({
        ticketNumber: 924,
        projectRoot: project,
        runId: "01a0adp969-0000-7000-8000-000000000001",
        role: "secretariat",
      })}\n`,
      "utf8",
    );
    await writeFile(
      join(runDirectory, "invocation.json"),
      `${JSON.stringify({ ticketNumber: 924, role: "secretariat" })}\n`,
      "utf8",
    );

    const gateCalls: Array<{ kind: string }> = [];
    const countersignRequests: RoleTurnRequest[] = [];
    const nest = nestedCountersignHost({
      packageRoot,
      sequence: [{ details: { status: "converged", note: "署" } }],
      gateCalls,
      countersignRequests,
    });
    const nestAdapters = [adapter("pi", nest)];
    const socketDir = await mkdtemp(join(tmpdir(), "ak-969-adp-sock-"));
    const sessionFile = join(runDirectory, "session", "session.jsonl");
    const request: RoleTurnRequest = {
      principal: fixturePrincipal(join(runDirectory, "session")),
      activation: { role: "secretariat" },
      methods: [],
      continuation: { kind: "initial", prompt: "整理 #924" },
      model: { provider: "test", model: "caller-seat", thinking: "high" },
      cwd: project,
      home,
      agentDir: join(home, "agent"),
      runDirectory,
      host: input.hostName,
    };

    const prepare = () =>
      prepareRoleEnvelope({
        request,
        dependencies: {
          ...createRoleRuntimeDependencies(packageRoot),
          hostAdapters: nestAdapters,
        },
        socketPath: join(socketDir, "mcp.sock"),
        listTerminatingToolOnMcp: input.hostName === "grok-build",
        sessionFile,
      });

    if (input.hostName === "grok-build") {
      const description = lookupHostDescription("grok-build");
      assert.ok(description);
      let mcpSocket: string | undefined;
      let mcpToken: string | undefined;
      const connection: AcpConnection = {
        async request(method, params) {
          if (method === "initialize") return { protocolVersion: 1 };
          if (method === "session/new" || method === "session/load") {
            const servers =
              (params as {
                mcpServers?: Array<{ env?: Array<{ name: string; value: string }> }>;
              })?.mcpServers ?? [];
            const envRows = servers[0]?.env ?? [];
            mcpSocket = envRows.find((e) => e.name === "AK_ACP_MCP_SOCKET")?.value;
            mcpToken = envRows.find((e) => e.name === "AK_ACP_MCP_TOKEN")?.value;
            return { sessionId: "acp-969-sess" };
          }
          if (method === "session/prompt") {
            assert.ok(mcpSocket && mcpToken, "MCP socket/token required");
            await new Promise<void>((resolve, reject) => {
              const sock = connect(mcpSocket!);
              let buf = "";
              sock.setEncoding("utf8");
              sock.on("data", (chunk) => {
                buf += chunk;
                if (buf.includes("\n")) {
                  sock.destroy();
                  resolve();
                }
              });
              sock.on("error", reject);
              sock.on("connect", () => {
                sock.write(
                  `${JSON.stringify({
                    id: 1,
                    token: mcpToken,
                    method: "tools/call",
                    params: {
                      name: SECRETARIAT_OUTPUT_TOOL_NAME,
                      arguments: input.receipt,
                    },
                  })}\n`,
                );
              });
            });
            return { stopReason: "end_turn" };
          }
          if (method === "session/close") return {};
          return {};
        },
        notify() {},
        onNotification() {},
        async close() {},
      };
      const host = createAcpRoleTurnHost({
        hostName: "grok-build",
        modelPassing: "argv",
        boundResume: "session/new",
        sessionIdentity: createSessionIdentityAuthority(
          piDurablePrincipalAuthority,
          description.sessionBindingFile,
        ),
        connect: async () => connection,
        prepare,
      });
      const result = await host.executeTurn(request);
      assert.equal(result.knownFailure, undefined, JSON.stringify(result));
      return { gateEntered: countersignRequests.length > 0 };
    }

    const description = lookupHeadlessHostDescription(input.hostName);
    assert.ok(description);
    const fakeBin = join(home, `fake-${input.hostName}`);
    if (input.hostName === "codex") {
      await writeFile(
        fakeBin,
        `#!/usr/bin/env node
const receipt = ${JSON.stringify(JSON.stringify(input.receipt))};
process.stdout.write([
  JSON.stringify({ type: "thread.started", thread_id: "t-969" }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: receipt } }),
  JSON.stringify({ type: "turn.completed" }),
].join("\\n") + "\\n");
`,
        "utf8",
      );
    } else {
      await writeFile(
        fakeBin,
        `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "result",
  session_id: "claude-969",
  structured_output: ${JSON.stringify(input.receipt)},
}) + "\\n");
`,
        "utf8",
      );
    }
    await chmod(fakeBin, 0o755);
    const host = createHeadlessRoleTurnHost({
      description,
      hostName: input.hostName,
      binary: fakeBin,
      sessionIdentity: createSessionIdentityAuthority(
        piDurablePrincipalAuthority,
        description.sessionBindingFile,
      ),
      prepare,
    });
    const result = await host.executeTurn(request);
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    return { gateEntered: countersignRequests.length > 0 };
  });
}

for (const hostName of ["codex", "claude", "grok-build"] as const) {
  test(`#969 adapter boundary ${hostName}: converged enters gate`, async () => {
    const { gateEntered } = await adapterBoundaryCase({
      hostName,
      receipt: { secretariatStatus: "converged", ticketNumber: 924 },
    });
    assert.equal(
      gateEntered,
      true,
      `${hostName} converged must summon 给事中 via production envelope`,
    );
  });

  test(`#969 adapter boundary ${hostName}: escalate skips gate`, async () => {
    const { gateEntered } = await adapterBoundaryCase({
      hostName,
      receipt: {
        secretariatStatus: "escalate",
        decisionGate: { question: "q", options: ["a"] },
      },
    });
    assert.equal(
      gateEntered,
      false,
      `${hostName} escalate must not summon 给事中`,
    );
  });
}
