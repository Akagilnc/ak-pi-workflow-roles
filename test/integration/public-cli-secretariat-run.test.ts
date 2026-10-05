/**
 * Public Secretariat submission-gate path — through-line + escalate branch.
 * Real public CLI entry; faux host activates real secretariat runtime and
 * submits through production gate. Nested countersign goes through real runtime +
 * Public-entry audit (requireSubmissionGate); body rewrite attribution = dirty-ticket real run.
 */
import { readCurrentSection, seedCurrentSection, assertNoRetiredDossierFiles } from "../helpers/run-dossier-fixture.ts";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
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
import { SECRETARIAT_OUTPUT_TOOL_NAME } from "../../src/secretariat-contracts.ts";
import { readRecordedSubmissionRows } from "../../src/submission-ledger.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import type {
  HostContext,
  RoleHost,
  RoleTurnHost,
  RoleTurnRequest,
} from "../../src/host-contracts.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import {
  findRunDirectoryById,
  readRoleRunIdentity,
} from "../../src/public-cli/run-lifecycle.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import {
  createCountersignRoleRuntime,
  createDiaristRoleRuntime,
} from "../../src/role-runtime.ts";
import { createSessionIdentityAuthority } from "../../src/session-identity.ts";
import { readTicketProvenanceRecords as readTicketProvenance } from "../helpers/ticket-provenance-fixture.ts";
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
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import {
  objectPayloads,
  payloadStatusSequence,
} from "../helpers/terminal-payload.ts";
import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";

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

function adapter(name: string, host: RoleTurnHost): NamedRoleTurnHostAdapter {
  return { name, create: () => ({ ok: true as const, host }) };
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
  countersignRequests?: RoleTurnRequest[];
}): RoleTurnHost {
  let call = 0;
  const piRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      input.gateCalls.push({ kind: "countersign_verdict" });
      const step = input.sequence[Math.max(0, call - 1)] ?? input.sequence.at(-1)!;
      return scriptedTerminatingToolSession({
        role: "notary", toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: step.notaryEscalation ?? { status: "converged" },
      })(args, options);
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
      } as unknown as RoleHost;

      await createCountersignRoleRuntime(
        roleHost,
        { loadSoul: async () => "给事中职分（测试装载）" },
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
        input.gateCalls.push({ kind: "secretariat_verdict" });
      }
      return host.executeTurn(request);
    },
  };
}

/**
 * Activate the real secretariat runtime before the public-entry audit.
 * `submissionGateHost` selects the parent host; the entry summons reviewers afterward.
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
  parentDiaristRunner?: LegacyFauxPiRunner;
}): RoleTurnHost {
  // The secretariat's preliminary diarist asserts #924 before the gate.
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
  let nextStep = 0;

  // Production public-entry wiring (home/packageRoot/hostAdapters).
  // Gate entry observed via nested countersignRequests — no harness
  // reimplementation of requireSubmissionGate / createDefaultGateOfficerSummon.
  {
    // Capture narrowed host for the closure (exactOptionalPropertyTypes).
    const submissionGateHost = input.submissionGateHost;
    // Track nested summons so public gate entry is observable.
    const nestRequests = input.countersignRequests ?? [];
    const nestedTracked = nestedCountersignHost({
      packageRoot: input.packageRoot,
      sequence: input.countersignSequence,
      gateCalls: input.gateCalls,
      countersignRequests: nestRequests,
    });
    const nestAdapters = [adapter("pi", nestedTracked)];
    return {
      async executeTurn(request: RoleTurnRequest) {
        // The preliminary diarist binds the secretariat board; gate seats use nestAdapters.
        if (request.activation.role === "diarist") {
          return nextStep === 0
            ? parentDiaristHost.executeTurn(request)
            : nestedTracked.executeTurn(request);
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
          while (nextStep < input.steps.length) {
            const step = input.steps[nextStep++]!;
            // One accepted tool call finishes the turn; a reviewer rejection
            // resumes this same host for the next submitted output.
            await prepared.ingestStructuredOutput(step.details);
            const closed = await prepared.closeRound();
            if (!closed.accepted && "retry" in closed && closed.retry !== undefined) {
              continue;
            }
            break;
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
    // Package-owned audit rework is a summons: only this court answers.
    // Both original receipts remain on terminal.submissions (#1032 / #836).
    assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), ["converged"]);
    const payloads = objectPayloads(result.terminal.roleOutcome);
    const facts = payloads[payloads.length - 1] as {
      secretariatStatus: string;
      ticketNumber?: number;
    };
    assert.equal(facts.secretariatStatus, "converged");
    assert.equal(facts.ticketNumber, 924);
    assert.deepEqual(result.terminal.submissions, [
      {
        secretariatStatus: "converged",
        ...(firstTicket === undefined ? {} : { ticketNumber: firstTicket }),
      },
      { secretariatStatus: "converged", ticketNumber: 924, note: "已按封驳改" },
    ]);
    assert.equal(await findRunDirectoryById(home, runId, undefined, "secretariat"),
      join(home, ".ak-roles", "books", "project", String(firstTicket ?? 924), "runs", `${runId}@secretariat`),
      "the first typed ticket remains the run identity after reviewer resubmission");
    // The public-entry leg at rest carries none of the retired dossier files (#1161).
    assertNoRetiredDossierFiles(join(home, ".ak-roles", "books", "project", String(firstTicket ?? 924), "runs", `${runId}@secretariat`));
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
        { details: { status: "converged", note: "署" } },
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
    assert.equal(result.terminal.roleOutcome.role, "countersign");
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    assert.notEqual(result.terminal.roleOutcome.kind, "audit_escalation");
    const facts = objectPayloads(result.terminal.roleOutcome)[0] as {
      status?: string;
      decisionGate?: { question?: string };
    };
    assert.equal(facts.status, "escalate");
    assert.equal(facts.decisionGate?.question, "票面争议上呈？");
    const parentDirectory = await findRunDirectoryById(home, runId, undefined, "secretariat");
    assert.ok(parentDirectory);
    assert.equal((await readRoleRunIdentity(parentDirectory))?.state, "terminal");
    assert.ok(
      gateCalls.some((c) => c.kind === "secretariat_verdict"),
      "must enter secretariat_verdict before 给事中 escalate",
    );
    const resumed = await runAkRole(["resume", result.terminal.runId!], {
      home, packageRoot, cwd: project, io: captureIo().io,
      roleTurnHost: host, hostAdapters: [adapter("pi", host)],
    });
    assert.equal(resumed.terminal?.roleOutcome.role, "secretariat", "one child resume continues the parent");
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
    assert.equal(result.terminal?.roleOutcome.role, "notary");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(objectPayloads(result.terminal.roleOutcome).at(-1), receipt);
    const parentDirectory = await findRunDirectoryById(home, "01a0sec1021-nst-7000-8000-000000000001", undefined, "secretariat");
    assert.ok(parentDirectory);
    assert.equal((await readRoleRunIdentity(parentDirectory))?.state, "terminal");
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
      // A rejection resumes Secretariat; its next output escalates and must
      // not inherit the earlier officer review.
      countersignSequence: [
        { details: { status: "continue", note: "先补正" } },
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

test("#1165 secretariat --attach hands caller path to court diarist as-is", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const relativeAttach = "notes/sec-attach.md";
    await mkdir(join(project, "notes"), { recursive: true });
    await writeFile(join(project, relativeAttach), "sec material", "utf8");
    const gateCalls: Array<{ kind: string }> = [];
    const diaristRunDirectories: string[] = [];
    let diaristStdin: string | undefined;
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
      gateCalls,
      diaristRunDirectories,
      submissionGateHost: "codex",
      parentDiaristRunner: (args, options) => {
        diaristStdin = options?.stdin;
        return courtDiaristFor924()(args, options);
      },
      countersignSequence: [{ details: { status: "converged", note: "署" } }],
      steps: [{ kind: "output", details: { secretariatStatus: "converged", ticketNumber: 924 } }],
    });
    const result = await runAkRole(
      [
        "secretariat",
        "--model", "test/caller-seat:high",
        "--project", project,
        "--attach", relativeAttach,
        "请辨认并建立本票。",
      ],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => "01a0sec1165-0000-7000-8000-000000000001",
        roleTurnHost: host,
        hostAdapters: [adapter("pi", host)],
      },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(diaristRunDirectories.length, 1, "secretariat must summon court diarist");
    // Handoff proof: court diarist first message carries the caller path as-is.
    assert.ok(
      (diaristStdin ?? "").includes(relativeAttach),
      "diarist first message must carry the caller attach path",
    );
    assert.equal((diaristStdin ?? "").includes(join(project, relativeAttach)), false);

    // After ticket bind the diarist run leaves unbound/; read the relocated admitted page.
    const book = join(home, ".ak-roles", "books", resolveBookKeyFromGit(project));
    const diaristLeaves = (await readdir(join(book, "924", "runs")))
      .filter((name) => name.endsWith("@diarist"));
    assert.equal(diaristLeaves.length, 1);
    const diaristAdmitted = readCurrentSection(
      join(book, "924", "runs", diaristLeaves[0]!),
      "admitted",
    ) as { attachments: Array<{ path: string }> };
    assert.deepEqual(
      diaristAdmitted.attachments.map((attachment) => attachment.path),
      [relativeAttach],
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
      countersignSequence: [{ details: { status: "converged", note: "署", ticketNumber: 924 } }],
      steps: [{ kind: "output", details: { secretariatStatus: "converged", ticketNumber: 924 } }],
    });
    const result = await runAkRole(
      ["secretariat", "--model", "test/caller-seat:high", "--project", project, "请辨认并建立本票。"],
      { home, packageRoot, cwd: project, io: captureIo().io,
        createRunId: () => "01a0sec1025-0000-7000-8000-000000000001",
        roleTurnHost: host, hostAdapters: [adapter("pi", host)] },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.role, "secretariat");
    assert.ok(countersignRequests.length > 0, "the gate summons must reach Countersign");
    assert.equal(diaristRunDirectories.length, 1, "only Secretariat summons the preliminary diarist");
    const book = join(home, ".ak-roles", "books", "project");
    const runName = "01a0sec1025-0000-7000-8000-000000000001@secretariat";
    assert.equal(
      readCurrentSection(join(book, "924", "runs", runName), "admitted").ticketNumber,
      924,
      "the completed new-ticket run must be archived under its ticket",
    );
    assert.equal((await readTicketProvenance(preliminaryTicket ?? 924, project, home)).lines[0]?.id,
      "new-ticket-owner", "the diarist's own assertion stays intact; only unbound records follow the final issue");
  });
  });
}

test("diarist escalation pauses only the diarist; Secretariat proceeds and does not rebind the child's ticket", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const gateCalls: Array<{ kind: string }> = [];
    const parentRunId = "01a0sec1025-0000-7000-8000-000000000002";
    const host = secretariatHostDrivingRealTools({
      packageRoot, home, gateCalls, submissionGateHost: "codex",
      parentDiaristRunner: courtDiaristWithDetails({ status: "escalate", reason: "uncertain bounds", ticketNumber: 923 }),
      countersignSequence: [{ details: { status: "converged", note: "署" } }],
      steps: [{ kind: "output", details: { secretariatStatus: "converged", ticketNumber: 924 } }],
    });
    const result = await runAkRole(
      ["secretariat", "--model", "test/caller-seat:high", "--project", project, "请建立本票。"],
      { home, packageRoot, cwd: project, io: captureIo().io, createRunId: () => parentRunId,
        roleTurnHost: host, hostAdapters: [adapter("pi", host)] },
    );
    assert.equal(result.exitCode, 0);
    assert.equal(result.terminal?.roleOutcome.role, "secretariat");
    assert.equal(gateCalls.some((call) => call.kind === "secretariat_verdict"), true);
    const book = join(home, ".ak-roles", "books", resolveBookKeyFromGit(project));
    assert.equal(await findRunDirectoryById(home, parentRunId, undefined, "secretariat"),
      join(book, "924", "runs", `${parentRunId}@secretariat`));
    const diaristRuns = await readdir(join(book, "923", "runs"));
    assert.equal(diaristRuns.filter((name) => name.endsWith("@diarist")).length, 1,
      "the escalated diarist run stays under its own ticket");
  });
});

test("preliminary diarist technical failure settles the admitted Secretariat run", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const gateCalls: Array<{ kind: string }> = [];
    const hostFailure = new Error("diarist host unavailable");
    const host = secretariatHostDrivingRealTools({
      packageRoot, home, gateCalls, submissionGateHost: "codex",
      parentDiaristRunner: async () => { throw hostFailure; },
      countersignSequence: [], steps: [],
    });
    const result = await runAkRole(
      ["secretariat", "--model", "test/caller-seat:high", "--project", project, "请辨认本票。"],
      { home, packageRoot, cwd: project, io: captureIo().io,
        createRunId: () => "01a0sec1025-0000-7000-8000-000000000003",
        roleTurnHost: host, hostAdapters: [adapter("pi", host)] },
    );
    assert.equal(result.exitCode, 1);
    assert.equal(result.terminal?.roleOutcome.kind, "failure", "failure is settled in the admitted run");
    if (result.terminal?.roleOutcome.kind === "failure") {
      assert.equal(result.terminal.roleOutcome.diagnostic.includes(hostFailure.message), true,
        "the original host failure remains visible in the structured terminal");
    }
    assert.equal(gateCalls.length, 0);
  });
});

/**
 * #969 shortest adapter convergence boundary.
 * Real headless (codex/claude) / ACP (grok-build) adapter → public-entry
 * reviewer summons. Nested 给事中 reuses nestedCountersignHost.
 */
async function adapterBoundaryCase(input: {
  hostName: "codex" | "claude" | "grok-build";
  receipt: Record<string, unknown>;
}): Promise<{ gateEntered: boolean; submitted: boolean }> {
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
    seedCurrentSection(runDirectory, "admitted", {
      ticketNumber: 924,
      projectRoot: project,
      runId: "01a0adp969-0000-7000-8000-000000000001",
      role: "secretariat",
    });
    seedCurrentSection(runDirectory, "invocation", { ticketNumber: 924, role: "secretariat" });

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
    const submitted = async () => (await readRecordedSubmissionRows(
      project, "01a0adp969-0000-7000-8000-000000000001", home,
    )).some((row) => row.role === "secretariat" && row.kind === "accepted");

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
        sessionIdentity: createSessionIdentityAuthority(piDurablePrincipalAuthority, "grok-build"),
        connect: async () => connection,
        prepare,
      });
      const result = await host.executeTurn(request);
      assert.equal(result.knownFailure, undefined, JSON.stringify(result));
      return { gateEntered: countersignRequests.length > 0, submitted: await submitted() };
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
      sessionIdentity: createSessionIdentityAuthority(piDurablePrincipalAuthority, input.hostName),
      prepare,
    });
    const result = await host.executeTurn(request);
    assert.equal(result.knownFailure, undefined, JSON.stringify(result));
    return { gateEntered: countersignRequests.length > 0, submitted: await submitted() };
  });
}

for (const hostName of ["codex", "claude", "grok-build"] as const) {
  test(`#1057 adapter boundary ${hostName}: converged tool finishes before gate`, async () => {
    const { gateEntered, submitted } = await adapterBoundaryCase({
      hostName,
      receipt: { secretariatStatus: "converged", ticketNumber: 924 },
    });
    assert.equal(
      gateEntered,
      false,
      `${hostName} tool execution must not summon 给事中 before returning`,
    );
    assert.equal(submitted, true, `${hostName} must seal the submitted receipt`);
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
