/**
 * #1057: officer escalation pauses that officer.
 * A later pass resumes the parent with that officer's receipt.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { runAkRole, type CliResult, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import { savePublicCliConfig, setPersistentSeatConfig } from "../../src/public-cli/config.ts";
import { readRoleRunIdentity } from "../../src/public-cli/run-lifecycle.ts";
import { listBookRunDirectories } from "../../src/role-run-placement.ts";
import { prepareRoleEnvelope } from "../../src/role-envelope.ts";
import { createRoleRuntimeDependencies } from "../../src/role-runtime-dependencies.ts";
import { readRecordedSubmissionRows } from "../../src/submission-ledger.ts";
import { readableGateItem } from "../../src/readable-gate-item.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
  type LegacyFauxPiRunner,
} from "../helpers/role-turn-host-fixture.ts";
import { captureIo, seedGitProject, withTempHome } from "../helpers/failure-settlement-kit.ts";

const packageRoot = join(import.meta.dirname, "../..");
const VERDICT = { status: "converged", mark: 1 } as const;
const RULING = "ruling-1057";

function adapter(name: string, host: RoleTurnHost): NamedRoleTurnHostAdapter {
  return { name, create: () => ({ ok: true as const, host }) };
}

type Observation = {
  readonly first: CliResult;
  readonly project: string;
  readonly home: string;
  readonly parentRunId: string;
  readonly parentRunDirectory: string;
  readonly parentMessages: readonly string[];
  readonly judgeSubmissions: readonly unknown[];
  readonly officerSessions: readonly {
    readonly role: string;
    readonly sessionFile: string;
    readonly continuation: string;
    readonly prompt: string;
    readonly activation: RoleTurnRequest["activation"];
  }[];
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
      const officerSessions: {
        role: string;
        sessionFile: string;
        continuation: string;
        prompt: string;
        activation: RoleTurnRequest["activation"];
      }[] = [];
      const parentMessages: string[] = [];
      const officerHost = roleTurnHostFromLegacyPiRunner({
        packageRoot,
        principalAuthority: piDurablePrincipalAuthority,
        piRunner: officerRunner,
      });
      const recordingOfficer: RoleTurnHost = {
        async executeTurn(request) {
          if (request.activation.role === "notary" || request.activation.role === "auditor") {
            const coordinates = piDurablePrincipalAuthority.decode(request.principal);
            officerSessions.push({
              role: request.activation.role,
              sessionFile: coordinates.sessionFile,
              continuation: request.continuation.kind,
              prompt: request.continuation.prompt,
              activation: request.activation,
            });
          }
          return officerHost.executeTurn(request);
        },
      };
      const submitVerdict = async (request: RoleTurnRequest, verdict: unknown) => {
        judgeSubmissions.push(verdict);
        const coords = piDurablePrincipalAuthority.decode(request.principal);
        const socketDir = await mkdtemp(join(tmpdir(), "ak-1057-judge-"));
        temps.push(socketDir);
        const prepared = await prepareRoleEnvelope({
          request: { ...request, host: "pi" },
          dependencies: {
            ...createRoleRuntimeDependencies(packageRoot),
            hostAdapters: [adapter("pi", recordingOfficer)],
          },
          socketPath: join(socketDir, "mcp.sock"),
          listTerminatingToolOnMcp: false,
          sessionFile: coords.sessionFile,
        });
        try {
          await prepared.ingestStructuredOutput(verdict);
          const closed = await prepared.closeRound();
          if (!closed.accepted) {
            if ("retry" in closed) return { code: 0, stderr: "", timedOut: false as const };
            const failure = "failure" in closed ? closed.failure : undefined;
            return {
              code: 1,
              stderr: failure?.diagnostic ?? "judge round failed",
              timedOut: false as const,
            };
          }
          return { code: 0, stderr: "", timedOut: false as const };
        } finally {
          await prepared.dispose?.();
        }
      };
      const judgeHost: RoleTurnHost = {
        async executeTurn(request) {
          if (request.continuation.kind === "resume") {
            parentMessages.push(request.continuation.prompt);
            const resumed = onParentResume(request.continuation.prompt);
            if (resumed.verdict !== undefined) {
              return submitVerdict(request, resumed.verdict);
            }
            return { code: resumed.code, stderr: resumed.stderr, timedOut: false };
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
      assert.ok(parent);
      await assertIn({
        first,
        project,
        home,
        parentRunId: parent.runId,
        parentRunDirectory: parent.runDirectory,
        parentMessages,
        judgeSubmissions,
        officerSessions,
        async resumeRun(runId: string, message?: string) {
          const args = message === undefined ? ["resume", runId] : ["resume", runId, message];
          return runAkRole(args, {
            packageRoot,
            home,
            cwd: project,
            io: captureIo().io,
            principalAuthority: piDurablePrincipalAuthority,
            hostAdapters: [adapter("pi", routed)],
          });
        },
        async resume(message?: string) {
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

function officer(role: "notary" | "auditor", details: unknown): LegacyFauxPiRunner {
  return scriptedTerminatingToolSession({
    role,
    toolName: role === "notary" ? NOTARY_OUTPUT_TOOL_NAME : AUDITOR_OUTPUT_TOOL_NAME,
    details,
  });
}

test("#1057 a public judge verdict passes both audit gates and is accepted", async () => {
  let notaryCalls = 0;
  let auditorCalls = 0;
  await runJudge(async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      notaryCalls += 1;
      return officer("notary", { status: "converged", mark: 2 })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      return officer("auditor", { status: "converged", mark: 3 })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  }, () => ({ code: 0, stderr: "" }), async (observed) => {
    assert.equal(notaryCalls, 1);
    assert.equal(auditorCalls, 1);
    assert.equal(observed.judgeSubmissions.length, 1);
    assert.equal(observed.first.terminal?.roleOutcome.role, "judge");
    assert.equal(observed.first.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(observed.first.terminal?.roleOutcome.payloads?.at(-1), VERDICT);
    assert.equal((await readRoleRunIdentity(observed.parentRunDirectory))?.state, "terminal");
  });
});

test("#1057 a notary escalation pauses that officer and a pass resumes the judge", async () => {
  const passed = { status: "converged", mark: 6 };
  let notaryCalls = 0;
  let auditorCalls = 0;
  await runJudge(async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      notaryCalls += 1;
      return officer("notary", notaryCalls === 1 ? { status: "escalate", mark: 7 } : passed)(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      return officer("auditor", { status: "converged", mark: 8 })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  }, () => ({ code: 0, stderr: "", verdict: VERDICT }), async (observed) => {
    assert.equal(observed.first.terminal?.roleOutcome.role, "notary");
    assert.notEqual((await readRoleRunIdentity(observed.parentRunDirectory))?.state, "terminal");
    const continued = await observed.resume(RULING);
    assert.equal(continued.exitCode, 0);
    assert.equal(notaryCalls, 2);
    assert.equal(auditorCalls, 1);
    assert.equal(observed.parentMessages.length, 1);
    assert.equal(observed.parentMessages[0], readableGateItem(passed));
    const notarySessions = observed.officerSessions.filter((item) => item.role === "notary");
    assert.equal(notarySessions.length, 2);
    assert.equal(notarySessions[0]?.sessionFile, notarySessions[1]?.sessionFile);
    assert.equal(notarySessions[1]?.continuation, "resume");
    assert.equal(notarySessions[1]?.prompt, RULING);
    assert.deepEqual(notarySessions[1]?.activation, notarySessions[0]?.activation);
    assert.equal(continued.terminal?.roleOutcome.role, "judge");
    assert.equal(continued.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(continued.terminal?.roleOutcome.payloads?.at(-1), VERDICT);
    const rows = await readRecordedSubmissionRows(observed.project, observed.parentRunId, observed.home);
    assert.equal(rows.filter((row) => row.role === "judge" && row.kind === "accepted").length, 1);
    assert.deepEqual(rows.at(-1)?.accepted, VERDICT);
  });
});

test("#1057 an auditor escalation is the auditor run and a pass resumes the judge", async () => {
  const passed = { status: "converged", mark: 5 };
  let auditorCalls = 0;
  await runJudge(async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") return officer("notary", { status: "converged", mark: 2 })(args, options);
    if (role === "auditor") {
      auditorCalls += 1;
      return officer("auditor", auditorCalls === 1 ? { status: "escalate", mark: 4 } : passed)(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  }, () => ({ code: 0, stderr: "", verdict: VERDICT }), async (observed) => {
    assert.equal(observed.first.terminal?.roleOutcome.role, "auditor");
    assert.notEqual(observed.first.terminal?.runId, undefined);
    assert.notEqual((await readRoleRunIdentity(observed.parentRunDirectory))?.state, "terminal");
    const continued = await observed.resume(RULING);
    assert.equal(continued.exitCode, 0);
    assert.equal(auditorCalls, 2);
    assert.equal(observed.parentMessages.length, 1);
    assert.equal(observed.parentMessages[0], readableGateItem(passed));
    assert.equal(observed.officerSessions.filter((item) => item.role === "notary").length, 1);
    const auditorSessions = observed.officerSessions.filter((item) => item.role === "auditor");
    assert.equal(auditorSessions.length, 2);
    assert.equal(auditorSessions[0]?.sessionFile, auditorSessions[1]?.sessionFile);
    assert.equal(auditorSessions[1]?.continuation, "resume");
    assert.equal(auditorSessions[1]?.prompt, RULING);
    assert.deepEqual(auditorSessions[1]?.activation, auditorSessions[0]?.activation);
    assert.equal(continued.terminal?.roleOutcome.role, "judge");
    assert.equal(continued.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(continued.terminal?.roleOutcome.payloads?.at(-1), VERDICT);
    const rows = await readRecordedSubmissionRows(observed.project, observed.parentRunId, observed.home);
    assert.equal(rows.filter((row) => row.role === "judge" && row.kind === "accepted").length, 1);
    assert.deepEqual(rows.at(-1)?.accepted, VERDICT);
  });
});

test("#1057 a revised verdict after escalation reruns completed earlier gates", async () => {
  const revised = { status: "converged", mark: 10 } as const;
  let notaryCalls = 0;
  let auditorCalls = 0;
  await runJudge(async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      notaryCalls += 1;
      return officer("notary", { status: "converged", mark: notaryCalls })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      return officer("auditor", auditorCalls === 1
        ? { status: "escalate", mark: 4 }
        : { status: "converged", mark: 5 })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  }, () => ({ code: 0, stderr: "", verdict: revised }), async (observed) => {
    assert.equal(observed.first.terminal?.roleOutcome.role, "auditor");
    const continued = await observed.resume(RULING);
    assert.equal(continued.exitCode, 0);
    assert.equal(notaryCalls, 2);
    assert.equal(auditorCalls, 3);
    assert.equal(continued.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(continued.terminal?.roleOutcome.payloads?.at(-1), revised);
    const rows = await readRecordedSubmissionRows(observed.project, observed.parentRunId, observed.home);
    assert.equal(rows.filter((row) => row.role === "judge" && row.kind === "accepted").length, 1);
    assert.deepEqual(rows.at(-1)?.accepted, revised);
  });
});

test("#1057 a non-three-state auditor conclusion resumes that officer", async () => {
  let auditorCalls = 0;
  await runJudge(async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") return officer("notary", { status: "converged", mark: 2 })(args, options);
    if (role === "auditor") {
      auditorCalls += 1;
      return officer("auditor", auditorCalls === 1
        ? { status: "undecidable", mark: 4 }
        : { status: "converged", mark: 5 })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  }, () => ({ code: 0, stderr: "" }), async (observed) => {
    assert.equal(observed.first.terminal?.roleOutcome.role, "judge");
    assert.equal(observed.first.terminal?.roleOutcome.kind, "accepted");
    assert.equal(auditorCalls, 2);
    const auditorSessions = observed.officerSessions.filter((item) => item.role === "auditor");
    assert.equal(auditorSessions.length, 2);
    assert.equal(auditorSessions[0]?.sessionFile, auditorSessions[1]?.sessionFile);
    assert.equal(auditorSessions[1]?.continuation, "resume");
    assert.deepEqual(auditorSessions[1]?.activation, auditorSessions[0]?.activation);
    assert.deepEqual(observed.first.terminal?.roleOutcome.payloads?.at(-1), VERDICT);
  });
});

test("#1057 a parent Judge host failure does not settle the pending verdict", async () => {
  let auditorCalls = 0;
  await runJudge(async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") return officer("notary", { status: "converged", mark: 2 })(args, options);
    if (role === "auditor") {
      auditorCalls += 1;
      return officer("auditor", auditorCalls === 1
        ? { status: "escalate", mark: 4 }
        : { status: "converged", mark: 5 })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  }, () => ({ code: 1, stderr: "judge host failed" }), async (observed) => {
    const continued = await observed.resume(RULING);
    assert.notEqual(continued.exitCode, 0);
    assert.notEqual(continued.terminal?.roleOutcome.kind, "accepted");
    assert.equal(observed.judgeSubmissions.length, 1);
    const rows = await readRecordedSubmissionRows(observed.project, observed.parentRunId, observed.home);
    assert.equal(rows.some((row) => row.role === "judge" && row.kind === "accepted"), false);
  });
});

test("#1057 a new judge verdict after acceptance runs the audits again", async () => {
  const next = { status: "converged", mark: 9 } as const;
  let notaryCalls = 0;
  let auditorCalls = 0;
  await runJudge(async (args, options) => {
    const role = argvFlagValue(args, "--ak-role");
    if (role === "notary") {
      notaryCalls += 1;
      return officer("notary", { status: "converged", mark: notaryCalls })(args, options);
    }
    if (role === "auditor") {
      auditorCalls += 1;
      return officer("auditor", { status: "converged", mark: auditorCalls })(args, options);
    }
    throw new Error(`unexpected nested role: ${role ?? "(missing)"}`);
  }, () => ({ code: 0, stderr: "", verdict: next }), async (observed) => {
    const resumed = await observed.resumeRun(observed.parentRunId, "new review");
    assert.equal(resumed.exitCode, 0);
    assert.equal(notaryCalls, 2);
    assert.equal(auditorCalls, 2);
    assert.equal(resumed.terminal?.roleOutcome.role, "judge");
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.deepEqual(resumed.terminal?.roleOutcome.payloads?.at(-1), next);
  });
});
