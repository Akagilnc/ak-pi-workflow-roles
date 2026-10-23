/**
 * Shared fixtures for the failure-settlement test family (#420 整改拆分).
 * Extracted verbatim from public-cli-failure-settlement.test.ts — no behavior change.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { terminalBodyAt } from "./run-dossier-fixture.ts";
import { seedGitRepository } from "./environment-fixtures.ts";

import type {
  ControlledFailureCause,
  TerminalArtifactRef,
  TerminalResult,
} from "../../src/public-cli/terminal.ts";

export function captureIo() {
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

export function seedGitProject(root: string): void {
  seedGitRepository(root);
  execFileSync("git", ["config", "user.email", "fail@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Fail Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

export function multiTurnIntermediateRetained(runId: string): readonly unknown[] {
  return [
    {
      type: "custom",
      customType: "ak_compliance_response",
      data: {
        version: 1,
        response: {
          content: [
            { type: "toolCall", name: "ak_get_run_dossier", arguments: { runId } },
            { type: "text", text: "dossier" },
          ],
        },
      },
    },
    {
      type: "custom",
      customType: "ak_compliance_response",
      data: {
        version: 1,
        response: {
          content: [
            { type: "toolCall", name: "read", arguments: { path: "CONTEXT.md" } },
            { type: "toolCall", name: "bash", arguments: { command: "git status" } },
          ],
        },
      },
    },
  ] as const;
}

export async function assertPublicFailureSettlement(input: {
  result: { exitCode: number; terminal?: TerminalResult };
  stdout: string[];
  stderr: string[];
  /** Typed cause when confirmed; omit / pass undefined when no typed class (#881). */
  expectedCause?: ControlledFailureCause;
  diagnosticIncludes?: string;
  diagnosticEquals?: string;
  identityName?: string;
  identityCode?: string | number;
}): Promise<{ terminal: TerminalResult; errorRef: TerminalArtifactRef }> {
  assert.equal(input.result.exitCode, 1, JSON.stringify({ stdout: input.stdout, stderr: input.stderr }));

  const terminal = input.result.terminal;
  assert.ok(terminal, "public seam must return settled Terminal");
  assert.equal(terminal.roleOutcome.kind, "failure");
  // Delivery, not chunking or wording: the caller was handed output on both streams.
  assert.ok(input.stdout.join("").length > 0, "failure Terminal delivered on stdout");
  assert.ok(input.stderr.join("").length > 0, "failure diagnostic delivered on stderr");
  if (terminal.roleOutcome.kind !== "failure") {
    throw new Error("expected failure role outcome");
  }
  assert.equal(terminal.roleOutcome.cause, input.expectedCause);
  if (input.diagnosticEquals !== undefined) {
    assert.equal(terminal.roleOutcome.diagnostic, input.diagnosticEquals);
  }
  if (input.diagnosticIncludes !== undefined) {
    assert.equal(
      terminal.roleOutcome.diagnostic.includes(input.diagnosticIncludes),
      true,
    );
  }

  // Durability via the typed artifact ref: it names the run's current.json, whose
  // terminal section is the failure the caller was handed.
  const errorRef = terminal.artifacts.find((a) => a.kind === "error");
  const errorBody = terminalBodyAt(errorRef!.path, "error") as {
    kind: string;
    cause?: string;
    diagnostic: string;
    identity?: { name?: string; code?: string | number };
  };
  assert.equal(errorBody.kind, "error");
  assert.equal(errorBody.cause, input.expectedCause);
  assert.equal(errorBody.diagnostic, terminal.roleOutcome.diagnostic);
  if (input.identityName !== undefined) {
    assert.equal(errorBody.identity?.name, input.identityName);
  }
  if (input.identityCode !== undefined) {
    assert.equal(errorBody.identity?.code, input.identityCode);
  }

  return { terminal, errorRef: errorRef! };
}
