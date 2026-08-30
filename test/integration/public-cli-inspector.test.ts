import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { INSPECTOR_OUTPUT_TOOL_NAME } from "../../src/inspector-contracts.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";

function seedGitProject(root: string): void {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "inspector@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Inspector Test"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index < 0 ? undefined : args[index + 1];
}

function scriptedInspectorSession(receipt: { status: "pass" | "bounce"; findings: string[] }) {
  return async (extraArgs: readonly string[]) => {
    const sessionFile = flagValue(extraArgs, "--session");
    assert.ok(sessionFile);
    await mkdir(join(sessionFile, ".."), { recursive: true });
    const toolCallId = "call_inspector_1";
    const rows = [
      { type: "message", id: "user-1", parentId: null, message: { role: "user", content: "kickoff", timestamp: 1 } },
      { type: "message", id: "assistant-1", parentId: "user-1", message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: INSPECTOR_OUTPUT_TOOL_NAME, arguments: receipt }], timestamp: 2 } },
      { type: "message", id: "result-1", parentId: "assistant-1", message: { role: "toolResult", toolCallId, toolName: INSPECTOR_OUTPUT_TOOL_NAME, content: [{ type: "text", text: "accepted" }], details: receipt, isError: false, timestamp: 3 } },
    ];
    await writeFile(sessionFile, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`, "utf8");
    return { code: 0, timedOut: false, stderr: "", args: [...extraArgs] };
  };
}

test("ak-role inspector admits standard materials and projects pass or bounce to Terminal", async () => {
  const home = await mkdtemp(join(tmpdir(), "ak-public-cli-inspector-"));
  try {
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const attachment = join(project, "change.patch");
    await writeFile(attachment, "diff evidence", "utf8");

    for (const receipt of [
      { status: "pass" as const, findings: [] },
      { status: "bounce" as const, findings: ["test does not reach the public seam"] },
    ]) {
      const result = await runAkRole(
        ["inspector", "--project", project, "--attach", attachment, "Review complexity and test quality."],
        {
          home,
          packageRoot,
          cwd: project,
          io: { stdout() {}, stderr() {} },
          piRunner: scriptedInspectorSession(receipt),
        },
      );

      assert.equal(result.exitCode, 0);
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.equal(result.terminal?.roleOutcome.role, "inspector");
      if (result.terminal?.roleOutcome.kind !== "accepted") assert.fail("expected accepted Inspector receipt");
      assert.equal(result.terminal.roleOutcome.status, receipt.status);
      assert.deepEqual(result.terminal.roleOutcome.decisiveFacts.findings, receipt.findings);
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
