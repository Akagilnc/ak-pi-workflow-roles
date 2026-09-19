/**
 * #980 Codex project Skill catalog through the public ak-role entry.
 * Production headless host + prepareRoleEnvelope install seam; fake codex binary
 * only — no real LLM/network. External results: catalog path state and turn outcome.
 */
import assert from "node:assert/strict";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { runAkRole } from "../../src/public-cli/cli.ts";
import { packagedMethodsDir } from "../../src/host-native-method.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";
import { payloadStatusSequence } from "../helpers/terminal-payload.ts";

const credentials = { "openai-codex": true, xai: true } as const;

const productionEnv = (home: string) => ({
  packageRoot,
  home,
  credentials,
  io: captureIo().io,
});

async function writeFakeCodex(home: string, receipt: Record<string, unknown>): Promise<void> {
  const binDir = join(home, ".local", "bin");
  await mkdir(binDir, { recursive: true });
  const binary = join(binDir, "codex");
  const text = JSON.stringify(receipt);
  await writeFile(
    binary,
    `#!/usr/bin/env node
process.stdout.write([
  JSON.stringify({ type: "thread.started", thread_id: "thread-980" }),
  JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: ${JSON.stringify(text)} } }),
  JSON.stringify({ type: "turn.completed" }),
].join("\\n") + "\\n");
`,
    "utf8",
  );
  await chmod(binary, 0o755);
}

async function configureCoderCodex(home: string): Promise<void> {
  const env = productionEnv(home);
  await runAkRole(["config", "set-auto-resume-limit", "0"], env);
  await runAkRole(["config", "set", "coder", "openai-codex/gpt-5.6-sol:high"], env);
  await runAkRole(["config", "set-host", "coder", "codex"], env);
}

async function runCoderApply(home: string, project: string, runId: string) {
  return runAkRole(["coder", "--project", project, "#980 catalog probe"], {
    ...productionEnv(home),
    cwd: project,
    createRunId: () => runId,
  });
}

function skillsLink(project: string): string {
  return join(project, ".agents", "skills");
}

test("#980 public ak-role codex catalog: create once, keep byte-identical twin, reject foreign/partial/broken/non-symlink", async () => {
  await withTempRoot("ak-980-catalog-", async (root) => {
    const home = join(root, "home");
    const project = join(root, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    await writeFakeCodex(home, { status: "planned", report: "Plan only; no edits." });
    await configureCoderCodex(home);

    const packagedReal = await realpath(packagedMethodsDir(packageRoot));
    const link = skillsLink(project);

    // Missing → create permanent link to packaged methods; second call is a no-op.
    {
      const first = await runCoderApply(home, project, "run-980-create");
      assert.equal(first.hostFailure, undefined, JSON.stringify(first.hostFailure));
      assert.equal(first.terminal?.roleOutcome?.kind, "accepted", JSON.stringify(first.terminal));
      assert.deepEqual(
        first.terminal?.roleOutcome === undefined
          ? []
          : payloadStatusSequence(first.terminal.roleOutcome),
        ["planned"],
      );
      assert.equal(await realpath(link), packagedReal);
      const created = await readlink(link);
      const second = await runCoderApply(home, project, "run-980-create-again");
      assert.equal(second.terminal?.roleOutcome?.kind, "accepted");
      assert.equal(await readlink(link), created);
      assert.equal(await realpath(link), packagedReal);
    }

    // Existing catalog at a different path with identical packaged method bytes stays put
    // (this-repo worktree shape: .agents/skills -> ../resources/methods).
    {
      const twin = join(root, "twin-methods");
      await cp(packagedReal, twin, { recursive: true });
      await rm(link, { force: true });
      await symlink(twin, link);
      const before = await readlink(link);
      const result = await runCoderApply(home, project, "run-980-twin");
      assert.equal(result.terminal?.roleOutcome?.kind, "accepted", JSON.stringify(result.terminal));
      assert.equal(await readlink(link), before);
      assert.equal(await realpath(link), await realpath(twin));
    }

    // Same names, foreign SKILL.md bytes → true conflict; entry left untouched.
    {
      const foreign = join(root, "foreign-methods");
      await cp(packagedReal, foreign, { recursive: true });
      await writeFile(join(foreign, "tdd", "SKILL.md"), "# foreign tdd\n", "utf8");
      await rm(link, { force: true });
      await symlink(foreign, link);
      const before = await readlink(link);
      const result = await runCoderApply(home, project, "run-980-foreign");
      assert.notEqual(result.exitCode, 0);
      assert.notEqual(result.terminal?.roleOutcome?.kind, "accepted");
      assert.equal(await readlink(link), before);
      assert.equal(await realpath(link).catch(() => ""), await realpath(foreign));
    }

    // Non-symlink entry is a true conflict and is left untouched.
    {
      await rm(link, { force: true });
      await mkdir(link, { recursive: true });
      const result = await runCoderApply(home, project, "run-980-dir");
      assert.notEqual(result.exitCode, 0);
      assert.equal((await lstat(link)).isDirectory(), true);
    }

    // Partial catalog (missing a packaged skill) is a true conflict and stays put.
    {
      const partial = join(root, "partial-methods");
      await mkdir(partial, { recursive: true });
      await cp(join(packagedReal, "tdd"), join(partial, "tdd"), { recursive: true });
      await rm(link, { recursive: true, force: true });
      await symlink(partial, link);
      const before = await readlink(link);
      const result = await runCoderApply(home, project, "run-980-partial");
      assert.notEqual(result.exitCode, 0);
      assert.equal(await readlink(link), before);
    }

    // Broken symlink is a true conflict and stays put.
    {
      await rm(link, { force: true });
      await symlink(join(root, "missing-methods"), link);
      const before = await readlink(link);
      const result = await runCoderApply(home, project, "run-980-broken");
      assert.notEqual(result.exitCode, 0);
      assert.equal(await readlink(link), before);
      await assert.rejects(() => realpath(link), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    }

    // Evidence: success path still records packaged method provenance (external artifact).
    {
      await rm(link, { force: true });
      const result = await runCoderApply(home, project, "run-980-provenance");
      assert.equal(result.terminal?.roleOutcome?.kind, "accepted");
      const evidenceRef = result.terminal?.artifacts?.find((a) => a.kind === "evidence");
      assert.ok(evidenceRef);
      const evidence = JSON.parse(await readFile(evidenceRef.path, "utf8")) as {
        methodProvenance?: { name?: string; kind?: string };
      };
      assert.equal(evidence.methodProvenance?.name, "tdd");
      assert.equal(evidence.methodProvenance?.kind, "role-method-skill");
      assert.equal(await realpath(link), packagedReal);
    }
  });
});
