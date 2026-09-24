/**
 * #1057: public judge entry, officer escalation stays on that officer,
 * and `resume <runId> <ruling>` passes the ruling through. The parent is
 * resumed once with that conclusion. No second audit order, no sealed
 * stand-in when the judge does not submit again.
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
import { readRoleRunIdentity } from "../../src/public-cli/run-lifecycle.ts";
import { listBookRunDirectories } from "../../src/role-run-placement.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { readRecordedSubmissionRows } from "../../src/submission-ledger.ts";
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
const VERDICT = { status: "converged", mark: 1 } as const;
const RULING = "ruling-1057";

function adapter(name: string, host: RoleTurnHost): NamedRoleTurnHostAdapter {
  return { name, create: () => ({ ok: true as const, host }) };
}

function latestPayload(terminal: {
  roleOutcome: { kind: string; payloads?: readonly unknown[] };
} | undefined): Record<string, unknown> | undefined {
  const payloads = terminal?.roleOutcome.payloads ?? [];
  const latest = payloads[payloads.length - 1];
  return latest !== null && typeof latest === "object" && !Array.isArray(latest)
    ? latest as Record<string, unknown>
    : undefined;
}

type Observation = {
  readonly home: string;
  readonly project: string;
  readonly first: CliResult;
  readonly parentRunId: string;
  readonly parentRunDirectory: string;
  readonly judgeSubmissions: readonly unknown[];
  readonly parentPrompts: readonly string[];
  readonly officerPrompts: readonly string[];
  readonly resumeStderr: string[];
  resume(message?: string): Promise<CliResult>;
};

async function runJudge(
  officerRunner: LegacyFauxPiRunner,
  onParentResume: (prompt: string) => { code: number; stderr: string; verdict?: unknown },
  assertIn: (observed: Observation) => Promise<void>,
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
      const submitVerdict = async (request: RoleTurnRequest, verdict: unknown) => {
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
              timedOut: false as const,
              ...(failure === undefined ? {} : { knownFailure: failure }),
            };
          }
          return { code: 0, stderr: "", timedOut: false as const };
        } finally {
          await prepared.dispose?.();
        }
      };
      const judgeHost: RoleTurnHost = {
        async executeTurn(request: RoleTurnRequest) {
          if (request.continuation.kind === "resume") {
            parentPrompts.push(request.continuation.prompt);
            const resumed = onParentResume(request.continuation.prompt);
            if (resumed.verdict === undefined) {
              return { code: resumed.code, stderr: resumed.stderr, timedOut: false };
            }
            return submitVerdict(request, resumed.verdict);
          }
          return submitVerdict(request, VERDICT);
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
      const first = await runAkRole(
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
      assert.equal(first.exitCode, 0, capture.stderr.join("") || capture.stdout.join(""));
      const books = await readdir(join(home, ".ak-roles", "books"));
      const runs = (await Promise.all(books.map((book) => listBookRunDirectories(join(home, ".ak-roles", "books", book))))).flat();
      const identities = (await Promise.all(runs.map((runDirectory) => readRoleRunIdentity(runDirectory))))
        .filter((identity) => identity !== undefined);
      const parent = identities.find((identity) => identity.role === "judge");
      assert.ok(parent, `judge run missing: ${JSON.stringify(identities.map((identity) => identity.role))}`);
      await assertIn({
        home,
        project,
        first,
        parentRunId: parent.runId,
        parentRunDirectory: parent.runDirectory,
        judgeSubmissions,
        parentPrompts,
        officerPrompts,
        resumeStderr: observedResumeStderr,
        async resume(message?: string) {
          const officerRunId = first.terminal?.runId;
          assert.equal(typeof officerRunId, "string");
          const resumeCapture = captureIo();
          const args = message === undefined ? ["resume", officerRunId!] : ["resume", officerRunId!, message];
          const result = await runAkRole(args, {
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

function bothPass(): LegacyFauxPiRunner {
  return async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "converged", mark: 2 },
      })(args, options);
    }
    if (role === "auditor") {
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details: { status: "converged", mark: 3 },
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  };
}

test("#1057 public judge entry passes both audits once and keeps that verdict", async () => {
  let notaryCalls = 0;
  let auditorCalls = 0;
  const officerRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") notaryCalls += 1;
    if (role === "auditor") auditorCalls += 1;
    return bothPass()(args, options);
  };
  await runJudge(officerRunner, () => ({ code: 0, stderr: "" }), async (observed) => {
    assert.equal(notaryCalls, 1);
    assert.equal(auditorCalls, 1);
    assert.equal(observed.judgeSubmissions.length, 1);
    assert.equal(observed.first.terminal?.roleOutcome.role, "judge");
    assert.equal(observed.first.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(latestPayload(observed.first.terminal), VERDICT);
    assert.equal((observed.first.terminal?.roleOutcome.payloads ?? []).length, 1);
    assert.equal((await readRoleRunIdentity(observed.parentRunDirectory))?.state, "terminal");
  });
});

test("#1057 auditor escalation is the auditor run and the parent is not that escalation", async () => {
  const escalated = { status: "escalate", mark: 4 };
  const passed = { status: "converged", mark: 5 };
  let auditorCalls = 0;
  const officerRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "converged", mark: 2 },
      })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details: auditorCalls === 1 ? escalated : passed,
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  };
  await runJudge(officerRunner, () => ({ code: 0, stderr: "" }), async (observed) => {
    assert.notEqual(observed.first.terminal?.runId, observed.parentRunId);
    assert.equal(observed.first.terminal?.roleOutcome.role, "auditor");
    assert.equal(latestPayload(observed.first.terminal)?.status, "escalate");
    assert.deepEqual(latestPayload(observed.first.terminal), escalated);
    assert.notEqual((await readRoleRunIdentity(observed.parentRunDirectory))?.state, "terminal");
    const parentRows = await readRecordedSubmissionRows(observed.project, observed.parentRunId, observed.home);
    assert.equal(parentRows.some((row) => row.kind === "accepted" || row.kind === "audit-escalation"), false);

    const continued = await observed.resume(RULING);
    assert.equal(continued.exitCode, 0, observed.resumeStderr.join(""));
    assert.equal(observed.officerPrompts[0], RULING);
    assert.equal(auditorCalls, 2);
    assert.equal(observed.judgeSubmissions.length, 1);
    assert.equal(observed.parentPrompts.length, 1);
    assert.deepEqual(JSON.parse(observed.parentPrompts[0] ?? ""), passed);
    assert.equal(continued.terminal?.roleOutcome.role, "judge");
    assert.equal(continued.terminal?.roleOutcome.kind, "no_receipt");
    const after = await readRecordedSubmissionRows(observed.project, observed.parentRunId, observed.home);
    assert.equal(after.some((row) => row.kind === "accepted" || row.kind === "audit-escalation"), false);
  });
});

test("#1057 a notary pass does not open a second auditor gate", async () => {
  const notaryPass = { status: "converged", mark: 6 };
  let notaryCalls = 0;
  let auditorCalls = 0;
  const officerRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      notaryCalls += 1;
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: notaryCalls === 1 ? { status: "escalate", mark: 7 } : notaryPass,
      })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details: { status: "converged", mark: 8 },
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  };
  await runJudge(officerRunner, () => ({ code: 0, stderr: "" }), async (observed) => {
    assert.equal(observed.first.terminal?.roleOutcome.role, "notary");
    assert.equal(latestPayload(observed.first.terminal)?.status, "escalate");
    assert.equal(auditorCalls, 0);
    const continued = await observed.resume(RULING);
    assert.equal(continued.exitCode, 0, observed.resumeStderr.join(""));
    assert.equal(notaryCalls, 2);
    assert.equal(auditorCalls, 0);
    assert.equal(observed.judgeSubmissions.length, 1);
    assert.deepEqual(JSON.parse(observed.parentPrompts[0] ?? ""), notaryPass);
    assert.equal(continued.terminal?.roleOutcome.kind, "no_receipt");
  });
});

test("#1057 a conclusion outside the three states returns to that officer", async () => {
  let auditorCalls = 0;
  const officerRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "converged", mark: 2 },
      })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      const details = auditorCalls === 1
        ? { status: "escalate", mark: 4 }
        : auditorCalls === 2
          ? { status: "undecidable", mark: 5 }
          : { status: "converged", mark: 6 };
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details,
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  };
  await runJudge(officerRunner, () => ({ code: 0, stderr: "" }), async (observed) => {
    const continued = await observed.resume(RULING);
    assert.equal(continued.exitCode, 0, observed.resumeStderr.join(""));
    assert.equal(auditorCalls, 3);
    assert.equal(observed.officerPrompts[0], RULING);
    assert.equal(observed.officerPrompts.some((prompt) => prompt === OFFICER_CONCLUSION_REASK), true);
    assert.equal(observed.judgeSubmissions.length, 1);
    assert.deepEqual(JSON.parse(observed.parentPrompts[0] ?? ""), { status: "converged", mark: 6 });
  });
});

test("#1057 a parent host failure after the officer conclusion is not a pass", async () => {
  let auditorCalls = 0;
  const officerRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "converged", mark: 2 },
      })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details: auditorCalls === 1
          ? { status: "escalate", mark: 4 }
          : { status: "converged", mark: 5 },
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  };
  await runJudge(officerRunner, () => ({ code: 1, stderr: "judge host failed" }), async (observed) => {
    const continued = await observed.resume(RULING);
    assert.notEqual(continued.exitCode, 0);
    assert.notEqual(continued.terminal?.roleOutcome.kind, "accepted");
    assert.notEqual(continued.terminal?.roleOutcome.kind, "audit_escalation");
    assert.equal(observed.judgeSubmissions.length, 1);
  });
});

test("#1057 a new verdict after the officer conclusion re-enters the judge gates", async () => {
  const next = { status: "converged", mark: 9 };
  let notaryCalls = 0;
  let auditorCalls = 0;
  const officerRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      notaryCalls += 1;
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: { status: "converged", mark: 2 },
      })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details: auditorCalls === 1
          ? { status: "escalate", mark: 4 }
          : { status: "converged", mark: 5 },
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  };
  await runJudge(
    officerRunner,
    () => ({ code: 0, stderr: "", verdict: next }),
    async (observed) => {
      const continued = await observed.resume(RULING);
      assert.equal(continued.exitCode, 0, observed.resumeStderr.join(""));
      assert.equal(observed.officerPrompts[0], RULING);
      assert.equal(notaryCalls, 2);
      assert.equal(auditorCalls, 3);
      assert.equal(observed.judgeSubmissions.length, 2);
      assert.equal(continued.terminal?.roleOutcome.kind, "accepted");
      assert.equal(continued.terminal?.roleOutcome.role, "judge");
      assert.deepEqual(latestPayload(continued.terminal), next);
    },
  );
});
