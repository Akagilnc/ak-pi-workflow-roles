import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const piCli = resolve(packageRoot, "node_modules/.bin/pi");

async function runCli(mode: "print" | "json") {
  const agentDir = await mkdtemp(resolve(tmpdir(), "ak-audit-cli-"));
  const args = [
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-themes",
    "--no-context-files",
    "--no-session",
    "-e",
    resolve(packageRoot, "extensions/role-runtime.ts"),
    "-e",
    resolve(packageRoot, "test/fixtures/audit-failure-provider.ts"),
    "--ak-role",
    "judge",
    "--provider",
    "ak-audit-failure",
    "--model",
    "faux-1",
    ...(mode === "print" ? ["-p", "Judge."] : ["--mode", "json", "Judge."]),
  ];

  try {
    return await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolveResult, reject) => {
        const child = spawn(piCli, args, {
          cwd: packageRoot,
          env: {
            ...process.env,
            PI_CODING_AGENT_DIR: agentDir,
            PI_OFFLINE: "1",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolveResult({ code, stdout, stderr }));
      },
    );
  } finally {
    await rm(agentDir, { recursive: true, force: true });
  }
}

test("fatal Judge audit infrastructure failure aborts print and JSON CLI actions", async () => {
  for (const mode of ["print", "json"] as const) {
    const result = await runCli(mode);
    assert.equal(result.code, 1, `${mode} exits nonzero`);
    assert.match(result.stderr, /Request was aborted|AUDIT_FAILURE_PROVIDER_CALLS/);
    assert.doesNotMatch(result.stdout, /Judge verdict accepted/);
    assert.doesNotMatch(result.stdout, /FORBIDDEN LATER SUCCESS PROSE/);
    if (mode === "json") {
      assert.match(
        result.stdout,
        /"toolName":"ak_judge_output".*"isError":true/,
      );
      assert.match(result.stdout, /"stopReason":"aborted"/);
    }
  }
});
