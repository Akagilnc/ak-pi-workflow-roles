import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  commitFile,
  initGitRepo,
  makeTempDir,
  runRecorderBin,
  writeCounterScript,
  writeRecorderConfig,
} from "./helpers/recorder-test-harness.ts";

function setup() {
  const root = makeTempDir("ak-recorder-tx-");
  const archive = initGitRepo(join(root, "archive"));
  const authority = commitFile(archive, "authority.md", "# authority\n");
  const task = commitFile(archive, "task.md", "# task\n");
  const script = writeCounterScript(root);
  const counter = join(root, "counter.txt");
  return { root, archive, authority, task, script, counter };
}

function configFor(
  ctx: ReturnType<typeof setup>,
  docketId: string,
  patch: Record<string, unknown> = {},
): string {
  return writeRecorderConfig(ctx.root, {
    archiveRepo: ctx.archive,
    cwd: ctx.root,
    docketId,
    authority: {
      repositoryRoot: ctx.archive,
      commit: ctx.authority.commit,
      path: ctx.authority.path,
      blobOid: ctx.authority.blobOid,
      sha256: ctx.authority.sha256,
    },
    task: {
      repositoryRoot: ctx.archive,
      commit: ctx.task.commit,
      path: ctx.task.path,
      blobOid: ctx.task.blobOid,
      sha256: ctx.task.sha256,
    },
    ...patch,
  });
}

test("child nonzero exit is preserved after successful promotion", async () => {
  const ctx = setup();
  try {
    const configPath = configFor(ctx, "issues/10/apply/apply-exit-7");
    const result = await runRecorderBin(
      [
        "--config",
        configPath,
        "--",
        process.execPath,
        ctx.script,
        "exit",
        "7",
      ],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
      },
    );
    assert.equal(result.code, 7);
    assert.match(result.stdout, /exit-body/);
    const manifest = JSON.parse(
      readFileSync(
        join(ctx.archive, ".ak/dockets/issues/10/apply/apply-exit-7/manifest.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.recorder.status, "completed");
    assert.equal(manifest.child.exitCode, 7);
    assert.equal(manifest.receipt, null);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("child signal is preserved after successful promotion", async () => {
  const ctx = setup();
  try {
    const configPath = configFor(ctx, "issues/10/apply/apply-signal-term");
    const result = await runRecorderBin(
      [
        "--config",
        configPath,
        "--",
        process.execPath,
        ctx.script,
        "signal",
        "SIGTERM",
      ],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
      },
    );
    assert.equal(result.signal, "SIGTERM");
    const manifest = JSON.parse(
      readFileSync(
        join(
          ctx.archive,
          ".ak/dockets/issues/10/apply/apply-signal-term/manifest.json",
        ),
        "utf8",
      ),
    );
    assert.equal(manifest.recorder.status, "completed");
    assert.equal(manifest.child.status, "signaled");
    assert.equal(manifest.child.signal, "SIGTERM");
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("recorder failure after child success yields 125 and no final manifest", async () => {
  const ctx = setup();
  try {
    // Declaration admission is before spawn. Force a post-spawn Recorder failure by
    // having the successful child create the destination (promotion collision).
    const docketId = "issues/10/apply/apply-rec-fail";
    const configPath = configFor(ctx, docketId);
    const dest = join(ctx.archive, ".ak/dockets", docketId);
    const collide = join(ctx.root, "succeed-then-collide.mjs");
    writeFileSync(
      collide,
      `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
process.stdout.write("exit-body\\n");
mkdirSync(${JSON.stringify(dest)}, { recursive: true });
writeFileSync(join(${JSON.stringify(dest)}, "collision.txt"), "preexisting\\n");
process.exit(0);
`,
    );
    const beforeHead = execFileSync("git", ["-C", ctx.archive, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const result = await runRecorderBin(
      ["--config", configPath, "--", process.execPath, collide],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
      },
    );
    assert.equal(result.code, 125);
    // child ran and teed
    assert.match(result.stdout, /exit-body/);
    const failure = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    assert.equal(failure.recorder.status, "failed");
    assert.equal(failure.child.status, "exited");
    assert.equal(failure.child.exitCode, 0);
    assert.equal(existsSync(join(dest, "manifest.json")), false);
    const afterHead = execFileSync("git", ["-C", ctx.archive, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    assert.equal(afterHead, beforeHead);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("dual failure preserves scanned child diagnostic and recorder precedence", async () => {
  const ctx = setup();
  try {
    const docketId = "issues/10/apply/apply-dual-fail";
    const configPath = configFor(ctx, docketId);
    const dest = join(ctx.archive, ".ak/dockets", docketId);
    const stdoutBody =
      "child-failed-marker Authorization: Bearer plainsecrettokenvalue999\n";
    const stderrBody = "diag-line Basic dXNlcjpwYXNz\n";
    const collide = join(ctx.root, "fail-then-collide.mjs");
    writeFileSync(
      collide,
      `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
process.stdout.write(${JSON.stringify(stdoutBody)});
process.stderr.write(${JSON.stringify(stderrBody)});
mkdirSync(${JSON.stringify(dest)}, { recursive: true });
writeFileSync(join(${JSON.stringify(dest)}, "collision.txt"), "preexisting\\n");
process.exit(3);
`,
    );
    const result = await runRecorderBin(
      ["--config", configPath, "--", process.execPath, collide],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
      },
    );
    assert.equal(result.code, 125);
    // Byte-exact tee of child streams (credentials may appear on the tee).
    assert.equal(result.stdout, stdoutBody);
    assert.equal(result.stderr.startsWith(stderrBody), true);
    const failureLine = result.stderr.trim().split("\n").at(-1)!;
    const failure = JSON.parse(failureLine);
    assert.equal(failure.recorder.status, "failed");
    assert.equal(failure.child.status, "exited");
    assert.equal(failure.child.exitCode, 3);
    assert.equal(typeof failure.child.diagnostic, "string");
    assert.notEqual(failure.child.diagnostic, null);
    assert.equal(failure.child.diagnostic.includes("plainsecrettokenvalue999"), false);
    assert.equal(failure.child.diagnostic.includes("dXNlcjpwYXNz"), false);
    assert.equal(failure.child.diagnostic.includes("child-failed-marker"), true);
    assert.equal(failure.child.diagnostic.includes("[REDACTED]"), true);
    assert.equal(failureLine.includes("plainsecrettokenvalue999"), false);
    assert.equal(failureLine.includes("dXNlcjpwYXNz"), false);
    assert.equal(existsSync(join(dest, "manifest.json")), false);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("path traversal and symlink escape fail closed without promotion", async () => {
  const ctx = setup();
  try {
    const traversalConfig = configFor(ctx, "issues/10/apply/apply-trav");
    const cfg = JSON.parse(readFileSync(traversalConfig, "utf8"));
    cfg.archive.docketId = "issues/10/../../outside";
    writeFileSync(traversalConfig, JSON.stringify(cfg));
    const trav = await runRecorderBin(
      [
        "--config",
        traversalConfig,
        "--",
        process.execPath,
        ctx.script,
        "ok",
      ],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
      },
    );
    assert.equal(trav.code, 125);
    assert.equal(existsSync(ctx.counter), false);

    // symlink escape: root points outside via symlink segment
    const outside = makeTempDir("ak-recorder-outside-");
    const linkParent = join(ctx.archive, ".ak");
    // create symlink dockets -> outside
    rmSync(join(ctx.archive, ".ak"), { recursive: true, force: true });
    // ensure .ak exists as real dir then link child
    const akDir = join(ctx.archive, ".ak");
    // use symlink for dockets path
    const { mkdirSync } = await import("node:fs");
    mkdirSync(akDir, { recursive: true });
    symlinkSync(outside, join(akDir, "dockets"));
    const escapeConfig = configFor(ctx, "issues/10/apply/apply-symlink");
    const escape = await runRecorderBin(
      [
        "--config",
        escapeConfig,
        "--",
        process.execPath,
        ctx.script,
        "ok",
      ],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
      },
    );
    // Either rejected as escape or destination ends up checked via realpath.
    // Must not write an apparently complete docket inside the archive object identity
    // without symlink detection. If promotion followed the symlink, realpath of dest
    // is outside archive — assertPathNotSymlinkEscape should fail.
    assert.equal(escape.code, 125);
    rmSync(outside, { recursive: true, force: true });
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("config failure before spawn reports not-spawned", async () => {
  const ctx = setup();
  try {
    const result = await runRecorderBin(
      ["--config", join(ctx.root, "missing.json"), "--", process.execPath, ctx.script],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
      },
    );
    assert.equal(result.code, 125);
    const failure = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    assert.equal(failure.child.status, "not-spawned");
    assert.equal(existsSync(ctx.counter), false);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});
