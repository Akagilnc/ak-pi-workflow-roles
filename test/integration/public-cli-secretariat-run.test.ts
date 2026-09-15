/**
 * #924 public Secretariat path — through-line + escalate branch.
 * Real public CLI entry; faux host; nested countersign via shared summons seam.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
// dirname used by court diarist + notary seed paths
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "../../src/countersign-contracts.ts";
import { SECRETARIAT_OUTPUT_TOOL_NAME } from "../../src/secretariat-contracts.ts";
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
import { createDiaristRoleRuntime } from "../../src/role-runtime.ts";
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

/**
 * Court station diarist asserts ticket #924 through real diarist accept hook
 * so countersign same-ticket resume binds on the typed key (#771 / #924).
 */
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
    const runtime = createDiaristRoleRuntime(host, {
      loadSoul: async () => "起居郎职分（测试装载）",
    });
    await runtime.activate();
    assert.ok(registered, "diarist envelope registered no output tool");
    const runDir = options.env.AK_ROLE_RUN_DIR ?? "";
    const sessionFile = argvFlagValue(args, "--session") ?? "";
    const result = await registered.execute(
      "call_diarist_924",
      {
        status: "completed",
        ticketNumber: 924,
        sessions: [] as const,
      },
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

/**
 * Secretariat body: rewrite issue body file, summon countersign twice
 * (continue → converged) via shared seam, then seal.
 */
function secretariatThroughLineHost(input: {
  packageRoot: string;
  home: string;
  bodyPath: string;
  cleanBody: string;
  countersignRunIds: string[];
}): RoleTurnHost {
  let countersignCall = 0;
  const nestedPiRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "diarist") return courtDiaristFor924()(args, options);
    if (role === "countersign") {
      const idx = countersignCall;
      countersignCall += 1;
      if (idx === 0) {
        return scriptedCountersign({
          countersignStatus: "continue",
          fix: { summary: "删考古与伪 authority" },
        })(args, options);
      }
      return scriptedCountersign(
        { countersignStatus: "converged", note: "署" },
        { seedNotary: true },
      )(args, options);
    }
    throw new Error(`unexpected nested role: ${role}`);
  };
  const nestedHost = roleTurnHostFromLegacyPiRunner({
    packageRoot: input.packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: nestedPiRunner,
  });

  return {
    async executeTurn(request: RoleTurnRequest) {
      if (request.activation.role !== "secretariat") {
        return nestedHost.executeTurn(request);
      }
      // 1. Replace online body (same public path as runner — here a tracked file).
      await writeFile(input.bodyPath, input.cleanBody, "utf8");

      // 2. First court: countersign continue.
      const parentRunId =
        request.runDirectory.split("/").filter(Boolean).at(-1)?.replace(/@.*$/, "") ?? "";
      const first = await summonPublicRole({
        role: "countersign",
        argv: ["裁：#924 是否足以开工。", "--project", request.cwd],
        cwd: request.cwd,
        home: input.home,
        packageRoot: input.packageRoot,
        ...(parentRunId === "" ? {} : { correlationId: parentRunId }),
        createRunId: () => input.countersignRunIds[0]!,
        hostAdapters: [adapter("pi", nestedHost)],
      });
      assert.equal(first.exitCode, 0, first.stderr ?? "first countersign");
      assert.equal(
        (objectPayloads(first.terminal!.roleOutcome)[0] as { countersignStatus: string })
          .countersignStatus,
        "continue",
      );

      // 3. Rewrite already done; resume same countersign run → new court converged.
      const second = await summonPublicRole({
        role: "countersign",
        argv: ["裁：#924 已按封驳重写，请复审。", "--project", request.cwd],
        cwd: request.cwd,
        home: input.home,
        packageRoot: input.packageRoot,
        ...(parentRunId === "" ? {} : { correlationId: parentRunId }),
        // same-ticket resume: do not force createRunId — let seat resume prior
        hostAdapters: [adapter("pi", nestedHost)],
      });
      assert.equal(second.exitCode, 0, second.stderr ?? "second countersign");
      assert.equal(
        (objectPayloads(second.terminal!.roleOutcome).at(-1) as { countersignStatus: string })
          .countersignStatus,
        "converged",
      );
      // Same run id, court count increased (two sealed submissions / two payloads).
      assert.equal(first.runDirectory, second.runDirectory);
      const childRunId = basename(first.runDirectory!).replace(/@countersign$/, "");
      const rows = await readRecordedSubmissionRows(
        request.cwd,
        childRunId,
        input.home,
      );
      assert.ok(rows.length >= 2, `expected ≥2 courts, got ${rows.length}`);

      // Child leg ledger carries caller correlation.
      const childState = await readRoleRunState(
        first.runDirectory!,
        piDurablePrincipalAuthority,
      );
      // correlation rides invocation.json / activation — read admitted request.
      const admittedRaw = await readFile(
        join(first.runDirectory!, "invocation.json"),
        "utf8",
      ).catch(() => "");
      assert.ok(
        admittedRaw.includes(parentRunId) ||
          JSON.stringify(childState).includes(parentRunId),
        "child ledger must reference parent correlation/caller",
      );

      // 4. Seal secretariat.
      const coords = piDurablePrincipalAuthority.decode(request.principal);
      await mkdir(coords.sessionDirectory, { recursive: true });
      const details = {
        secretariatStatus: "sealed",
        ticketNumber: 924,
      };
      await writeFile(
        coords.sessionFile,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call_secretariat_seal",
            toolName: SECRETARIAT_OUTPUT_TOOL_NAME,
            isError: false,
            details,
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
        details,
        toolCallId: "call_secretariat_seal",
        ...(request.courtAttemptId === undefined
          ? {}
          : { courtAttemptId: request.courtAttemptId }),
      });
      return { code: 0, stderr: "", timedOut: false };
    },
  };
}

function secretariatEscalateHost(input: {
  packageRoot: string;
  home: string;
}): RoleTurnHost {
  const nestedPiRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "diarist") return courtDiaristFor924()(args, options);
    if (role === "countersign") {
      return scriptedCountersign({
        countersignStatus: "escalate",
        decisionGate: {
          question: "中书省是否拆席？",
          options: ["暂不", "拆"],
        },
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role}`);
  };
  const nestedHost = roleTurnHostFromLegacyPiRunner({
    packageRoot: input.packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    piRunner: nestedPiRunner,
  });
  return {
    async executeTurn(request: RoleTurnRequest) {
      if (request.activation.role !== "secretariat") {
        return nestedHost.executeTurn(request);
      }
      const parentCorr =
        request.runDirectory.split("/").filter(Boolean).at(-1)?.replace(/@.*$/, "") ?? "";
      const summoned = await summonPublicRole({
        role: "countersign",
        argv: ["裁：#924 上呈事项。", "--project", request.cwd],
        cwd: request.cwd,
        home: input.home,
        packageRoot: input.packageRoot,
        ...(parentCorr === "" ? {} : { correlationId: parentCorr }),
        createRunId: () => "01a0sec924-esc0-7000-8000-000000000001",
        hostAdapters: [adapter("pi", nestedHost)],
      });
      assert.equal(summoned.exitCode, 0);
      const coords = piDurablePrincipalAuthority.decode(request.principal);
      await mkdir(coords.sessionDirectory, { recursive: true });
      const details = {
        secretariatStatus: "escalate",
        decisionGate: {
          question: "中书省是否拆席？",
          options: ["暂不", "拆"],
        },
      };
      const parentLeaf = request.runDirectory.split("/").filter(Boolean).at(-1) ?? "";
      const parentRunId = parentLeaf.replace(/@.*$/, "");
      await writeFile(
        coords.sessionFile,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId: "call_secretariat_esc",
            toolName: SECRETARIAT_OUTPUT_TOOL_NAME,
            isError: false,
            details,
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
        details,
        toolCallId: "call_secretariat_esc",
        ...(request.courtAttemptId === undefined
          ? {}
          : { courtAttemptId: request.courtAttemptId }),
      });
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

    // Materials roster includes 票面法 + conduct guides.
    assert.ok(
      MAIN_ROLE_SESSION_MATERIALS.secretariat.includes("souls/ticket-law.md"),
    );

    const secretariatRunId = "01a0sec924-0000-7000-8000-000000000001";
    const countersignRunIds = ["01a0csn924-0000-7000-8000-000000000001"];
    const capture = captureIo();
    const host = secretariatThroughLineHost({
      packageRoot,
      home,
      bodyPath,
      cleanBody,
      countersignRunIds,
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

    // Body replaced and attributable to this call.
    const finalBody = await readFile(bodyPath, "utf8");
    assert.equal(finalBody, cleanBody);
    assert.notEqual(finalBody, dirtyBody);

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
    const host = secretariatEscalateHost({ packageRoot, home });
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
