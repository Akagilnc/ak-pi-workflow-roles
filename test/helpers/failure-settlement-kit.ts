/**
 * Shared fixtures for the failure-settlement test family (#420 整改拆分).
 * Extracted verbatim from public-cli-failure-settlement.test.ts — no behavior change.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { withTempRoot } from "./primary-aware-cleanup.ts";
import { join } from "node:path";

import {
  CONCISE_DIAGNOSTIC_MAX_CHARS,
  exitCodeForTerminalOutcome,
  isLawfulTypedTerminalOutcome,
} from "../../src/public-cli/settlement.ts";
import type {
  ControlledFailureCause,
  TerminalArtifactRef,
  TerminalResult,
} from "../../src/public-cli/terminal.ts";

export async function withTempHome<T>(
  scenario: (home: string) => Promise<T>,
  options: { prefix?: string } = {},
): Promise<T> {
  return withTempRoot(options.prefix ?? "ak-public-cli-fail-", scenario);
}

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
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
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
  expectedCause: ControlledFailureCause;
  diagnosticIncludes?: string;
  diagnosticEquals?: string;
  identityName?: string;
  identityCode?: string | number;
}): Promise<{ terminal: TerminalResult; errorRef: TerminalArtifactRef }> {
  assert.equal(input.result.exitCode, 1);
  assert.equal(input.stdout.length, 1, "exactly one stdout Terminal emission");
  assert.equal(input.stderr.length, 1, "exactly one stderr diagnostic emission");
  assert.ok((input.stdout[0] ?? "").length > 0);
  assert.equal(
    input.stderr[0]!.split("\n").filter((line) => line.trim() !== "").length,
    1,
    "stderr diagnostic must be one concise line",
  );

  const terminal = input.result.terminal;
  assert.ok(terminal, "public seam must return settled Terminal");
  assert.equal(terminal.roleOutcome.kind, "failure");
  if (terminal.roleOutcome.kind !== "failure") {
    throw new Error("expected failure role outcome");
  }
  assert.equal(terminal.roleOutcome.cause, input.expectedCause);
  assert.equal(typeof terminal.roleOutcome.diagnostic, "string");
  assert.ok(terminal.roleOutcome.diagnostic.length > 0);
  if (input.diagnosticEquals !== undefined) {
    assert.equal(terminal.roleOutcome.diagnostic, input.diagnosticEquals);
  }
  if (input.diagnosticIncludes !== undefined) {
    assert.equal(
      terminal.roleOutcome.diagnostic.includes(input.diagnosticIncludes),
      true,
    );
  }
  assert.equal(isLawfulTypedTerminalOutcome(terminal.roleOutcome), false);
  assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 1);
  assert.ok(terminal.navigator);
  assert.equal(terminal.resume, undefined);
  assert.equal(typeof terminal.runId, "string");
  assert.ok(terminal.runId !== undefined && terminal.runId.length > 0);
  assert.ok(Array.isArray(terminal.artifacts));
  assert.ok(terminal.artifacts.length >= 1);

  // Durability via typed artifact refs — never private layout/filenames.
  const errorRef = terminal.artifacts.find((a) => a.kind === "error");
  assert.ok(errorRef, "failure Terminal must carry error artifact ref");
  const errorBody = JSON.parse(await readFile(errorRef!.path, "utf8")) as {
    kind: string;
    cause: string;
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
  assert.equal("judgeStatus" in errorBody, false);

  const evidenceRef = terminal.artifacts.find((a) => a.kind === "evidence");
  assert.ok(evidenceRef, "failure Terminal must carry evidence artifact ref");
  await access(evidenceRef!.path);

  // Presentation is bounded even when durable diagnostic is longer.
  const presented = input.stderr[0]!;
  assert.ok(presented.length <= CONCISE_DIAGNOSTIC_MAX_CHARS + 32);

  return { terminal, errorRef: errorRef! };
}
