import { testTmpdir } from "../helpers/worktree-temp.ts";
/**
 * #639 public instruction-seat entries — Gatekeeper + Navigator via real runAkRole.
 *
 * Both stop being automatic-only configurable seats: each accepts an invocation
 * request (opaque instruction + attachments) and delivers a typed terminal from
 * its own terminating receipt, same law as other roles. Automatic attendance is
 * untouched and not asserted here.
 *
 * One shared harness, table-driven per role; role-specific typed receipt oracles
 * stay on each row. Oracles: typed TerminalResult / roleOutcome fields only;
 * activation role on the dispatch seam. No help prose or TSV layout assertions
 * (锚定宪法).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { issuePiDurablePrincipalCoordinates } from "../../src/pi/durable-principal.ts";
import { GATEKEEPER_OUTPUT_TOOL_NAME as GATEKEEPER_OUTPUT_TOOL } from "../../src/package-contracts/gatekeeper-output.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "../../src/package-contracts/navigator-output.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

type InstructionSeatCase = {
  readonly role: "gatekeeper" | "navigator";
  readonly runId: string;
  readonly instruction: string;
  readonly toolName: string;
  readonly details: unknown;
  readonly expectedStatus: string;
  readonly assertDecisiveFacts: (facts: unknown) => void;
};

const CASES: readonly InstructionSeatCase[] = [
  {
    role: "gatekeeper",
    runId: "01a0gate00-0000-7000-8000-000000000639",
    instruction: "审：这批材料该谁审？",
    toolName: GATEKEEPER_OUTPUT_TOOL,
    details: {
      status: "pass",
      findings: ["only province-level concern"],
    },
    expectedStatus: "pass",
    assertDecisiveFacts: (facts) => {
      assert.equal(
        facts !== null && typeof facts === "object" && "status" in facts
          ? (facts as { status: unknown }).status
          : undefined,
        "pass",
      );
    },
  },
  {
    role: "gatekeeper",
    runId: "01a0gate00-0000-7000-8000-00000000063a",
    instruction: "审：将作监完成侧交卷该派谁？",
    toolName: GATEKEEPER_OUTPUT_TOOL,
    details: {
      status: "dispatch",
      officer: "inspector",
      reason: "worker completion → inspector",
      findings: [],
    },
    expectedStatus: "dispatch",
    assertDecisiveFacts: (facts) => {
      assert.equal(
        facts !== null && typeof facts === "object" && "status" in facts
          ? (facts as { status: unknown }).status
          : undefined,
        "dispatch",
      );
      assert.equal(
        facts !== null && typeof facts === "object" && "officer" in facts
          ? (facts as { officer: unknown }).officer
          : undefined,
        "inspector",
      );
    },
  },
  {
    role: "navigator",
    runId: "01a0navi00-0000-7000-8000-000000000639",
    instruction: "刚完成 coder apply 收敛，下一步？",
    toolName: NAVIGATOR_OUTPUT_TOOL_NAME,
    details: {
      status: "advice",
      candidates: [
        {
          next: { role: "judge", phase: null },
          reason: "converged work needs adjudication",
        },
      ],
    },
    expectedStatus: "advice",
    assertDecisiveFacts: (facts) => {
      const candidates =
        facts !== null && typeof facts === "object" && "candidates" in facts
          ? (facts as { candidates?: unknown }).candidates
          : undefined;
      assert.deepEqual(candidates, [
        {
          next: { role: "judge", phase: null },
          reason: "converged work needs adjudication",
        },
      ]);
    },
  },
];

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(testTmpdir(), "ak-public-cli-instruction-seat-"));
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
  execFileSync("git", ["config", "user.email", "instruction-seat@test.local"], {
    cwd: root,
  });
  execFileSync("git", ["config", "user.name", "Instruction Seat Test"], {
    cwd: root,
  });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

for (const scenario of CASES) {
  test(`ak-role ${scenario.role} admits instruction and delivers typed terminal`, async () => {
    await withTempHome(async (home) => {
      const project = join(home, "project");
      await mkdir(project, { recursive: true });
      seedGitProject(project);

      const { io } = captureIo();
      let dispatchArgs: string[] | undefined;
      const result = await runAkRole(
        [scenario.role, "--project", project, scenario.instruction],
        {
          home,
          packageRoot,
          cwd: project,
          io,
          createRunId: () => scenario.runId,
          roleTurnHost: roleTurnHostFromLegacyPiRunner({
            packageRoot,
            principalAuthority: piDurablePrincipalAuthority,
            piRunner: async (args, options) => {
              dispatchArgs = [...args];
              return scriptedTerminatingToolSession({
                role: scenario.role,
                toolName: scenario.toolName,
                details: scenario.details,
              })(args, options);
            },
          }),
        },
      );

      assert.equal(
        result.exitCode,
        0,
        result.terminal === undefined ? "no terminal" : "",
      );
      assert.equal(Array.isArray(dispatchArgs), true);
      assert.equal(
        dispatchArgs![dispatchArgs!.indexOf("--ak-role") + 1],
        scenario.role,
      );
      const coords = issuePiDurablePrincipalCoordinates({
        cwd: project,
        runId: scenario.runId,
        role: scenario.role,
        home,
      });
      assert.equal(
        dispatchArgs![dispatchArgs!.indexOf("--session-dir") + 1],
        coords.sessionDirectory,
      );
      assert.equal(result.terminal?.roleOutcome.role, scenario.role);
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.equal(
        result.terminal?.roleOutcome.kind === "accepted"
          ? result.terminal.roleOutcome.status
          : undefined,
        scenario.expectedStatus,
      );
      scenario.assertDecisiveFacts(
        result.terminal?.roleOutcome.kind === "accepted"
          ? result.terminal.roleOutcome.decisiveFacts
          : undefined,
      );
    });
  });
}
