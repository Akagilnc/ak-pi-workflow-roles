/**
 * #924 public Secretariat path — through-line + escalate branch.
 * Real public CLI entry; faux host activates real secretariat runtime and
 * executes production tools (summon + output), same seam as court diarist fixtures.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import {
  SECRETARIAT_OUTPUT_TOOL_NAME,
  SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME,
} from "../../src/secretariat-contracts.ts";
import { readRecordedSubmissionRows } from "../../src/submission-ledger.ts";
import type {
  HostContext,
  RoleHost,
  RoleTurnHost,
  RoleTurnRequest,
} from "../../src/host-contracts.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { readRoleRunState } from "../../src/public-cli/run-lifecycle.ts";
import {
  createDiaristRoleRuntime,
  createSecretariatRoleRuntime,
} from "../../src/role-runtime.ts";
import { gateToolSessionJsonl } from "../helpers/gate-tool-session-jsonl.ts";
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
import { summonPublicRole } from "../../src/public-role-summons.ts";
import { sealAcceptedSubmission } from "../helpers/submission-ledger-fixture.ts";
import { MAIN_ROLE_SESSION_MATERIALS } from "../../src/session-opening-materials.ts";

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
  execFileSync("git", ["config", "user.name", "Secretariat Test"], { cwd: root });
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

function scriptedCountersign(
  details: unknown,
  options?: { seedNotary?: boolean },
): LegacyFauxPiRunner {
  return async (args, spawnOptions) => {
    const outcome = await scriptedTerminatingToolSession({
      role: "countersign",
      toolName: COUNTERSIGN_OUTPUT_TOOL_NAME,
      details,
    })(args, spawnOptions);
    if (options?.seedNotary === true) {
      const sessionFile = argvFlagValue(args, "--session");
      assert.ok(sessionFile);
      const auditorDir = join(dirname(sessionFile), "auditor-roles");
      await mkdir(auditorDir, { recursive: true });
      await writeFile(
        join(auditorDir, "o01_notary.jsonl"),
        gateToolSessionJsonl({
          id: "direct-notary",
          startedAt: "2026-09-15T00:00:00.000Z",
          endedAt: "2026-09-15T00:00:10.000Z",
          toolName: "ak_notary_output",
          args: { status: "pass", findings: [] },
        }),
        "utf8",
      );
    }
    return outcome;
  };
}

function nestedCountersignHost(input: {
  packageRoot: string;
  sequence: ReadonlyArray<{ details: unknown; seedNotary?: boolean }>;
}): RoleTurnHost {
  let call = 0;
  const piRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "diarist") return courtDiaristFor924()(args, options);
    if (role === "countersign") {
      const step = input.sequence[call] ?? input.sequence.at(-1)!;
      call += 1;
      return scriptedCountersign(step.details, {
        seedNotary: step.seedNotary === true,
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
 * Activate real secretariat runtime and execute production tools in order.
 * Body rewrite uses the tracked issue-body file (offline stand-in for gh issue edit).
 */
function secretariatHostDrivingRealTools(input: {
  packageRoot: string;
  home: string;
  bodyPath?: string;
  cleanBody?: string;
  firstCountersignRunId?: string;
  steps: ReadonlyArray<
    | { kind: "rewrite" }
    | { kind: "summon"; instruction: string; createRunId?: string }
    | {
        kind: "output";
        details: Record<string, unknown>;
      }
  >;
  countersignSequence: ReadonlyArray<{ details: unknown; seedNotary?: boolean }>;
}): RoleTurnHost {
  const nested = nestedCountersignHost({
    packageRoot: input.packageRoot,
    sequence: input.countersignSequence,
  });
  return {
    async executeTurn(request: RoleTurnRequest) {
      if (request.activation.role !== "secretariat") {
        return nested.executeTurn(request);
      }
      const parentRunId =
        request.runDirectory.split("/").filter(Boolean).at(-1)?.replace(/@.*$/, "") ??
        "";
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

      let summonCount = 0;
      await createSecretariatRoleRuntime(roleHost, {
        loadSoul: async () => "中书省职分（测试装载）",
        packageRoot: input.packageRoot,
        home: input.home,
        summonCountersign: async (summonInput) => {
          const createRunId =
            summonCount === 0 && input.firstCountersignRunId !== undefined
              ? () => input.firstCountersignRunId!
              : undefined;
          summonCount += 1;
          return summonPublicRole({
            role: "countersign",
            argv: [summonInput.instruction, "--project", summonInput.cwd],
            cwd: summonInput.cwd,
            home: input.home,
            packageRoot: input.packageRoot,
            ...(summonInput.correlationId === undefined
              ? {}
              : { correlationId: summonInput.correlationId }),
            ...(createRunId === undefined ? {} : { createRunId }),
            hostAdapters: [adapter("pi", nested)],
          });
        },
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
            piDurablePrincipalAuthority.decode(request.principal).sessionDirectory,
          getEntries: () => [],
          getLeafEntry: () => undefined,
          getLeafId: () => null,
        },
        abort() {},
      } as HostContext;

      let lastSummon: { details?: unknown } | undefined;
      for (const step of input.steps) {
        if (step.kind === "rewrite") {
          assert.ok(input.bodyPath && input.cleanBody);
          await writeFile(input.bodyPath, input.cleanBody, "utf8");
          continue;
        }
        if (step.kind === "summon") {
          const tool = tools.get(SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME);
          assert.ok(tool, "summon tool missing after activate");
          lastSummon = await tool.execute(
            `summon-${summonCount}`,
            { instruction: step.instruction },
            undefined,
            undefined,
            ctx,
          );
          continue;
        }
        // output
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

      // Expose last summon facts on the host for through-line assertions via closure return.
      void lastSummon;
      return { code: 0, stderr: "", timedOut: false };
    },
  };
}

test("public secretariat through-line: rewrite → countersign continue → resume same run converged → sealed", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const bodyPath = join(project, "issue-924-body.md");
    const dirtyBody =
      "考古授权链三层追溯……签发方自认……旧票原话对比……\n要做：实现中书省。";
    const cleanBody =
      "## 当前应然\n票面按《票面法》整理。\n## 要做\n实现中书省。\n## 怎么验\n一条贯穿线。\n";
    await writeFile(bodyPath, dirtyBody, "utf8");

    assert.ok(
      MAIN_ROLE_SESSION_MATERIALS.secretariat.includes("souls/ticket-law.md"),
    );

    const secretariatRunId = "01a0sec924-0000-7000-8000-000000000001";
    const firstCountersignRunId = "01a0csn924-0000-7000-8000-000000000001";
    const capture = captureIo();
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
      bodyPath,
      cleanBody,
      firstCountersignRunId,
      countersignSequence: [
        {
          details: {
            countersignStatus: "continue",
            fix: { summary: "删考古与伪 authority" },
          },
        },
        {
          details: { countersignStatus: "converged", note: "署" },
          seedNotary: true,
        },
      ],
      steps: [
        {
          kind: "summon",
          instruction: "裁：#924 是否足以开工。",
        },
        { kind: "rewrite" },
        {
          kind: "summon",
          instruction: "裁：#924 已按封驳重写，请复审。",
        },
        {
          kind: "output",
          details: { secretariatStatus: "sealed", ticketNumber: 924 },
        },
      ],
    });

    // Capture child run facts via a side channel: after run, scan home for countersign runs.
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

    const finalBody = await readFile(bodyPath, "utf8");
    assert.equal(finalBody, cleanBody);
    assert.notEqual(finalBody, dirtyBody);

    // Same countersign run, ≥2 courts; child correlation names parent.
    const rows = await readRecordedSubmissionRows(
      project,
      firstCountersignRunId,
      home,
    );
    assert.ok(rows.length >= 2, `expected ≥2 courts, got ${rows.length}`);
    const { findRunDirectoryById } = await import(
      "../../src/public-cli/run-lifecycle.ts"
    );
    const childRunDir = await findRunDirectoryById(home, firstCountersignRunId);
    assert.ok(childRunDir, "countersign child run must exist");
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
    const host = secretariatHostDrivingRealTools({
      packageRoot,
      home,
      firstCountersignRunId: "01a0csn924-esc0-7000-8000-000000000001",
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
      steps: [
        {
          kind: "summon",
          instruction: "裁：#924 上呈事项。",
        },
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
  });
});
