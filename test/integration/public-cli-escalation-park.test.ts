/**
 * #1057: 审核上呈停在上呈者本人 run，父席等待；公开 resume 不另附 subject
 * 也能交卷。通过原话回到父席，父席自己决定是否再交；未完成的审刑院闸继续跑。
 * 结论不是三态时重开该发言者。真正宿主失败不封成通过。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { OFFICER_CONCLUSION_REASK } from "../../src/gatekeeper-role.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { runAkRole, type CliResult, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import {
  savePublicCliConfig,
  setPersistentSeatConfig,
} from "../../src/public-cli/config.ts";
import {
  findRunDirectoryById,
  readRoleRunIdentity,
} from "../../src/public-cli/run-lifecycle.ts";
import { listBookRunDirectories } from "../../src/role-run-placement.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import {
  captureIo,
  seedGitProject,
  withTempHome,
} from "../helpers/failure-settlement-kit.ts";

const packageRoot = join(import.meta.dirname, "../..");

function adapter(name: string, host: RoleTurnHost): NamedRoleTurnHostAdapter {
  return { name, create: () => ({ ok: true as const, host }) };
}

function latestPayload(terminal: {
  roleOutcome: { kind: string; payloads?: readonly unknown[]; status?: string };
} | undefined): Record<string, unknown> | undefined {
  const outcome = terminal?.roleOutcome;
  if (outcome === undefined) return undefined;
  const payloads = outcome.payloads ?? [];
  const latest = payloads[payloads.length - 1];
  return latest !== null && typeof latest === "object" && !Array.isArray(latest)
    ? latest as Record<string, unknown>
    : undefined;
}

type ParkObservation = {
  readonly home: string;
  readonly escalated: CliResult;
  readonly parentRunId: string;
  readonly parentRunDirectory: string;
  readonly bookKey: string;
  readonly judgeSubmissions: readonly unknown[];
  readonly parentPrompts: readonly string[];
  readonly officerPrompts: readonly string[];
  readonly resumeStderr: string[];
  resume(): Promise<CliResult>;
};

async function observeParkedEscalation(
  officerRunner: LegacyFauxPiRunner,
  onParentResume: (prompt: string) => { code: number; stderr: string },
  assertIn: (observed: ParkObservation) => Promise<void>,
): Promise<void> {
  const temps: string[] = [];
  try {
    await withTempHome(async (home) => {
      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      seedGitProject(project);
      const seat = { provider: "test", model: "caller-seat", thinking: "high" } as const;
      let config = { seats: {} };
      for (const role of ["gatekeeper", "notary", "auditor", "diarist", "judge"] as const) {
        config = setPersistentSeatConfig(config, role, seat);
      }
      await savePublicCliConfig(config, home);
      const judgeSubmissions: unknown[] = [];
      const parentPrompts: string[] = [];
      const officerPrompts: string[] = [];
      const observedResumeStderr: string[] = [];
      const officerHost = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: officerRunner,
      });
      const recordingOfficer: RoleTurnHost = {
        async executeTurn(request) {
          if (request.continuation.kind === "resume") officerPrompts.push(request.continuation.prompt);
          return officerHost.executeTurn(request);
        },
      };
      const officerAdapters = [adapter("pi", recordingOfficer)];
      const judgeHost: RoleTurnHost = {
        async executeTurn(request: RoleTurnRequest) {
          if (request.continuation.kind === "resume") {
            parentPrompts.push(request.continuation.prompt);
            const resumed = onParentResume(request.continuation.prompt);
            return { ...resumed, timedOut: false };
          }
          const verdict = { status: "converged", note: "原判词" };
          judgeSubmissions.push(verdict);
          const coords = piDurablePrincipalAuthority.decode(request.principal);
          const socketDir = await mkdtemp(join(tmpdir(), "ak-1057-judge-"));
          temps.push(socketDir);
          const prepared = await prepareRoleEnvelope({
            request: { ...request, host: "pi" },
            dependencies: {
              ...createRoleRuntimeDependencies(packageRoot),
              hostAdapters: officerAdapters,
            },
            socketPath: join(socketDir, "mcp.sock"),
            listTerminatingToolOnMcp: false,
            sessionFile: coords.sessionFile,
          });
          try {
            await prepared.ingestStructuredOutput(verdict);
            const closed = await prepared.closeRound();
            if (!closed.accepted) {
              const failure = "failure" in closed ? closed.failure : undefined;
              return {
                code: 1,
                stderr: failure?.diagnostic ?? "judge round failed",
                timedOut: false,
                ...(failure === undefined ? {} : { knownFailure: failure }),
              };
            }
            return { code: 0, stderr: "", timedOut: false };
          } finally {
            await prepared.dispose?.();
          }
        },
      };
      const routed: RoleTurnHost = {
        async executeTurn(request) {
          return request.activation.role === "judge"
            ? judgeHost.executeTurn(request)
            : recordingOfficer.executeTurn(request);
        },
      };
      const capture = captureIo();
      const escalated = await runAkRole(
        ["judge", "--model", "test/caller-seat:high", "--project", project, "review"],
        {
          packageRoot,
          home,
          cwd: project,
          io: capture.io,
          principalAuthority: piDurablePrincipalAuthority,
          roleTurnHost: judgeHost,
          hostAdapters: [adapter("pi", routed)],
        },
      );
      assert.equal(escalated.exitCode, 0, capture.stderr.join("") || capture.stdout.join(""));
      const books = await readdir(join(home, ".ak-roles", "books"));
      const runs = (await Promise.all(books.map((book) => listBookRunDirectories(join(home, ".ak-roles", "books", book))))).flat();
      const identities = (await Promise.all(runs.map((runDirectory) => readRoleRunIdentity(runDirectory))))
        .filter((identity) => identity !== undefined);
      const parent = identities.find((identity) => identity.role === "judge");
      assert.ok(parent, `judge run missing: ${JSON.stringify(identities)}`);
      await assertIn({
        home,
        escalated,
        parentRunId: parent.runId,
        parentRunDirectory: parent.runDirectory,
        bookKey: parent.bookKey,
        judgeSubmissions,
        parentPrompts,
        officerPrompts,
        resumeStderr: observedResumeStderr,
        async resume() {
          const officerRunId = escalated.terminal?.runId;
          assert.equal(typeof officerRunId, "string");
          const resumeCapture = captureIo();
          const result = await runAkRole(["resume", officerRunId!], {
            packageRoot,
            home,
            cwd: project,
            io: resumeCapture.io,
            principalAuthority: piDurablePrincipalAuthority,
            hostAdapters: [adapter("pi", routed)],
          });
          observedResumeStderr.push(resumeCapture.stderr.join(""));
          return result;
        },
      });
    }, { prefix: "ak-1057-park-" });
  } finally {
    await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

test("#1057 auditor escalation pauses the auditor and the waiting parent receives the pass words", async () => {
  let auditorCalls = 0;
  const officerRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "converged", note: "符宝郎通过" },
      })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      const details = auditorCalls === 1
        ? { status: "escalate", decisionGate: { question: "请陛下裁决" }, explanation: "完整审刑院原话" }
        : { status: "converged", explanation: "上呈后交卷" };
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details,
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  };
  await observeParkedEscalation(officerRunner, () => ({ code: 0, stderr: "" }), async (observed) => {
    assert.notEqual(observed.escalated.terminal?.runId, observed.parentRunId);
    assert.equal(observed.escalated.terminal?.roleOutcome.role, "auditor");
    assert.notEqual(observed.escalated.terminal?.roleOutcome.kind, "audit_escalation");
    assert.equal(latestPayload(observed.escalated.terminal)?.status, "escalate");
    assert.equal(latestPayload(observed.escalated.terminal)?.explanation, "完整审刑院原话");
    assert.equal(observed.judgeSubmissions.length, 1);
    const parentBefore = await readRoleRunIdentity(observed.parentRunDirectory);
    assert.notEqual(parentBefore?.state, "terminal");

    const continued = await observed.resume();
    assert.equal(continued.exitCode, 0, observed.resumeStderr.join(""));
    assert.equal(auditorCalls, 2);
    assert.equal(observed.judgeSubmissions.length, 1);
    assert.equal(observed.parentPrompts.length, 1);
    assert.equal(observed.parentPrompts[0]?.includes("上呈后交卷"), true);
    const parentAfter = await readRoleRunIdentity(observed.parentRunDirectory);
    assert.equal(parentAfter?.state, "terminal");
    assert.equal(continued.terminal?.roleOutcome.role, "judge");
    assert.equal(continued.terminal?.roleOutcome.kind, "accepted");
    assert.notEqual(continued.terminal?.roleOutcome.kind, "audit_escalation");
    const parentPayloads = continued.terminal?.roleOutcome.kind === "accepted"
      ? continued.terminal.roleOutcome.payloads ?? []
      : [];
    assert.equal(parentPayloads.length, 1);
    assert.deepEqual(parentPayloads[0], { status: "converged", note: "原判词" });
    assert.deepEqual(continued.terminal?.roleOutcome.decisiveFacts?.officerReceipt, {
      status: "converged",
      explanation: "上呈后交卷",
    });
    const auditorDir = await findRunDirectoryById(
      observed.home,
      observed.escalated.terminal?.runId ?? "",
      observed.bookKey,
      "auditor",
    );
    assert.equal(typeof auditorDir, "string");
  });
});

test("#1057 notary pass after escalation still runs the auditor and returns both original words", async () => {
  let notaryCalls = 0;
  let auditorCalls = 0;
  const officerRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      notaryCalls += 1;
      const details = notaryCalls === 1
        ? { status: "escalate", explanation: "符宝郎上呈原话" }
        : { status: "converged", explanation: "符宝郎通过原话" };
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details,
      })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details: { status: "converged", explanation: "审刑院通过原话" },
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  };
  await observeParkedEscalation(officerRunner, () => ({ code: 0, stderr: "" }), async (observed) => {
    assert.equal(observed.escalated.terminal?.roleOutcome.role, "notary");
    assert.equal(latestPayload(observed.escalated.terminal)?.explanation, "符宝郎上呈原话");
    assert.equal(auditorCalls, 0);
    const continued = await observed.resume();
    assert.equal(continued.exitCode, 0, observed.resumeStderr.join(""));
    assert.equal(notaryCalls, 2);
    assert.equal(auditorCalls, 1);
    assert.equal(observed.judgeSubmissions.length, 1);
    assert.equal(observed.parentPrompts.length, 1);
    assert.equal(observed.parentPrompts[0]?.includes("符宝郎通过原话"), true);
    assert.equal(observed.parentPrompts[0]?.includes("审刑院通过原话"), true);
    assert.equal(continued.terminal?.roleOutcome.role, "judge");
    assert.equal(continued.terminal?.roleOutcome.kind, "accepted");
    const parentPayloads = continued.terminal?.roleOutcome.kind === "accepted"
      ? continued.terminal.roleOutcome.payloads ?? []
      : [];
    assert.equal(parentPayloads.length, 1);
    assert.deepEqual(parentPayloads[0], { status: "converged", note: "原判词" });
  });
});

test("#1057 a conclusion outside the three states reopens that officer", async () => {
  let auditorCalls = 0;
  const officerRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "converged", note: "符宝郎通过" },
      })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      const details = auditorCalls === 1
        ? { status: "escalate", explanation: "先上呈" }
        : auditorCalls === 2
          ? { status: "undecidable", explanation: "读不出" }
          : { status: "converged", explanation: "重开后通过" };
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details,
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  };
  await observeParkedEscalation(officerRunner, () => ({ code: 0, stderr: "" }), async (observed) => {
    const continued = await observed.resume();
    assert.equal(continued.exitCode, 0, observed.resumeStderr.join(""));
    assert.equal(auditorCalls, 3);
    assert.equal(observed.officerPrompts.some((prompt) => prompt.includes(OFFICER_CONCLUSION_REASK)), true);
    assert.equal(observed.parentPrompts.some((prompt) => prompt.includes("重开后通过")), true);
    assert.equal(observed.judgeSubmissions.length, 1);
    assert.equal(continued.terminal?.roleOutcome.kind, "accepted");
    assert.equal(continued.terminal?.roleOutcome.role, "judge");
  });
});

test("#1057 a parent host failure after the pass is not sealed as acceptance", async () => {
  let auditorCalls = 0;
  const officerRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "converged", note: "符宝郎通过" },
      })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      const details = auditorCalls === 1
        ? { status: "escalate", explanation: "先上呈" }
        : { status: "converged", explanation: "通过后宿主失败" };
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details,
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  };
  await observeParkedEscalation(officerRunner, () => ({ code: 1, stderr: "judge host failed" }), async (observed) => {
    const continued = await observed.resume();
    assert.notEqual(continued.exitCode, 0);
    assert.notEqual(continued.terminal?.roleOutcome.kind, "accepted");
    assert.notEqual(continued.terminal?.roleOutcome.kind, "audit_escalation");
    assert.equal(observed.judgeSubmissions.length, 1);
    assert.equal(observed.parentPrompts.some((prompt) => prompt.includes("通过后宿主失败")), true);
  });
});
