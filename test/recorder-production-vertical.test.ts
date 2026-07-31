import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import { runRecorder } from "../src/recorder/run.ts";
import { commitFile, initGitRepo, makeTempDir, npmPackTo, runRecorderBin, writeCounterScript, writeRecorderConfig } from "./helpers/recorder-test-harness.ts";

function sink() {
  const chunks: Buffer[] = [];
  return { stream: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }), text: () => Buffer.concat(chunks).toString("utf8") };
}

function fixture() {
  const root = makeTempDir("recorder-vertical-");
  initGitRepo(root);
  mkdirSync(join(root, ".ak/work/018f22e2-7d5a-7abc-8abc-123456789abc"), { recursive: true });
  const authority = commitFile(root, "authority.md", "authority\n");
  const task = commitFile(root, "task.md", "task\n");
  const counter = join(root, "counter.log");
  const child = writeCounterScript(root);
  const config = writeRecorderConfig(root, {
    archiveRepo: root,
    docketId: "issues/33/apply/vertical",
    cwd: root,
    overrides: { AK_RECORDER_COUNTER: counter, AK_REPORT: "configured" },
    unset: ["PI_SESSION_DIR"],
    authority: { repositoryRoot: root, ...authority },
    task: { repositoryRoot: root, ...task },
  });
  return { root, counter, child, config, destination: join(root, ".ak/dockets/issues/33/apply/vertical") };
}

test("Recorder rejects invalid argv before spawn and invokes one real child with the native session contract", async () => {
  const invalid = fixture();
  const invalidResult = await runRecorder({ argv: ["--config", invalid.config, "--", invalid.child] });
  assert.equal(invalidResult.exitCode, 125);
  assert.equal(existsSync(invalid.counter), false);

  const valid = fixture();
  const stdout = sink();
  const stderr = sink();
  const result = await runRecorder({
    argv: ["--config", valid.config, "--", valid.child, "-p", "native-session", "tail"],
    env: { ...process.env, AK_REPORT: "inherited-wrong", PI_SESSION_DIR: "/inherited/wrong" },
    stdout: stdout.stream as NodeJS.WriteStream,
    stderr: stderr.stream as NodeJS.WriteStream,
  });
  assert.deepEqual(result, { exitCode: 0, signal: null, failureJson: null });
  assert.equal(readFileSync(valid.counter, "utf8"), "1\n");
  assert.equal(stdout.text(), "OUT:native\n");
  assert.equal(stderr.text(), "ERR:native\n");
  const manifest = JSON.parse(readFileSync(join(valid.destination, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.execution.argv, [valid.child, "--session-dir", join(realpathSync(valid.root), ".ak/work/018f22e2-7d5a-7abc-8abc-123456789abc/session"), "--session-id", "018f22e2-7d5a-7abc-8abc-123456789abc", "-p", "native-session", "tail"]);
  assert.equal(JSON.parse(readFileSync(join(valid.destination, "receipt.json"), "utf8")).details.report, "configured");
  assert.deepEqual(readdirSync(valid.destination).sort(), ["manifest.json", "receipt.json"]);
});

test("cleanup failure leaves bounded evidence without masking the primary or child truth", async () => {
  const run = fixture();
  let result;
  try {
    result = await runRecorder({
      argv: ["--config", run.config, "--", run.child, "-p", "native-session"],
      env: { ...process.env, AK_RECORDER_COUNTER: run.counter, AK_CHILD_EXIT: "23", AK_LOCK_WORK: "1" },
    });
  } finally {
    chmodSync(join(run.root, ".ak/work"), 0o700);
  }
  assert.equal(result.exitCode, 125);
  assert.equal(existsSync(run.destination), false);
  const failure = JSON.parse(result.failureJson!);
  assert.equal(failure.recorder.code, "promotion-failed");
  assert.deepEqual(failure.recorder.cleanup, { status: "failed", category: "filesystem-inaccessible" });
  assert.equal(failure.child.status, "exited");
  assert.equal(failure.child.exitCode, 23);
  assert.equal(JSON.stringify(failure).includes(run.root), false);
  assert.equal(JSON.stringify(failure).includes("EACCES"), false);
});

test("cold-installed Recorder binary seals one native-session child", async () => {
  const packDir = makeTempDir("recorder-pack-");
  const tarball = await npmPackTo(packDir);
  const consumer = makeTempDir("recorder-consumer-");
  writeFileSync(join(consumer, "package.json"), '{"private":true}');
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], { cwd: consumer, stdio: "ignore" });
  const run = fixture();
  const result = await runRecorderBin(["--config", run.config, "--", run.child, "-p", "native-session"], {
    cwd: run.root,
    binPath: join(consumer, "node_modules/.bin/ak-docket-record"),
    env: { ...process.env, AK_RECORDER_COUNTER: run.counter },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(readFileSync(run.counter, "utf8"), "1\n");
  assert.equal(existsSync(join(run.destination, "receipt.json")), true);
});
