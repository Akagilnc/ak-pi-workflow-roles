/**
 * #1057: public judge entry, officer escalation stays on that officer,
 * and `resume <runId> <ruling>` passes the ruling through. The parent is
 * resumed once. Officer receipts stay on their structured submissions.
 * The standing verdict is sealed only when this resume adds no new tool call.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
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
  readonly officerReceipts: readonly { readonly role: string; readonly details: unknown }[];
  readonly parentReceipts: readonly (readonly unknown[])[];
  readonly resumeStderr: string[];
  resume(message?: string): Promise<CliResult>;
  resumeRun(runId: string, message?: string): Promise<CliResult>;
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
      const officerReceipts: { role: string; details: unknown }[] = [];
      const parentReceipts: (readonly unknown[])[] = [];
      const observedResumeStderr: string[] = [];
      const officerHost = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: officerRunner,
      });
      const recordingOfficer: RoleTurnHost = {
        async executeTurn(request) {
          if (request.continuation.kind === "resume") officerPrompts.push(request.continuation.prompt);
          const result = await officerHost.executeTurn(request);
          const role = request.activation.role;
          if (role === "notary" || role === "auditor") {
            const sessionFile = piDurablePrincipalAuthority.decode(request.principal).sessionFile;
            officerReceipts.push({ role, details: await latestClosureDetails(sessionFile) });
          }
          return result;
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
            if ("retry" in closed) {
              return { code: 0, stderr: "", timedOut: false as const };
            }
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
            if (request.continuation.receipts !== undefined) {
              parentReceipts.push(request.continuation.receipts);
            }
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
        officerReceipts,
        parentReceipts,
        resumeStderr: observedResumeStderr,
        async resumeRun(runId: string, message?: string) {
          const resumeCapture = captureIo();
          const args = message === undefined ? ["resume", runId] : ["resume", runId, message];
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
        resume(message?: string) {
          const officerRunId = first.terminal?.runId;
          assert.equal(typeof officerRunId, "string");
          return this.resumeRun(officerRunId!, message);
        },
      });
    }, { prefix: "ak-1057-park-" });
  } finally {
    await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
  }
}

async function latestClosureDetails(sessionFile: string): Promise<unknown> {
  const text = await readFile(sessionFile, "utf8");
  let details: unknown;
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line) as { customType?: string; data?: { details?: unknown } };
    if (row.customType === "ak-role-submission-closure") details = row.data?.details;
  }
  return details;
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
    assert.deepEqual(observed.officerReceipts.at(-1), { role: "auditor", details: passed });
    assert.deepEqual(observed.parentReceipts, [[passed]]);
    assert.equal(continued.terminal?.roleOutcome.role, "judge");
    assert.equal(continued.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(latestPayload(continued.terminal), VERDICT);
    const after = await readRecordedSubmissionRows(observed.project, observed.parentRunId, observed.home);
    assert.equal(after.some((row) => row.kind === "accepted"), true);
  });
});

test("#1057 a notary pass continues the judge auditor gate and settles the original verdict", async () => {
  const notaryEscalate = { status: "escalate", mark: 7 };
  const notaryPass = { status: "converged", mark: 6 };
  const auditorPass = { status: "converged", mark: 8 };
  let notaryCalls = 0;
  let auditorCalls = 0;
  const officerRunner: LegacyFauxPiRunner = async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      notaryCalls += 1;
      return scriptedTerminatingToolSession({
        role: "notary",
        toolName: NOTARY_OUTPUT_TOOL_NAME,
        details: notaryCalls === 1 ? notaryEscalate : notaryPass,
      })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details: auditorPass,
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
    assert.equal(auditorCalls, 1);
    assert.equal(observed.judgeSubmissions.length, 1);
    assert.equal(observed.parentPrompts.length, 1);
    assert.deepEqual(observed.officerReceipts, [
      { role: "notary", details: notaryEscalate },
      { role: "notary", details: notaryPass },
      { role: "auditor", details: auditorPass },
    ]);
    assert.deepEqual(observed.parentReceipts, [[notaryPass, auditorPass]]);
    assert.equal(continued.terminal?.roleOutcome.kind, "accepted");
    assert.equal(continued.terminal?.roleOutcome.role, "judge");
    assert.deepEqual(latestPayload(continued.terminal), VERDICT);
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
    assert.equal(observed.parentPrompts.length, 1);
    assert.deepEqual(observed.officerReceipts.at(-1), {
      role: "auditor",
      details: { status: "converged", mark: 6 },
    });
    assert.deepEqual(observed.parentReceipts, [[{ status: "converged", mark: 6 }]]);
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

test("#1057 an earlier candidate does not block the verdict that passed", async () => {
  const next = { status: "converged", mark: 9 };
  let parentResumes = 0;
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
          ? { status: "converged", mark: 5 }
          : auditorCalls === 3
            ? { status: "escalate", mark: 7 }
            : { status: "converged", mark: 8 };
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details,
      })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  };
  await runJudge(officerRunner, () => {
    parentResumes += 1;
    return parentResumes === 1
      ? { code: 0, stderr: "", verdict: next }
      : { code: 0, stderr: "" };
  }, async (observed) => {
    const opened = await observed.resume(RULING);
    assert.equal(opened.exitCode, 0, observed.resumeStderr.join(""));
    assert.equal(opened.terminal?.roleOutcome.role, "auditor");
    assert.equal(latestPayload(opened.terminal)?.status, "escalate");
    const secondId = opened.terminal?.runId;
    assert.equal(typeof secondId, "string");
    const settled = await observed.resumeRun(secondId!, RULING);
    assert.equal(settled.exitCode, 0, observed.resumeStderr.join(""));
    assert.equal(settled.terminal?.roleOutcome.kind, "accepted");
    assert.equal(settled.terminal?.roleOutcome.role, "judge");
    assert.deepEqual(latestPayload(settled.terminal), next);
  });
});

test("#1057 an unfinished new verdict does not seal the standing one", async () => {
  const next = { status: "converged", mark: 9 };
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
          ? { status: "converged", mark: 5 }
          : { status: "continue", mark: 6 };
      return scriptedTerminatingToolSession({
        role: "auditor",
        toolName: AUDITOR_OUTPUT_TOOL_NAME,
        details,
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
      assert.equal(auditorCalls, 3);
      assert.equal(observed.judgeSubmissions.length, 2);
      assert.notEqual(continued.terminal?.roleOutcome.kind, "accepted");
      const rows = await readRecordedSubmissionRows(observed.project, observed.parentRunId, observed.home);
      assert.equal(rows.some((row) => row.kind === "accepted"), false);
      assert.equal(rows.some((row) => row.kind === "candidate" && row.accepted !== null && typeof row.accepted === "object" && (row.accepted as { mark?: unknown }).mark === next.mark), true);
    },
  );
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
