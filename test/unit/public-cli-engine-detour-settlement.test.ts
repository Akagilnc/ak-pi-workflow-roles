/**
 * #357 T2 — engine detour infrastructure failure extract + public Judge settlement.
 * Session fixture → extract → Terminal Error Artifact diagnostic (artifact reference 实读).
 * Mock only at piRunner (session write); settlement/artifact path is production.
 * Zero CLI invocation-text / material-prose assertions.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC } from "../../src/engine-detour.ts";
import { ENGINE_DETOUR_TOOL_NAME } from "../../src/role-runtime.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  extractEngineDetourInfrastructureFailure,
  readEngineDetourInfrastructureFailure,
} from "../../src/public-cli/settlement.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

async function withTempHome<T>(scenario: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "ak-engine-detour-settle-"));
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
  execFileSync("git", ["config", "user.email", "detour@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Detour Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

const credentials = { "openai-codex": true, xai: true } as const;

function detourFailureSessionEntries(diagnostic: string): unknown[] {
  return [
    { type: "session", id: "parent-session" },
    { type: "message", id: "current-user", message: { role: "user" } },
    {
      type: "message",
      id: "detour-call",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "detour-1",
            name: ENGINE_DETOUR_TOOL_NAME,
            arguments: { argv: ["kimi", "--yolo", "-p", "labor"] },
          },
        ],
      },
    },
    {
      type: "message",
      id: "detour-result",
      parentId: "detour-call",
      message: {
        role: "toolResult",
        toolCallId: "detour-1",
        toolName: ENGINE_DETOUR_TOOL_NAME,
        isError: true,
        content: [{ type: "text", text: diagnostic }],
        details: {
          kind: "role_infrastructure_failure",
          source: "shared-role-lifecycle",
          reasonCode: "host_failure",
        },
      },
    },
  ];
}

test("extractEngineDetourInfrastructureFailure reads latest errored detour toolResult", () => {
  const entries = detourFailureSessionEntries("engine-stderr-marker-A\n") as any;
  const failure = extractEngineDetourInfrastructureFailure(entries);
  assert.ok(failure);
  assert.equal(failure!.cause, "output");
  assert.equal(failure!.diagnostic, "engine-stderr-marker-A");
  assert.deepEqual(failure!.identity, { name: "EngineDetourInfrastructureError" });
});

test("extractEngineDetourInfrastructureFailure ignores non-detour tool errors", () => {
  const entries = [
    { type: "session", id: "s" },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "x",
        toolName: "ak_judge_output",
        isError: true,
        content: [{ type: "text", text: "not detour" }],
      },
    },
  ] as any;
  assert.equal(extractEngineDetourInfrastructureFailure(entries), undefined);
});

test("readEngineDetourInfrastructureFailure from session file", async () => {
  await withTempHome(async (home) => {
    const sessionFile = join(home, "session.jsonl");
    await writeFile(
      sessionFile,
      detourFailureSessionEntries("file-stderr-marker").map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
    const failure = await readEngineDetourInfrastructureFailure(sessionFile);
    assert.equal(failure?.diagnostic, "file-stderr-marker");
    assert.equal(failure?.cause, "output");
  });
});

test("public Judge settles engine detour nonzero failure via Error Artifact diagnostic", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const marker = "ENGINE_FAIL_A_UNIQUE_STDERR_357";
    const result = await runAkRole(
      [
        "--model",
        "xai/grok-4:off",
        "--engine",
        "kimi",
        "judge",
        "--project",
        project,
        "engine detour failure A",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials,
        createRunId: () => "run-engine-detour-fail-a-001",
        io,
        piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await writeFile(
            sessionFile,
            detourFailureSessionEntries(marker).map((e) => JSON.stringify(e)).join("\n") + "\n",
          );
          return {
            code: 1,
            stderr: "VARIABLE DECOY child stderr\n",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    assert.notEqual(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    if (result.terminal!.roleOutcome.kind !== "failure") return;
    assert.equal(result.terminal!.roleOutcome.cause, "output");
    assert.equal(result.terminal!.roleOutcome.diagnostic, marker);
    // No accepted typed Receipt on failure Terminal.
    assert.equal(
      (result.terminal!.roleOutcome as { acceptedReceipt?: unknown }).acceptedReceipt,
      undefined,
    );
    const errorRef = result.terminal!.artifacts.find((a) => a.kind === "error");
    assert.ok(errorRef, "failure Terminal must carry error artifact ref");
    const durable = JSON.parse(await readFile(errorRef!.path, "utf8")) as {
      diagnostic: string;
    };
    assert.equal(durable.diagnostic, marker);
    assert.equal(JSON.stringify(result.terminal).includes("VARIABLE DECOY"), false);
  });
});

test("public Judge settles engine detour empty-stdout failure on same path", async () => {
  await withTempHome(async (home) => {
    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { io } = captureIo();
    const result = await runAkRole(
      [
        "--model",
        "xai/grok-4:off",
        "--engine",
        "kimi",
        "judge",
        "--project",
        project,
        "engine detour failure B",
      ],
      {
        packageRoot,
        home,
        cwd: project,
        credentials,
        createRunId: () => "run-engine-detour-fail-b-001",
        io,
        piRunner: async (args) => {
          const sessionFile = args[args.indexOf("--session") + 1]!;
          await writeFile(
            sessionFile,
            detourFailureSessionEntries(ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC)
              .map((e) => JSON.stringify(e))
              .join("\n") + "\n",
          );
          return {
            code: 1,
            stderr: "",
            timedOut: false,
            args: [...args],
          };
        },
      },
    );

    assert.notEqual(result.exitCode, 0);
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    if (result.terminal!.roleOutcome.kind !== "failure") return;
    assert.equal(result.terminal!.roleOutcome.cause, "output");
    assert.equal(
      result.terminal!.roleOutcome.diagnostic,
      ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC,
    );
    const errorRef = result.terminal!.artifacts.find((a) => a.kind === "error");
    assert.ok(errorRef);
    const durable = JSON.parse(await readFile(errorRef!.path, "utf8")) as {
      diagnostic: string;
    };
    assert.equal(durable.diagnostic, ENGINE_DETOUR_EMPTY_STDOUT_DIAGNOSTIC);
  });
});
