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
  readonly parentRunDirectory: string;
  readonly parentPrompts: readonly string[];
  readonly officerPrompts: readonly string[];
  resume(message?: string): Promise<CliResult>;
};

async function runJudge(
  officerRunner: LegacyFauxPiRunner,
  onParentResume: (prompt: string) => { code: number; stderr: string },
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
      const parentPrompts: string[] = [];
      const officerPrompts: string[] = [];
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
      const submitVerdict = async (request: RoleTurnRequest) => {
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
          await prepared.ingestStructuredOutput(VERDICT);
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
            parentPrompts.push(request.continuation.prompt);
            const resumed = onParentResume(request.continuation.prompt);
            return { code: resumed.code, stderr: resumed.stderr, timedOut: false };
          }
          return submitVerdict(request);
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
        parentRunDirectory: parent.runDirectory,
        parentPrompts,
        officerPrompts,
        async resume(message?: string) {
          const officerRunId = first.terminal?.runId;
          assert.equal(typeof officerRunId, "string");
          const args = message === undefined ? ["resume", officerRunId!] : ["resume", officerRunId!, message];
          return runAkRole(args, {
            packageRoot,
            home,
            cwd: project,
            io: captureIo().io,
            principalAuthority: piDurablePrincipalAuthority,
            hostAdapters: [adapter("pi", routed)],
          });
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
  }, () => ({ code: 0, stderr: "" }), async (observed) => {
    assert.equal(observed.first.terminal?.roleOutcome.role, "notary");
    assert.notEqual((await readRoleRunIdentity(observed.parentRunDirectory))?.state, "terminal");
    const continued = await observed.resume(RULING);
    assert.equal(continued.exitCode, 0);
    assert.equal(observed.officerPrompts[0], RULING);
    assert.equal(notaryCalls, 2);
    assert.equal(auditorCalls, 0);
    assert.equal(observed.parentPrompts.length, 1);
    assert.equal(observed.parentPrompts[0], readableGateItem(passed));
    assert.notEqual(continued.terminal?.roleOutcome.kind, "audit_escalation");
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
  }, () => ({ code: 0, stderr: "" }), async (observed) => {
    assert.equal(observed.first.terminal?.roleOutcome.role, "auditor");
    assert.notEqual(observed.first.terminal?.runId, undefined);
    assert.notEqual((await readRoleRunIdentity(observed.parentRunDirectory))?.state, "terminal");
    const continued = await observed.resume(RULING);
    assert.equal(continued.exitCode, 0);
    assert.equal(observed.officerPrompts[0], RULING);
    assert.equal(auditorCalls, 2);
    assert.equal(observed.parentPrompts[0], readableGateItem(passed));
    assert.notEqual(continued.terminal?.roleOutcome.kind, "audit_escalation");
  });
});
