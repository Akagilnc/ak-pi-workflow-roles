import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  canFreezeFileAgainstUnlink,
  commitFile,
  initGitRepo,
  makeTempDir,
  runRecorderBin,
  sabotageRawScratchCleanup,
  sha256File,
  spawnRecorderBin,
  writeCounterScript,
  writeRecorderConfig,
} from "./helpers/recorder-test-harness.ts";
import { packageRoot } from "./helpers/pi-test-harness.ts";

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


function killProcessTree(pid: number | undefined): void {
  if (pid === undefined || pid <= 0) return;
  try {
    const out = execFileSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
    }).trim();
    for (const line of out.split("\n")) {
      const childPid = Number(line.trim());
      if (Number.isFinite(childPid) && childPid > 0) {
        killProcessTree(childPid);
      }
    }
  } catch {
    // no children
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // already dead
  }
}

function leftoverStageDirs(archive: string): string[] {
  const work = join(archive, ".ak/work");
  if (!existsSync(work)) return [];
  return readdirSync(work).filter((name) => name.startsWith("recorder-stage-"));
}

/** Observe final docket identity: absent, complete core, or partial/other. */
function observeFinalDocket(dest: string): "absent" | "complete" | "partial" {
  let st;
  try {
    st = lstatSync(dest);
  } catch (error) {
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof (error as { code: unknown }).code === "string"
        ? (error as { code: string }).code
        : null;
    if (code === "ENOENT") return "absent";
    return "partial";
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return "partial";
  const manifestPath = join(dest, "manifest.json");
  if (!existsSync(manifestPath)) return "partial";
  let manifest: {
    artifacts?: Array<{ stored?: { path?: string } | null }>;
  };
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      artifacts?: Array<{ stored?: { path?: string } | null }>;
    };
  } catch {
    return "partial";
  }
  for (const artifact of manifest.artifacts ?? []) {
    const rel = artifact.stored?.path;
    if (typeof rel === "string" && rel.length > 0) {
      if (!existsSync(join(dest, rel))) return "partial";
    }
  }
  return "complete";
}

function multiExhibitConfig(
  ctx: ReturnType<typeof setup>,
  docketId: string,
  count: number,
): { configPath: string; exhibitIds: string[] } {
  const exhibitsDir = join(ctx.root, "exhibits");
  mkdirSync(exhibitsDir, { recursive: true });
  const exhibits: Array<{ id: string; sourcePath: string; sha256: string }> = [];
  const exhibitIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = `ex-${String(i).padStart(3, "0")}`;
    const sourcePath = join(exhibitsDir, `${id}.bin`);
    // Distinct multi-kilobyte payloads widen non-atomic entry-move windows.
    const body = Buffer.alloc(8192 + i, i % 251);
    writeFileSync(sourcePath, body);
    exhibits.push({ id, sourcePath, sha256: sha256File(body) });
    exhibitIds.push(id);
  }
  const configPath = configFor(ctx, docketId, { exhibits });
  return { configPath, exhibitIds };
}

test("inherited stdin is delivered byte-for-byte to the child", async () => {
  const ctx = setup();
  try {
    const configPath = configFor(ctx, "issues/10/apply/apply-stdin");
    const payload = Buffer.from([0x00, 0x61, 0xff, 0x0a, 0x62]);
    const result = await runRecorderBin(
      [
        "--config",
        configPath,
        "--",
        process.execPath,
        ctx.script,
        "stdin-echo",
      ],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
        input: payload,
      },
    );
    assert.equal(result.code, 0);
    assert.deepEqual(result.stdoutBuf, payload);
    assert.equal(leftoverStageDirs(ctx.archive).length, 0);
    const manifest = JSON.parse(
      readFileSync(
        join(ctx.archive, ".ak/dockets/issues/10/apply/apply-stdin/manifest.json"),
        "utf8",
      ),
    );
    assert.equal(manifest.recorder.status, "completed");
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("large binary stdout and stderr are teed independently and exactly", async () => {
  const ctx = setup();
  try {
    const configPath = configFor(ctx, "issues/10/apply/apply-binary-tee");
    const outLen = 256 * 1024 + 17;
    const errLen = 128 * 1024 + 3;
    const stdoutPayload = Buffer.alloc(outLen);
    const stderrPayload = Buffer.alloc(errLen);
    for (let i = 0; i < outLen; i++) stdoutPayload[i] = i % 256;
    for (let i = 0; i < errLen; i++) stderrPayload[i] = 255 - (i % 256);
    const result = await runRecorderBin(
      [
        "--config",
        configPath,
        "--",
        process.execPath,
        ctx.script,
        "binary-tee",
        String(outLen),
        String(errLen),
      ],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
      },
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdoutBuf.length, outLen);
    assert.equal(result.stderrBuf.length, errLen);
    assert.deepEqual(result.stdoutBuf, stdoutPayload);
    assert.deepEqual(result.stderrBuf, stderrPayload);
    assert.equal(leftoverStageDirs(ctx.archive).length, 0);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("child-created destination symlink is not followed or overwritten", async () => {
  const ctx = setup();
  try {
    const docketId = "issues/10/apply/apply-dest-symlink";
    const configPath = configFor(ctx, docketId);
    const dest = join(ctx.archive, ".ak/dockets", docketId);
    const outside = join(ctx.root, "outside-target");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "keep.txt"), "precious\n");
    const collide = join(ctx.root, "symlink-dest.mjs");
    writeFileSync(
      collide,
      `import { mkdirSync, symlinkSync } from "node:fs";
import { dirname } from "node:path";
mkdirSync(dirname(${JSON.stringify(dest)}), { recursive: true });
symlinkSync(${JSON.stringify(outside)}, ${JSON.stringify(dest)});
process.stdout.write("symlink-ready\\n");
process.exit(0);
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
    assert.match(result.stdout, /symlink-ready/);
    const failure = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    assert.equal(failure.recorder.status, "failed");
    // Symlink at destination is rejected without follow/overwrite (occupied or escape).
    assert.ok(
      failure.recorder.code === "destination-exists" ||
        failure.recorder.code === "invalid-path",
      failure.recorder.code,
    );
    assert.equal(existsSync(join(dest, "manifest.json")), false);
    assert.equal(existsSync(join(outside, "manifest.json")), false);
    assert.equal(readFileSync(join(outside, "keep.txt"), "utf8"), "precious\n");
    assert.equal(leftoverStageDirs(ctx.archive).length, 0);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("non-ignored archive work area fails closed before spawn", async () => {
  const ctx = setup();
  try {
    // Remove the harness gitignore so .ak/work is tracked/non-ignored.
    rmSync(join(ctx.archive, ".gitignore"), { force: true });
    const configPath = configFor(ctx, "issues/10/apply/apply-nonignored-stage");
    const result = await runRecorderBin(
      [
        "--config",
        configPath,
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
    assert.equal(result.code, 125);
    assert.equal(existsSync(ctx.counter), false);
    const failure = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    assert.equal(failure.child.status, "not-spawned");
    assert.equal(
      existsSync(
        join(ctx.archive, ".ak/dockets/issues/10/apply/apply-nonignored-stage/manifest.json"),
      ),
      false,
    );
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("real promotion failure via parent permissions yields 125 and no manifest", async () => {
  const ctx = setup();
  try {
    const docketId = "issues/10/apply/apply-prom-eacces";
    const configPath = configFor(ctx, docketId);
    const dest = join(ctx.archive, ".ak/dockets", docketId);
    const parent = join(ctx.archive, ".ak/dockets/issues/10/apply");
    const block = join(ctx.root, "chmod-parent.mjs");
    writeFileSync(
      block,
      `import { chmodSync, mkdirSync } from "node:fs";
mkdirSync(${JSON.stringify(parent)}, { recursive: true });
chmodSync(${JSON.stringify(parent)}, 0o555);
process.stdout.write("locked-parent\\n");
process.exit(0);
`,
    );
    const result = await runRecorderBin(
      ["--config", configPath, "--", process.execPath, block],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
      },
    );
    try {
      chmodSync(parent, 0o755);
    } catch {
      // parent may not exist if failure was earlier
    }
    assert.equal(result.code, 125);
    assert.match(result.stdout, /locked-parent/);
    const failure = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    assert.equal(failure.recorder.status, "failed");
    assert.ok(
      failure.recorder.code === "promotion-failed" ||
        failure.recorder.code === "destination-exists",
    );
    assert.equal(existsSync(join(dest, "manifest.json")), false);
    assert.equal(leftoverStageDirs(ctx.archive).length, 0);
  } finally {
    try {
      chmodSync(join(ctx.archive, ".ak/dockets/issues/10/apply"), 0o755);
    } catch {
      // ignore
    }
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("real raw-cleanup failure is a Recorder failure with no final docket", async (t) => {
  const ctx = setup();
  if (!canFreezeFileAgainstUnlink(ctx.root)) {
    t.skip("OS cannot freeze files against unlink");
    rmSync(ctx.root, { recursive: true, force: true });
    return;
  }
  let saboteur: { dispose: () => void } | null = null;
  try {
    const configPath = configFor(ctx, "issues/10/apply/apply-cleanup-fail");
    // Hold the child open so raw scratch files exist long enough for an OS freeze.
    const slow = join(ctx.root, "slow-ok.mjs");
    writeFileSync(
      slow,
      `await new Promise((r) => setTimeout(r, 400));
process.stdout.write("slow-ok\\n");
process.exit(0);
`,
    );
    // Isolate Recorder scratch under this fixture so concurrent suite work cannot
    // own the freeze target (production still uses os.tmpdir()/TMPDIR).
    const privateTmp = join(ctx.root, "private-tmp");
    mkdirSync(privateTmp, { recursive: true });
    const saboteurPromise = sabotageRawScratchCleanup({
      tmpDir: privateTmp,
      timeoutMs: 10000,
    });
    const runPromise = runRecorderBin(
      ["--config", configPath, "--", process.execPath, slow],
      {
        cwd: ctx.root,
        env: {
          ...process.env,
          AK_RECORDER_COUNTER: ctx.counter,
          TMPDIR: privateTmp,
          TMP: privateTmp,
          TEMP: privateTmp,
        },
      },
    );
    saboteur = await saboteurPromise;
    const result = await runPromise;
    if (saboteur === null) {
      t.skip("could not attach OS freeze to raw scratch in time");
      return;
    }
    assert.equal(result.code, 125);
    const lines = result.stderr.trim().split("\n").filter(Boolean);
    const failure = JSON.parse(lines.at(-1)!);
    assert.equal(failure.recorder.status, "failed");
    assert.equal(failure.recorder.code, "cleanup-failed");
    assert.equal(
      existsSync(
        join(ctx.archive, ".ak/dockets/issues/10/apply/apply-cleanup-fail/manifest.json"),
      ),
      false,
    );
    assert.equal(leftoverStageDirs(ctx.archive).length, 0);
  } finally {
    saboteur?.dispose();
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("two concurrent recorders: one wins, loser is 125, destination not overwritten", async () => {
  const ctx = setup();
  try {
    const docketId = "issues/10/apply/apply-race";
    const { configPath } = multiExhibitConfig(ctx, docketId, 24);
    const dest = join(ctx.archive, ".ak/dockets", docketId);
    const gate = join(ctx.root, "race-gate");
    const markerA = join(ctx.root, "race-a.txt");
    const markerB = join(ctx.root, "race-b.txt");
    const slow = join(ctx.root, "slow-ok.mjs");
    // Both children block until the test releases the gate so publication races.
    writeFileSync(
      slow,
      `import { appendFileSync, existsSync } from "node:fs";
const marker = process.env.RACE_MARKER;
const gate = process.env.RACE_GATE;
const deadline = Date.now() + 15000;
while (!existsSync(gate)) {
  if (Date.now() > deadline) {
    process.stderr.write("gate-timeout\\n");
    process.exit(2);
  }
  await new Promise((r) => setTimeout(r, 5));
}
appendFileSync(marker, "ran\\n");
process.stdout.write("race-body:" + process.env.RACE_ID + "\\n");
process.exit(0);
`,
    );
    const runOne = (id: string, marker: string) =>
      runRecorderBin(
        ["--config", configPath, "--", process.execPath, slow],
        {
          cwd: ctx.root,
          env: {
            ...process.env,
            AK_RECORDER_COUNTER: ctx.counter,
            RACE_MARKER: marker,
            RACE_ID: id,
            RACE_GATE: gate,
          },
        },
      );
    const pending = Promise.all([
      runOne("A", markerA),
      runOne("B", markerB),
    ]);
    // Release both children together once both have started (counter rows).
    const start = Date.now();
    while (Date.now() - start < 10000) {
      if (existsSync(ctx.counter)) {
        const lines = readFileSync(ctx.counter, "utf8").split("\n").filter(Boolean);
        if (lines.length >= 2) break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    writeFileSync(gate, "go\n");
    const [a, b] = await pending;
    const codes = [a.code, b.code].sort((x, y) => Number(x) - Number(y));
    assert.deepEqual(codes, [0, 125]);
    const winner = a.code === 0 ? a : b;
    const loser = a.code === 125 ? a : b;
    assert.match(winner.stdout, /race-body:/);
    const failure = JSON.parse(loser.stderr.trim().split("\n").at(-1)!);
    assert.equal(failure.recorder.status, "failed");
    assert.equal(failure.recorder.code, "destination-exists");
    assert.equal(observeFinalDocket(dest), "complete");
    const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
    assert.equal(manifest.recorder.status, "completed");
    // Exactly one complete docket; winner identity is stable in the teed stdout only once.
    const winnerId = winner.stdout.includes("race-body:A") ? "A" : "B";
    assert.equal(manifest.child.exitCode, 0);
    assert.equal(readFileSync(winnerId === "A" ? markerA : markerB, "utf8").includes("ran"), true);
    // No mixed tree: every stored artifact belongs to the single winner manifest.
    for (const artifact of manifest.artifacts ?? []) {
      if (artifact.stored?.path) {
        assert.equal(existsSync(join(dest, artifact.stored.path)), true);
      }
    }
    assert.equal(leftoverStageDirs(ctx.archive).length, 0);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("pre-existing empty destination directory is not overwritten or removed", async () => {
  const ctx = setup();
  try {
    const docketId = "issues/10/apply/apply-empty-dest";
    const { configPath } = multiExhibitConfig(ctx, docketId, 8);
    const dest = join(ctx.archive, ".ak/dockets", docketId);
    mkdirSync(dest, { recursive: true });
    // Plain directory rename would replace this empty directory; no-replace must lose.
    assert.deepEqual(readdirSync(dest), []);
    const result = await runRecorderBin(
      [
        "--config",
        configPath,
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
    assert.equal(result.code, 125);
    const failure = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    assert.equal(failure.recorder.status, "failed");
    assert.equal(failure.recorder.code, "destination-exists");
    assert.equal(existsSync(dest), true);
    assert.deepEqual(readdirSync(dest), []);
    assert.equal(existsSync(join(dest, "manifest.json")), false);
    assert.equal(leftoverStageDirs(ctx.archive).length, 0);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("pre-existing destination file is not overwritten by publication", async () => {
  const ctx = setup();
  try {
    const docketId = "issues/10/apply/apply-file-dest";
    const configPath = configFor(ctx, docketId);
    const dest = join(ctx.archive, ".ak/dockets", docketId);
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, "precious-file\n");
    const result = await runRecorderBin(
      [
        "--config",
        configPath,
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
    assert.equal(result.code, 125);
    const failure = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
    assert.equal(failure.recorder.code, "destination-exists");
    assert.equal(readFileSync(dest, "utf8"), "precious-file\n");
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("ordinary success removes private stage material", async () => {
  const ctx = setup();
  try {
    const configPath = configFor(ctx, "issues/10/apply/apply-cleanup-ok");
    const result = await runRecorderBin(
      [
        "--config",
        configPath,
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
    assert.equal(result.code, 0);
    assert.equal(leftoverStageDirs(ctx.archive).length, 0);
    assert.equal(
      existsSync(
        join(ctx.archive, ".ak/dockets/issues/10/apply/apply-cleanup-ok/manifest.json"),
      ),
      true,
    );
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("child signal plus Recorder failure yields one scanned JSON line and 125", async () => {
  const ctx = setup();
  try {
    const docketId = "issues/10/apply/apply-signal-rec-fail";
    const configPath = configFor(ctx, docketId);
    const dest = join(ctx.archive, ".ak/dockets", docketId);
    const script = join(ctx.root, "signal-then-collide.mjs");
    writeFileSync(
      script,
      `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
process.stderr.write("signal-diag Authorization: Bearer plainsecrettokenvalue888\\n");
mkdirSync(${JSON.stringify(dest)}, { recursive: true });
writeFileSync(join(${JSON.stringify(dest)}, "collision.txt"), "preexisting\\n");
process.kill(process.pid, "SIGTERM");
setInterval(() => {}, 10000);
`,
    );
    const result = await runRecorderBin(
      ["--config", configPath, "--", process.execPath, script],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
      },
    );
    assert.equal(result.code, 125);
    assert.equal(result.signal, null);
    // Child stderr teed first; exactly one trailing JSON failure line.
    assert.match(result.stderr, /^signal-diag /m);
    const lines = result.stderr.split("\n").filter((l) => l.length > 0);
    const jsonLines = lines.filter((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    assert.equal(jsonLines.length, 1);
    const failure = JSON.parse(jsonLines[0]!);
    assert.equal(failure.recorder.status, "failed");
    assert.equal(failure.child.status, "signaled");
    assert.equal(failure.child.signal, "SIGTERM");
    assert.equal(failure.child.exitCode, null);
    assert.equal(String(failure.child.diagnostic ?? "").includes("plainsecrettokenvalue888"), false);
    assert.equal(result.stderr.includes("plainsecrettokenvalue888"), true); // teed raw
    assert.equal(jsonLines[0]!.includes("plainsecrettokenvalue888"), false);
    assert.equal(existsSync(join(dest, "manifest.json")), false);
    assert.equal(leftoverStageDirs(ctx.archive).length, 0);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("publication observer never sees an empty or partial final docket", async () => {
  const ctx = setup();
  try {
    const docketId = "issues/10/apply/apply-observer";
    const dest = join(ctx.archive, ".ak/dockets", docketId);
    const { configPath } = multiExhibitConfig(ctx, docketId, 40);
    const slow = join(ctx.root, "observer-child.mjs");
    writeFileSync(
      slow,
      `await new Promise((r) => setTimeout(r, 80));
process.stdout.write("observer-child-ok\\n");
process.exit(0);
`,
    );
    const handle = spawnRecorderBin(
      ["--config", configPath, "--", process.execPath, slow],
      {
        cwd: ctx.root,
        env: { ...process.env, AK_RECORDER_COUNTER: ctx.counter },
      },
    );
    const observations = new Set<string>();
    let sawComplete = false;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const state = observeFinalDocket(dest);
      observations.add(state);
      if (state === "partial") {
        try {
          handle.child.kill("SIGKILL");
        } catch {
          // ignore
        }
        assert.fail(
          `observer saw partial final docket; states=${[...observations].join(",")}`,
        );
      }
      if (state === "complete") sawComplete = true;
      const done = await Promise.race([
        handle.result.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), 0)),
      ]);
      if (done) break;
      await new Promise((r) => setTimeout(r, 0));
    }
    const result = await handle.result;
    assert.equal(result.code, 0);
    assert.match(result.stdout, /observer-child-ok/);
    assert.equal(observeFinalDocket(dest), "complete");
    assert.equal(sawComplete || observations.has("complete"), true);
    // Only lawful states: absent before publish, complete after — never partial.
    for (const state of observations) {
      assert.ok(state === "absent" || state === "complete", state);
    }
    const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
    const stored = (manifest.artifacts ?? []).filter(
      (a: { stored?: unknown }) => a.stored,
    );
    assert.ok(stored.length >= 40, `expected many stored artifacts, got ${stored.length}`);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});

test("crash before publication leaves no final identity (stage residue only)", async () => {
  const ctx = setup();
  try {
    const docketId = "issues/10/apply/apply-crash-residue";
    const dest = join(ctx.archive, ".ak/dockets", docketId);
    const { configPath } = multiExhibitConfig(ctx, docketId, 30);
    const gate = join(ctx.root, "crash-gate");
    const slow = join(ctx.root, "crash-child.mjs");
    // Hold the child open so the Recorder remains in the pre-publication window
    // after admission has materialized private stage exhibits.
    writeFileSync(
      slow,
      `import { existsSync } from "node:fs";
const gate = process.env.CRASH_GATE;
const deadline = Date.now() + 20000;
while (!existsSync(gate)) {
  if (Date.now() > deadline) process.exit(2);
  await new Promise((r) => setTimeout(r, 5));
}
process.stdout.write("crash-child-ok\\n");
process.exit(0);
`,
    );
    // Invoke the production CLI entry directly (one process) so SIGKILL cannot
    // leave an orphaned launcher grandchild that still publishes.
    const handle = spawnRecorderBin(
      ["--config", configPath, "--", process.execPath, slow],
      {
        cwd: ctx.root,
        env: {
          ...process.env,
          AK_RECORDER_COUNTER: ctx.counter,
          CRASH_GATE: gate,
        },
        binPath: join(packageRoot, "dist/recorder/cli.js"),
      },
    );

    // Wait until admission finished and the child is alive (counter written).
    let stageReady: string | null = null;
    const readyDeadline = Date.now() + 15000;
    while (Date.now() < readyDeadline) {
      if (observeFinalDocket(dest) !== "absent") {
        killProcessTree(handle.pid);
        await handle.result.catch(() => null);
        assert.fail("final docket appeared before crash probe");
      }
      for (const name of leftoverStageDirs(ctx.archive)) {
        const stage = join(ctx.archive, ".ak/work", name);
        const exhibits = join(stage, "exhibits");
        if (existsSync(exhibits) && readdirSync(exhibits).length >= 10) {
          stageReady = stage;
          break;
        }
      }
      if (stageReady) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    assert.ok(stageReady, "private stage never materialized exhibits before publication");
    assert.equal(observeFinalDocket(dest), "absent");
    assert.equal(existsSync(dest), false);

    // Terminate Recorder (and its child) during the pre-publication window.
    killProcessTree(handle.pid);
    await handle.result.catch(() => null);

    // Final pathname must remain absent; only private ignored stage residue may remain.
    assert.equal(observeFinalDocket(dest), "absent");
    assert.equal(existsSync(dest), false);
    const stages = leftoverStageDirs(ctx.archive);
    assert.ok(stages.length >= 1, "expected ignored stage residue after crash");
    for (const name of stages) {
      const stage = join(ctx.archive, ".ak/work", name);
      assert.equal(existsSync(join(stage, "exhibits")), true);
    }
    // Gate was never released; no successful publication path.
    assert.equal(existsSync(gate), false);
  } finally {
    rmSync(ctx.root, { recursive: true, force: true });
  }
});
