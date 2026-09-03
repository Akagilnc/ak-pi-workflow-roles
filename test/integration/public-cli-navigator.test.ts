/**
 * #639 public Navigator entry — direct instruction-seat face via real runAkRole.
 *
 * Navigator stops being an automatic-only configurable seat: it accepts
 * invocation requests (opaque instruction + attachments) and delivers a typed
 * terminal from its ak_navigator_output receipt (route advice), same law as
 * other roles. Automatic attendance stays untouched and is not asserted here.
 *
 * Oracles: typed TerminalResult / roleOutcome fields only (锚定宪法).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/navigator-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

const RUN_ID = "01a0navi00-0000-7000-8000-000000000639";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-navigator-"));
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
  execFileSync("git", ["config", "user.email", "navigator@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Navigator Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function scriptedNavigatorSession(details: unknown) {
  return scriptedTerminatingToolSession({
    role: "navigator",
    toolName: NAVIGATOR_OUTPUT_TOOL_NAME,
    details,
  });
}

test("ak-role navigator admits instruction and delivers typed route terminal", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);

    const { stdout } = captureIo();
    let dispatchArgs: string[] | undefined;
    const result = await runAkRole(
      ["navigator", "--project", project, "刚完成 coder apply 收敛，下一步？"],
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
            return scriptedNavigatorSession({
              status: "advice",
              candidates: [{ next: { role: "judge", phase: null }, reason: "converged work needs adjudication" }],
            })(args, options);
          },
        }),
      },
    );

    assert.equal(result.exitCode, 0, result.terminal === undefined ? "no terminal" : "");
    assert.equal(Array.isArray(dispatchArgs), true);
    assert.equal(dispatchArgs![dispatchArgs!.indexOf("--ak-role") + 1], "navigator");
    const coords = issuePiDurablePrincipalCoordinates({
      cwd: project,
      runId: RUN_ID,
      role: "navigator",
      home,
    });
    assert.equal(
      dispatchArgs![dispatchArgs!.indexOf("--session-dir") + 1],
      coords.sessionDirectory,
    );
    assert.equal(result.terminal?.roleOutcome.role, "navigator");
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.equal(
      result.terminal?.roleOutcome.kind === "accepted"
        ? result.terminal.roleOutcome.status
        : undefined,
      "advice",
    );
    const candidates = result.terminal?.roleOutcome.kind === "accepted"
      ? (result.terminal.roleOutcome.decisiveFacts as { candidates?: unknown }).candidates
      : undefined;
    assert.deepEqual(candidates, [
      { next: { role: "judge", phase: null }, reason: "converged work needs adjudication" },
    ]);
  });
});
