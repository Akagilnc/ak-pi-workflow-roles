/**
 * #1057: 审核上呈停在上呈者本人 run，父席等待；公开 resume 不另附 subject
 * 也能交卷，父席经关联自动接续，不因通过再交同一判词。
 * Seam: public `ak-role judge` / `ak-role resume` with the production submission gate.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { RoleTurnHost, RoleTurnRequest } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/auditor-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { runAkRole, type NamedRoleTurnHostAdapter } from "../../src/public-cli/cli.ts";
import {
  savePublicCliConfig,
  setPersistentSeatConfig,
} from "../../src/public-cli/config.ts";
import {
  findRunDirectoryById,
  readRoleRunIdentity,
} from "../../src/public-cli/run-lifecycle.ts";
import { listBookRunDirectories } from "../../src/role-run-placement.ts";
import { readdir } from "node:fs/promises";
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

test("#1057 auditor escalation pauses the auditor and the waiting parent continues after bare resume", async () => {
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
    const officerHost = roleTurnHostFromLegacyPiRunner({
      packageRoot,
      principalAuthority: piDurablePrincipalAuthority,
      piRunner: officerRunner,
    });
    const officerAdapters = [adapter("pi", officerHost)];
    const judgeHost: RoleTurnHost = {
      async executeTurn(request: RoleTurnRequest) {
        const verdict = { status: "converged", note: "原判词" };
        judgeSubmissions.push(verdict);
        const coords = piDurablePrincipalAuthority.decode(request.principal);
        const socketDir = await mkdtemp(join(tmpdir(), "ak-1057-judge-"));
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
      },
    );

    assert.equal(escalated.exitCode, 0, capture.stderr.join("") || capture.stdout.join(""));
    const books = await readdir(join(home, ".ak-roles", "books"));
    const runs = (await Promise.all(books.map((book) => listBookRunDirectories(join(home, ".ak-roles", "books", book))))).flat();
    const identities = (await Promise.all(runs.map((runDirectory) => readRoleRunIdentity(runDirectory))))
      .filter((identity) => identity !== undefined);
    const parent = identities.find((identity) => identity.role === "judge");
    assert.ok(parent, `judge run missing: ${JSON.stringify(identities)}`);
    assert.notEqual(parent.state, "terminal");
    assert.notEqual(escalated.terminal?.runId, parent.runId);
    assert.equal(escalated.terminal?.roleOutcome.role, "auditor");
    assert.notEqual(escalated.terminal?.roleOutcome.kind, "audit_escalation");
    assert.equal(latestPayload(escalated.terminal)?.status, "escalate");
    assert.equal(latestPayload(escalated.terminal)?.explanation, "完整审刑院原话");
    assert.equal(judgeSubmissions.length, 1);

    const auditorRunId = escalated.terminal?.runId;
    assert.equal(typeof auditorRunId, "string");
    const resumeCapture = captureIo();
    const continued = await runAkRole(["resume", auditorRunId!], {
      packageRoot,
      home,
      cwd: project,
      io: resumeCapture.io,
      principalAuthority: piDurablePrincipalAuthority,
      hostAdapters: officerAdapters,
    });

    assert.equal(continued.exitCode, 0, resumeCapture.stderr.join("") || resumeCapture.stdout.join(""));
    assert.equal(auditorCalls, 2);
    assert.equal(judgeSubmissions.length, 1);
    const parentAfter = await readRoleRunIdentity(parent.runDirectory);
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
    const auditorDir = await findRunDirectoryById(home, auditorRunId!, parent.bookKey, "auditor");
    assert.equal(typeof auditorDir, "string");
  }, { prefix: "ak-1057-park-" });
});
