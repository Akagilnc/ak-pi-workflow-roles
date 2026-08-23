// #420 整改：自 test/unit/public-cli-reviewer.test.ts 按性质移出（起真 Pi 子进程，
// 不属开发内环快档）。契约不变：激活拒绝经真实入口落 violation code 与诊断进卷宗。
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  captureIo,
  seedGitProject,
  withTempHome,
} from "../helpers/failure-settlement-kit.ts";
import { packageRoot, runPiSubprocess } from "../helpers/pi-test-harness.ts";

test("reviewer activation rejection lands violation code and diagnostic in books", async () => {
  // One true-seam tracer (ADR 0016 / host art. 13): public CLI → real Pi child
  // ExtensionRunner → typed knownFailure channel → presentControlledFailure → books error.json.
  // Prior art: test/package/reviewer-package-lifecycle.test.ts (runAkRole + runPiSubprocess).
  // Trigger: local-only repo + --base origin/main → production base-invalid preflight.
  const diagnostic =
    "base revision must name an existing pinned ref or reachable commit";
  // Kit 差异参数化：保留本家族的临时目录标签，其余夹具与 failure-settlement 同源。
  await withTempHome(
    async (home) => {
    const project = join(home, "work");
    const agentDir = join(home, ".pi-agent");
    await mkdir(project, { recursive: true });
    await mkdir(agentDir, { recursive: true });
    seedGitProject(project);

    const { io, stdout, stderr } = captureIo();
    const result = await runAkRole(
      ["reviewer", "--project", project, "--base", "origin/main"],
      {
        packageRoot,
        home,
        agentDir,
        cwd: project,
        credentials: { "openai-codex": true, xai: true },
        createRunId: () => "run-reviewer-reject-diagnostic",
        reviewerTimeoutMs: 60_000,
        io,
        piRunner: async (args, options) => {
          const subprocess = await runPiSubprocess([...args], {
            cwd: options.cwd,
            env: {
              ...options.env,
              PI_OFFLINE: "1",
            },
            timeoutMs: options.timeoutMs ?? 60_000,
          });
          return {
            code: subprocess.code,
            stderr: subprocess.stderr,
            timedOut: subprocess.localTimeout,
            args: [...args],
          };
        },
      },
    );

    assert.equal(
      result.exitCode,
      1,
      stderr.join("") || stdout.join("") || "expected activation rejection",
    );
    assert.ok(result.terminal);
    assert.equal(result.terminal.roleOutcome.kind, "failure");
    if (result.terminal.roleOutcome.kind !== "failure") {
      throw new Error("expected failure");
    }
    assert.equal(result.terminal.roleOutcome.cause, "activation");
    assert.match(
      result.terminal.roleOutcome.diagnostic,
      new RegExp(diagnostic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    const secondary = result.terminal.roleOutcome.decisiveFacts.secondaryEvidence as
      | { violations?: unknown }
      | undefined;
    assert.deepEqual(secondary?.violations, ["base-invalid"]);

    const errorRef = result.terminal.artifacts.find((a) => a.kind === "error");
    assert.ok(errorRef);
    const errorBody = JSON.parse(await readFile(errorRef!.path, "utf8")) as {
      cause: string;
      diagnostic: string;
      details?: { violations?: unknown };
    };
    assert.equal(errorBody.cause, "activation");
    assert.match(
      errorBody.diagnostic,
      new RegExp(diagnostic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.deepEqual(errorBody.details?.violations, ["base-invalid"]);
  },
  { prefix: "ak-public-cli-reviewer-" },
  );
});
