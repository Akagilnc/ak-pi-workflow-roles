/**
 * #924 public Secretariat path — through-line + escalate branch.
 * Real public CLI entry; faux host activates real secretariat runtime and
 * executes production tools. Default summon path → summonPublicRole (no
 * summonCountersign inject). Nested countersign goes through real runtime +
 * 符宝郎内闸 (requireGatekeeperPass); body rewrite attribution = dirty-ticket real run.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
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
import {
  SECRETARIAT_OUTPUT_TOOL_NAME,
  SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME,
} from "../../src/secretariat-contracts.ts";
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
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import { connect } from "node:net";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  TRUE_UNBOUND_DIARIST_DETAILS,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import {
  objectPayloads,
  payloadStatusSequence,
} from "../helpers/terminal-payload.ts";
import { MAIN_ROLE_SESSION_MATERIALS } from "../../src/session-opening-materials.ts";
import { resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
import { readTicketProvenance, rehomeUnboundTicketProvenance } from "../../src/ticket-provenance.ts";
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
 * True-unbound court diarist — does not independently mint a ticket.
 * Used when parent board handoff must be the sole identity source (#969).
 */
function courtDiaristUnbound(): LegacyFauxPiRunner {
  return courtDiaristWithDetails({ ...TRUE_UNBOUND_DIARIST_DETAILS });
}

/**
 * Nested countersign via real createCountersignRoleRuntime + 符宝郎内闸 hook.
 * Gate calls are recorded for external structured assertion (G2).
 */
function nestedCountersignHost(input: {
  packageRoot: string;
  sequence: ReadonlyArray<{ details: unknown }>;
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
          return undefined;
        },
        async requireGatekeeperPass(options: { subject: { kind: string } }) {
          // Minimal fake 符宝郎内闸 host — records structured pass, no parallel fixture.
          input.gateCalls.push({ kind: options.subject.kind });
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

      const tool = tools.get(COUNTERSIGN_OUTPUT_TOOL_NAME);
      assert.ok(tool, "countersign output tool missing after real activate");
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

      return scriptedTerminatingToolSession({
        role: "countersign",
        toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
        details: executed.details ?? step.details,
      })(args, options);
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
 * Activate real secretariat runtime; default summon → summonPublicRole.
 * hostAdapters only — never inject summonCountersign (G3).
 * #969: optional `submissionGateHost` (codex/claude/grok-build) drives the
 * production prepareRoleEnvelope.requireGatekeeperPass path (no harness
 * reimplementation of the envelope summon closure).
 */
function secretariatHostDrivingRealTools(input: {
  packageRoot: string;
  home: string;
  steps: ReadonlyArray<
    | { kind: "summon"; instruction: string }
    | { kind: "output"; details: Record<string, unknown> }
  >;
  countersignSequence: ReadonlyArray<{ details: unknown }>;
  gateCalls: Array<{ kind: string }>;
  diaristRunDirectories?: string[];
  countersignRequests?: RoleTurnRequest[];
  onSummonDetails?: (details: Record<string, unknown>) => void;
  /** #969 non-pi host key — arms secretariat_verdict gate on output. */
  submissionGateHost?: "codex" | "claude" | "grok-build";
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

  // #969 non-pi: production envelope wiring (home/packageRoot/hostAdapters).
  // Gate entry observed via nested countersignRequests — no harness
  // reimplementation of requireGatekeeperPass / createDefaultGateOfficerSummon.
  if (input.submissionGateHost !== undefined) {
    // Capture narrowed host for the closure (exactOptionalPropertyTypes).
    const submissionGateHost = input.submissionGateHost;
    // Always track nested summons so gate entry is observable without a custom
    // requireGatekeeperPass push (tests may omit countersignRequests).
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
            assert.equal(
              step.kind,
              "output",
              "non-pi submission gate path has no mid-turn summon steps",
            );
            // Production ingest → beforeAccept → envelope.requireGatekeeperPass.
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

  // pi mid-turn summon path — no submission-gate envelope reimplementation.
  const nested = nestedCountersignHost({
    packageRoot: input.packageRoot,
    sequence: input.countersignSequence,
    gateCalls: input.gateCalls,
    ...(input.diaristRunDirectories === undefined
      ? {}
      : { diaristRunDirectories: input.diaristRunDirectories }),
    ...(input.countersignRequests === undefined
      ? {}
      : { countersignRequests: input.countersignRequests }),
  });
  const hostAdapters = [adapter("pi", nested)];
  return {
    async executeTurn(request: RoleTurnRequest) {
      if (request.activation.role === "diarist" && input.parentDiaristRunner !== undefined) {
        return parentDiaristHost.executeTurn(request);
      }
      if (request.activation.role !== "secretariat") {
        return nested.executeTurn(request);
      }
      const parentRunId =
        request.runDirectory
          .split("/")
          .filter(Boolean)
          .at(-1)
          ?.replace(/@.*$/, "") ?? "";
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
      const hostActions = {
        failInfrastructure(error: unknown): never {
          throw error instanceof Error ? error : new Error(String(error));
        },
        bindSubmissionNonPass() {},
      };
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
          return undefined;
        },
        // Nested 符宝郎内闸 on countersign only — pi path never arms secretariat_verdict.
        async requireGatekeeperPass(options: { subject: { kind: string } }) {
          input.gateCalls.push({ kind: options.subject.kind });
        },
      } as unknown as RoleHost;

      await createSecretariatRoleRuntime(
        roleHost,
        {
          loadSoul: async () => "中书省职分（测试装载）",
          packageRoot: input.packageRoot,
          // Deliberately wrong optional dependency: production nested summons must
          // derive machine home from the durable parent run directory.
          home: join(input.home, "wrong-dependency-home"),
          hostAdapters,
        },
        hostActions,
      ).activate();

      assert.ok(active.includes(SECRETARIAT_OUTPUT_TOOL_NAME));
      assert.ok(active.includes(SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME));

      const ctx = {
        // Deliberately wrong host-context cwd: nested public summons must use the
        // parent run's durable projectRoot instead.
        cwd: join(input.home, "wrong-host-cwd"),
        mode: "json",
        model: undefined,
        runDirectory: request.runDirectory,
        sessionManager: {
          getSessionFile: () =>
            piDurablePrincipalAuthority.decode(request.principal).sessionFile,
          getSessionDir: () =>
            piDurablePrincipalAuthority.decode(request.principal)
              .sessionDirectory,
          getEntries: () => [],
          getLeafEntry: () => undefined,
          getLeafId: () => null,
        },
        abort() {},
      } as HostContext;

      let summonIndex = 0;
      for (const step of input.steps) {
        if (step.kind === "summon") {
          const tool = tools.get(SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME);
          assert.ok(tool, "summon tool missing after activate");
          const summoned = await tool.execute(
            `summon-${summonIndex++}`,
            { instruction: step.instruction },
            undefined,
            undefined,
            ctx,
          );
          if (input.onSummonDetails !== undefined) {
            input.onSummonDetails(
              (summoned.details ?? {}) as Record<string, unknown>,
            );
          }
          continue;
        }
        const tool = tools.get(SECRETARIAT_OUTPUT_TOOL_NAME);
        assert.ok(tool, "output tool missing after activate");
        let result: { details?: unknown; terminate?: boolean };
        try {
          result = await tool.execute(
            "call_secretariat_out",
            step.details,
            undefined,
            undefined,
            ctx,
          );
        } catch (error) {
          if (error instanceof GatekeeperDecisionError && error.result.status === "bounce") {
            continue;
          }
          throw error;
        }
        assert.equal(result.terminate, true);
        const coords = piDurablePrincipalAuthority.decode(request.principal);
        await mkdir(coords.sessionDirectory, { recursive: true });
        const sealedDetails = result.details ?? step.details;
        appendFileSync(
          coords.sessionFile,
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "call_secretariat_out",
              toolName: SECRETARIAT_OUTPUT_TOOL_NAME,
              isError: false,
              details: sealedDetails,
            },
          })}\n`,
          "utf8",
        );
        if (isAuditEscalationProjection(sealedDetails)) {
          await recordAuditEscalationSubmission({
            cwd: request.cwd,
            home: request.home,
            runId: parentRunId,
            runDirectory: request.runDirectory,
            role: "secretariat",
            details: sealedDetails,
            toolCallId: "call_secretariat_out",
          });
        } else {
          await sealAcceptedSubmission({
            cwd: request.cwd,
            home: request.home,
            runId: parentRunId,
            runDirectory: request.runDirectory,
            role: "secretariat",
            details: sealedDetails,
            toolCallId: "call_secretariat_out",
            ...(request.courtAttemptId === undefined
              ? {}
              : { courtAttemptId: request.courtAttemptId }),
          });
        }
      }

      return { code: 0, stderr: "", timedOut: false };
    },
  };
}

test("public secretariat through-line: default summon → continue → same-run converged", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    assert.ok(
      MAIN_ROLE_SESSION_MATERIALS.secretariat.includes("souls/ticket-law.md"),
    );
    assert.ok(
      (MAIN_ROLE_SESSION_MATERIALS.secretariat as readonly string[]).includes(
        "souls/secretariat.md",
      ),
    );

    const secretariatRunId = "01a0sec924-0000-7000-8000-000000000001";
    const attachment = join(home, "ticket-material.md");
    await writeFile(attachment, "#924 frozen material", "utf8");
    const capture = captureIo();
    const summonDetails: Array<Record<string, unknown>> = [];
    const gateCalls: Array<{ kind: string }> = [];
    const diaristRunDirectories: string[] = [];
    const countersignRequests: RoleTurnRequest[] = [];
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
      gateCalls,
      diaristRunDirectories,
      countersignRequests,
      // #987 Result 7: no public ticketNumber resume into a pre-seeded run.
      // First gate summon under this secretariat parent mints; second resumes
      // via parentRunPath (#747).
      countersignSequence: [
        {
          details: {
            countersignStatus: "continue",
            fix: { summary: "删考古与伪 authority" },
          },
        },
        {
          details: { countersignStatus: "converged", note: "署" },
        },
      ],
      onSummonDetails: (details) => {
        summonDetails.push(details);
      },
      steps: [
        { kind: "summon", instruction: "- 裁：#924 是否足以开工。" },
        { kind: "summon", instruction: "裁：#924 已按封驳重写，请复审。" },
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
        "--attach",
        attachment,
        "整理 #924 票面并送庭。",
      ],
      {
        home,
        packageRoot,
        cwd: project,
        io: capture.io,
        createRunId: () => secretariatRunId,
        roleTurnHost: host,
        hostAdapters: [adapter("pi", host)],
      },
    );
    assert.equal(result.exitCode, 0, capture.stderr.join(""));
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), [
      "converged",
    ]);
    const facts = objectPayloads(result.terminal.roleOutcome)[0] as {
      secretariatStatus: string;
      ticketNumber?: number;
    };
    assert.equal(facts.secretariatStatus, "converged");
    assert.equal(facts.ticketNumber, 924);

    // Nested terminal fidelity on the summon tool projection (default path).
    assert.equal(summonDetails.length, 2);
    assert.equal(summonDetails[0]!.outcomeKind, "accepted");
    assert.equal(summonDetails[0]!.countersignStatus, "continue");
    assert.equal(summonDetails[1]!.outcomeKind, "accepted");
    assert.equal(summonDetails[1]!.countersignStatus, "converged");
    const firstRunId = summonDetails[0]!.runId;
    assert.equal(
      typeof firstRunId,
      "string",
      "first gate summon must mint a countersign run under this secretariat parent",
    );
    assert.ok(
      (firstRunId as string).length > 0,
      "minted countersign runId must be non-empty",
    );
    assert.equal(
      summonDetails[1]!.runId,
      firstRunId,
      "second gate summon must resume the same-parent countersign run",
    );

    // G2: mint + resume each cross 符宝郎内闸 and create a court.
    assert.equal(gateCalls.length, 2);
    assert.ok(
      gateCalls.every((c) => c.kind === "countersign_verdict"),
      `gate subjects must be countersign_verdict, got ${JSON.stringify(gateCalls)}`,
    );

    const childRunDir = await findRunDirectoryById(home, firstRunId as string);
    assert.ok(childRunDir, "countersign child run must exist");
    const attemptIds = await distinctCourtAttemptIds({
      cwd: project,
      home,
      runId: firstRunId as string,
      runDirectory: childRunDir,
    });
    assert.equal(
      attemptIds.size,
      2,
      `mint + same-parent resume must each create a court; got=${[...attemptIds].join(",") || "(none)"}`,
    );

    assert.equal(
      countersignRequests.length,
      2,
      `expected mint then resume under secretariat caller: ${JSON.stringify(countersignRequests.map((request) => ({ kind: request.continuation.kind, correlationId: request.correlationId })))}`,
    );
    assert.equal(countersignRequests[0]!.continuation.kind, "initial");
    assert.equal(countersignRequests[0]!.correlationId, secretariatRunId);
    assert.equal(countersignRequests[1]!.continuation.kind, "resume");
    assert.equal(countersignRequests[1]!.correlationId, secretariatRunId);
    assert.ok(
      piDurablePrincipalAuthority
        .decode(countersignRequests[1]!.principal)
        .sessionDirectory.includes(firstRunId as string),
      "second leg must resume the minted countersign principal",
    );

    // G3: parent secretariat run bound under ticket, not unbound.
    // Canonical placement: books/<key>/<ticket>/runs/ (legacy issues/ is read-only).
    const parentRunDir = await findRunDirectoryById(home, secretariatRunId);
    assert.ok(parentRunDir, "secretariat parent run must exist");
    assert.match(
      parentRunDir.replace(/\\/g, "/"),
      /\/924\/runs\//,
      `parent run must bind under ticket 924; got ${parentRunDir}`,
    );
    assert.equal(
      parentRunDir.includes(`${join("unbound", "runs")}`),
      false,
    );
    const parentAdmitted = JSON.parse(
      await readFile(join(parentRunDir, "admitted-request.json"), "utf8"),
    ) as { ticketNumber?: number };
    assert.equal(parentAdmitted.ticketNumber, 924);
    const diaristAdmissions = await Promise.all(
      diaristRunDirectories.map(async (directory) => {
        const runId = directory.split("/").at(-1)?.replace(/@.*$/, "") ?? "";
        const currentDirectory = await findRunDirectoryById(home, runId);
        assert.ok(currentDirectory);
        return JSON.parse(
          await readFile(join(currentDirectory, "admitted-request.json"), "utf8"),
        ) as {
          attachments?: unknown[];
          correlationId?: string;
          correlationIds?: string[];
        };
      }),
    );
    assert.ok(
      diaristAdmissions.some((admission) => (admission.attachments?.length ?? 0) > 0),
      "identity diarist must receive the secretariat run's frozen attachment",
    );
    const diaristCallers = new Set(
      diaristAdmissions.flatMap((admission) => [
        admission.correlationId,
        ...(admission.correlationIds ?? []),
      ]),
    );
    assert.ok(
      diaristCallers.has(secretariatRunId),
      "secretariat identity diarist must record the secretariat as direct caller",
    );
    assert.ok(
      diaristCallers.has(firstRunId as string),
      "court diarists must record the countersign as direct caller",
    );

    const state = await readRoleRunState(
      parentRunDir,
      piDurablePrincipalAuthority,
    );
    assert.equal(state?.state, "terminal");
  });
});

test("public secretariat escalate branch: countersign escalate → secretariat escalate with matter", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "01a0sec924-esc0-7000-8000-000000000099";
    const capture = captureIo();
    const summonDetails: Array<Record<string, unknown>> = [];
    const gateCalls: Array<{ kind: string }> = [];
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
      gateCalls,
      countersignSequence: [
        {
          details: {
            countersignStatus: "escalate",
            decisionGate: {
              question: "中书省是否拆席？",
              options: ["暂不", "拆"],
            },
          },
        },
      ],
      onSummonDetails: (d) => {
        summonDetails.push(d);
      },
      steps: [
        { kind: "summon", instruction: "裁：#924 上呈事项。" },
        {
          kind: "output",
          details: {
            secretariatStatus: "escalate",
            decisionGate: {
              question: "中书省是否拆席？",
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
        "整理 #924；若须拆席则上呈。",
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
    assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), [
      "escalate",
    ]);
    const facts = objectPayloads(result.terminal.roleOutcome)[0] as {
      secretariatStatus: string;
      decisionGate?: { question?: string; options?: string[] };
    };
    assert.equal(facts.secretariatStatus, "escalate");
    assert.equal(facts.decisionGate?.question, "中书省是否拆席？");
    assert.deepEqual(facts.decisionGate?.options, ["暂不", "拆"]);
    assert.equal(summonDetails[0]?.countersignStatus, "escalate");
    assert.equal(summonDetails[0]?.outcomeKind, "accepted");
    // escalate skips 符宝郎内闸 (#753)
    assert.equal(gateCalls.length, 0);
  });
});

for (const hostName of ["codex", "claude", "grok-build"] as const) {
test(`#969 ${hostName} public entry: converged enters the shared gate`, async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = hostName === "codex"
      ? "01a0sec969-gate-7000-8000-000000000001"
      : hostName === "claude"
        ? "01a0sec969-gate-7000-8000-000000000011"
        : "01a0sec969-gate-7000-8000-000000000021";
    const capture = captureIo();
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
            countersignStatus: "continue",
            fix: { summary: "删伪 authority" },
          },
        },
        { details: { countersignStatus: "converged", note: "署" } },
      ],
      // Headless path: output only — no mid-turn summon tool.
      steps: [
        {
          kind: "output",
          details: { secretariatStatus: "converged", ticketNumber: 924 },
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
    // #969: 公开终局呈现给事中判词与 runId（settlement 唯一权威）.
    const countersignTerminal = result.terminal.roleOutcome.decisiveFacts
      ?.countersignTerminal as
      | { receipt?: unknown; runId?: string }
      | undefined;
    assert.ok(countersignTerminal, "accepted terminal must project countersignTerminal");
    assert.deepEqual(countersignTerminal.receipt, {
      countersignStatus: "converged",
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
    // #987: second 给事中 leg resumes via same secretariat parentRunPath.
    assert.ok(
      countersignRequests.some((r) => r.continuation.kind === "resume"),
      "封驳后给事中 must resume same parent",
    );
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
            countersignStatus: "escalate",
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
      countersignStatus?: string;
      decisionGate?: { question?: string };
    };
    assert.equal(facts.countersignStatus, "escalate");
    assert.equal(facts.decisionGate?.question, "票面争议上呈？");
    // #969: 上呈终局呈现给事中判词（payloads）与 runId（decisiveFacts）.
    const countersignTerminal = result.terminal.roleOutcome.decisiveFacts
      ?.countersignTerminal as
      | { receipt?: unknown; runId?: string }
      | undefined;
    assert.ok(countersignTerminal, "escalate terminal must project countersignTerminal");
    assert.deepEqual(countersignTerminal.receipt, {
      countersignStatus: "escalate",
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
        { details: { countersignStatus: "converged", note: "先署" } },
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

test("#969 omitted receipt ticketNumber still hands parent board identity to 给事中", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const runId = "01a0sec969-omit-7000-8000-000000000004";
    const capture = captureIo();
    const gateCalls: Array<{ kind: string }> = [];
    const countersignRequests: RoleTurnRequest[] = [];
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
      gateCalls,
      countersignRequests,
      submissionGateHost: "codex",
      // Nested 起居郎 must not mint 924 — parent board handoff is the sole source.
      nestedDiaristRunner: courtDiaristUnbound(),
      countersignSequence: [
        { details: { countersignStatus: "converged", note: "署" } },
      ],
      // Legal omit of optional ticketNumber — parent board binding is the identity.
      steps: [
        {
          kind: "output",
          details: { secretariatStatus: "converged" },
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
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    assert.ok(
      gateCalls.some((c) => c.kind === "secretariat_verdict"),
      "omitted ticketNumber must still enter secretariat_verdict gate",
    );
    assert.ok(
      countersignRequests.length >= 1,
      "gate must summon countersign under parent board identity",
    );
    // Parent 起居郎 bound #924 before the turn; handoff must carry it even when
    // the converged receipt omits ticketNumber.
    assert.ok(
      countersignRequests.some(
        (r) => (r.activation as { ticketNumber?: number }).ticketNumber === 924,
      ),
      `给事中 must bind under parent ticket #924, got ${JSON.stringify(
        countersignRequests.map((r) => r.activation),
      )}`,
    );
  });
});

test("public secretariat moves its unbound 起居录 to the ticket after typed assignment", async () => {
  for (const scenario of ["first", "retry", "other-source-same-content"] as const) {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const sessionPath = join(home, ".claude", "projects", "draft", "session.jsonl");
    await mkdir(dirname(sessionPath), { recursive: true });
    await writeFile(sessionPath, `${JSON.stringify({ type: "user", uuid: "draft-owner", message: { role: "user", content: "请拟票" }, origin: { kind: "human" } })}\n`, "utf8");
    const book = join(home, ".ak-roles", "books", "project");
    const parentRun = "01a0sec1010-0000-7000-8000-000000000001@secretariat";
    const unrelatedRun = join(book, "unbound", "runs", "unfinished@diarist");
    const diaristRuns: string[] = [];
    const prior = '{"identity":"prior"}';
    await mkdir(join(book, "924"), { recursive: true });
    await writeFile(join(book, "924", "records.jsonl"), prior, "utf8");
    let sourceContent = "";
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
      gateCalls: [],
      diaristRunDirectories: diaristRuns,
      parentDiaristRunner: async (args, options) => {
        await mkdir(unrelatedRun, { recursive: true });
        await writeFile(join(unrelatedRun, "admitted-request.json"), "", "utf8");
        await writeFile(join(options.env.AK_ROLE_RUN_DIR!, "records.jsonl"), "{broken\n", "utf8");
        const result = await courtDiaristWithDetails({
          status: "completed",
          ticketNumber: null,
          sessions: [{ path: sessionPath, ranges: [{ from: { line: 1 }, to: { line: 1 } }] }],
        })(args, options);
        sourceContent = await readFile(join(options.env.AK_ROLE_RUN_DIR!, "records.jsonl"), "utf8");
        if (scenario !== "first") {
          if (scenario === "retry") {
            await rehomeUnboundTicketProvenance(options.env.AK_ROLE_RUN_DIR!, 924, project, home);
            await writeFile(join(options.env.AK_ROLE_RUN_DIR!, "records.jsonl"), sourceContent, "utf8");
          } else {
            await writeFile(join(book, "924", "records.jsonl"), `${prior}\n${sourceContent}`, "utf8");
          }
          const parentPagePath = join(book, "unbound", "runs", parentRun, "admitted-request.json");
          const parentPage = JSON.parse(await readFile(parentPagePath, "utf8"));
          await writeFile(parentPagePath, `${JSON.stringify({ ...parentPage, childDiaristRunIds: ["already-moved"] })}\n`, "utf8");
          await mkdir(join(book, "924", "runs", "already-moved@diarist"), { recursive: true });
        }
        return result;
      },
      countersignSequence: [{ details: { countersignStatus: "converged", note: "署" } }],
      steps: [{ kind: "output", details: { secretariatStatus: "converged", ticketNumber: 924 } }],
    });
    const result = await runAkRole(
      ["secretariat", "--model", "test/caller-seat:high", "--project", project, "拟票"],
      { home, packageRoot, cwd: project, io: captureIo().io, createRunId: () => "01a0sec1010-0000-7000-8000-000000000001", roleTurnHost: host, hostAdapters: [adapter("pi", host)] },
    );
    assert.equal(result.exitCode, 0);
    assert.ok((await readdir(dirname(unrelatedRun))).includes("unfinished@diarist"));
    assert.equal(await readFile(join(unrelatedRun, "admitted-request.json"), "utf8"), "");
    const record = join(book, "924", "records.jsonl");
    assert.equal(await readFile(record, "utf8"), `${prior}\n${sourceContent}${scenario === "other-source-same-content" ? sourceContent : ""}`);
    const recordLines = (await readFile(record, "utf8")).trim().split("\n");
    assert.ok(recordLines.includes("{broken"));
    const rows = recordLines.filter((line) => line !== "{broken").map((row) => JSON.parse(row));
    assert.equal(rows[1]?.subject, undefined);
    assert.equal(rows[1]?.payload?.lines?.[0]?.speaker, "owner");
    assert.equal((await readTicketProvenance(924, project, home)).header?.ticket, 924);
    assert.ok(diaristRuns.length > 0);
    assert.equal(dirname(diaristRuns[0]!), dirname(unrelatedRun));
    assert.ok((await readdir(join(book, "924", "runs"))).includes(parentRun));
    assert.equal((await readFile(join(diaristRuns[0]!, "records.jsonl"), "utf8").catch((error: NodeJS.ErrnoException) => error.code)), "ENOENT");
    const diaristRun = join(book, "924", "runs", diaristRuns[0]!.split("/").at(-1)!);
    assert.equal(JSON.parse(await readFile(join(diaristRun, "admitted-request.json"), "utf8")).ticketNumber, 924);
    assert.equal(JSON.parse(await readFile(join(diaristRun, "invocation.json"), "utf8")).ticketNumber, 924);
    assert.equal((await readFile(join(diaristRuns[0]!, "admitted-request.json"), "utf8").catch((error: NodeJS.ErrnoException) => error.code)), "ENOENT");
  });
  }
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
 * production requireGatekeeperPass. Nested 给事中 reuses nestedCountersignHost so
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
      sequence: [{ details: { countersignStatus: "converged", note: "署" } }],
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
