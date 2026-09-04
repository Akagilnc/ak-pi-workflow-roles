/**
 * #639 public Gatekeeper entry — direct instruction-seat face via real runAkRole.
 *
 * Gatekeeper stops being an automatic-only configurable seat: it accepts
 * invocation requests (opaque instruction + attachments) and delivers a typed
 * terminal from its own ak_gatekeeper_output receipt, same law as other roles.
 *
 * Oracles: typed TerminalResult / roleOutcome fields only; activation role on
 * the dispatch seam. No help prose or TSV layout assertions (锚定宪法).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { GATEKEEPER_OUTPUT_TOOL_NAME as GATEKEEPER_OUTPUT_TOOL } from "../../src/package-contracts/gatekeeper-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const RUN_ID = "01a0gate00-0000-7000-8000-000000000639";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-gatekeeper-"));
  try {
    return await scenario(home);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
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

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "gatekeeper@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Gatekeeper Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function scriptedGatekeeperSession(details: unknown, options: { isError?: boolean; seal?: boolean } = {}) {
  return scriptedTerminatingToolSession({
    role: "gatekeeper",
    toolName: GATEKEEPER_OUTPUT_TOOL,
    details,
    isError: options.isError === true,
    ...(options.seal === undefined ? {} : { seal: options.seal }),
  });
}

test("ak-role gatekeeper admits instruction and delivers typed pass terminal", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const { stdout } = captureIo();
    let dispatchArgs: string[] | undefined;
    const result = await runAkRole(
      ["gatekeeper", "--project", project, "审：这批材料该谁审？"],
      {
        home,
        packageRoot,
        cwd: project,
        io: captureIo().io,
        createRunId: () => RUN_ID,
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args, options) => {
            dispatchArgs = [...args];
            return scriptedGatekeeperSession({
              status: "pass",
              findings: ["only province-level concern"],
            })(args, options);
          },
        }),
      },
    );

    assert.equal(result.exitCode, 0, (result.terminal === undefined ? "no terminal" : ""));
    assert.equal(Array.isArray(dispatchArgs), true);
    // Direct entry dispatches a gatekeeper session — a role, not a hidden seat.
    assert.equal(dispatchArgs![dispatchArgs!.indexOf("--ak-role") + 1], "gatekeeper");
    const coords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId: RUN_ID,
      role: "gatekeeper",
      home,
    });
    assert.equal(
      dispatchArgs![dispatchArgs!.indexOf("--session-dir") + 1],
      coords.sessionDirectory,
    );
    assert.equal(result.terminal?.roleOutcome.role, "gatekeeper");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      result.terminal?.roleOutcome.kind === "accepted"
        ? result.terminal.roleOutcome.status
        : undefined,
      "pass",
    );
    assert.equal(
      result.terminal?.roleOutcome.kind === "accepted"
        ? result.terminal.roleOutcome.decisiveFacts.status
        : undefined,
      "pass",
    );
  });
});
