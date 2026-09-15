/**
 * #924 public Secretariat path — through-line + escalate branch.
 * Real public CLI entry; faux host activates real secretariat runtime and
 * executes production tools. Default summon path → summonPublicRole (no
 * summonCountersign inject). Body rewrite + notary pass = dirty-ticket real run.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";

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
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import {
  findRunDirectoryById,
  readRoleRunState,
} from "../../src/public-cli/run-lifecycle.ts";
import {
  createDiaristRoleRuntime,
  createSecretariatRoleRuntime,
} from "../../src/role-runtime.ts";
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
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { MAIN_ROLE_SESSION_MATERIALS } from "../../src/session-opening-materials.ts";
import { resolveActivationLedgerHome } from "../../src/activation-ledger-topology.ts";
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

/** Court diarist asserts #924 through real accept hook (typed ticket bind). */
function courtDiaristFor924(): LegacyFauxPiRunner {
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
    } as unknown as RoleHost;
    await createDiaristRoleRuntime(host, {
      loadSoul: async () => "起居郎职分（测试装载）",
    }).activate();
    assert.ok(registered);
    const runDir = options.env.AK_ROLE_RUN_DIR ?? "";
    const sessionFile = argvFlagValue(args, "--session") ?? "";
    const result = await registered.execute(
      "call_diarist_924",
      { status: "completed", ticketNumber: 924, sessions: [] as const },
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
      details: result.details ?? {
        status: "completed",
        ticketNumber: 924,
        sessions: [] as const,
      },
    })(args, options);
  };
}

function nestedCountersignHost(input: {
  packageRoot: string;
  sequence: ReadonlyArray<{ details: unknown }>;
}): RoleTurnHost {
  let call = 0;
  const piRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "diarist") return courtDiaristFor924()(args, options);
    if (role === "countersign") {
      const step = input.sequence[call] ?? input.sequence.at(-1)!;
      call += 1;
      return scriptedTerminatingToolSession({
        role: "countersign",
        toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
        details: step.details,
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role}`);
  };
  return roleTurnHostFromLegacyPiRunner({
    packageRoot: input.packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner,
  });
}

/**
 * Activate real secretariat runtime; default summon → summonPublicRole.
 * hostAdapters only — never inject summonCountersign (G3).
 */
function secretariatHostDrivingRealTools(input: {
  packageRoot: string;
  home: string;
  steps: ReadonlyArray<
    | { kind: "summon"; instruction: string }
    | { kind: "output"; details: Record<string, unknown> }
  >;
  countersignSequence: ReadonlyArray<{ details: unknown }>;
  onSummonDetails?: (details: Record<string, unknown>) => void;
}): RoleTurnHost {
  const nested = nestedCountersignHost({
    packageRoot: input.packageRoot,
    sequence: input.countersignSequence,
  });
  const hostAdapters = [adapter("pi", nested)];

  return {
    async executeTurn(request: RoleTurnRequest) {
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
      const roleHost = {
        registerTool(tool: {
          name: string;
          execute: (typeof tools extends Map<string, infer V> ? V : never)["execute"];
        }) {
          tools.set(tool.name, tool);
        },
        on() {},
        getAllTools: () => [...tools.keys()].map((name) => ({ name })),
        getFlag() {
          return undefined;
        },
      } as unknown as RoleHost;

      // Production default path: no summonCountersign inject.
      await createSecretariatRoleRuntime(roleHost, {
        loadSoul: async () => "中书省职分（测试装载）",
        packageRoot: input.packageRoot,
        home: input.home,
        hostAdapters,
      }).activate();

      const ctx = {
        cwd: request.cwd,
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
        const result = await tool.execute(
          "call_secretariat_out",
          step.details,
          undefined,
          undefined,
          ctx,
        );
        assert.equal(result.terminate, true);
        const coords = piDurablePrincipalAuthority.decode(request.principal);
        await mkdir(coords.sessionDirectory, { recursive: true });
        await writeFile(
          coords.sessionFile,
          `${JSON.stringify({
            type: "message",
            message: {
              role: "toolResult",
              toolCallId: "call_secretariat_out",
              toolName: SECRETARIAT_OUTPUT_TOOL_NAME,
              isError: false,
              details: result.details ?? step.details,
            },
          })}\n`,
          "utf8",
        );
        await sealAcceptedSubmission({
          cwd: request.cwd,
          home: request.home,
          runId: parentRunId,
          runDirectory: request.runDirectory,
          role: "secretariat",
          details: result.details ?? step.details,
          toolCallId: "call_secretariat_out",
          ...(request.courtAttemptId === undefined
            ? {}
            : { courtAttemptId: request.courtAttemptId }),
        });
      }

      return { code: 0, stderr: "", timedOut: false };
    },
  };
}

test("public secretariat through-line: default summon → continue → same-run converged → sealed", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    assert.ok(
      MAIN_ROLE_SESSION_MATERIALS.secretariat.includes("souls/ticket-law.md"),
    );

    const secretariatRunId = "01a0sec924-0000-7000-8000-000000000001";
    const capture = captureIo();
    const summonDetails: Array<Record<string, unknown>> = [];
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
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
        { kind: "summon", instruction: "裁：#924 是否足以开工。" },
        { kind: "summon", instruction: "裁：#924 已按封驳重写，请复审。" },
        {
          kind: "output",
          details: { secretariatStatus: "sealed", ticketNumber: 924 },
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
        createRunId: () => secretariatRunId,
        roleTurnHost: host,
        hostAdapters: [adapter("pi", host)],
      },
    );
    assert.equal(result.exitCode, 0, capture.stderr.join(""));
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "accepted");
    assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), [
      "sealed",
    ]);
    const facts = objectPayloads(result.terminal.roleOutcome)[0] as {
      secretariatStatus: string;
      ticketNumber?: number;
    };
    assert.equal(facts.secretariatStatus, "sealed");
    assert.equal(facts.ticketNumber, 924);

    // Nested terminal fidelity on the summon tool projection (default path).
    assert.equal(summonDetails.length, 2);
    assert.equal(summonDetails[0]!.outcomeKind, "accepted");
    assert.equal(summonDetails[0]!.countersignStatus, "continue");
    assert.equal(summonDetails[1]!.outcomeKind, "accepted");
    assert.equal(summonDetails[1]!.countersignStatus, "converged");
    const firstRunId = summonDetails[0]!.runId;
    assert.equal(typeof firstRunId, "string");
    assert.equal(
      summonDetails[1]!.runId,
      firstRunId,
      "second summon must resume the same countersign run",
    );

    // Court count via structured attemptId — not row count.
    const childRunDir = await findRunDirectoryById(home, firstRunId as string);
    assert.ok(childRunDir, "countersign child run must exist");
    const attemptIds = await distinctCourtAttemptIds({
      cwd: project,
      home,
      runId: firstRunId as string,
      runDirectory: childRunDir,
    });
    assert.ok(
      attemptIds.size >= 2,
      `expected ≥2 courtAttemptIds, got ${[...attemptIds].join(",") || "(none)"}`,
    );

    const admittedRaw = await readFile(
      join(childRunDir, "invocation.json"),
      "utf8",
    );
    assert.ok(
      admittedRaw.includes(secretariatRunId),
      "child ledger must reference parent correlation/caller",
    );

    const coords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId: secretariatRunId,
      role: "secretariat",
      home,
    });
    const state = await readRoleRunState(
      coords.runDirectory,
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
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
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
