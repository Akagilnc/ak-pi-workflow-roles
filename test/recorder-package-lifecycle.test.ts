import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  commitFile,
  initGitRepo,
  makeTempDir,
  npmPackTo,
  runRecorderBin,
  sha256File,
  writeCounterScript,
  writeRecorderConfig,
} from "./helpers/recorder-test-harness.ts";
import {
  packageRoot,
  withHermeticHome,
} from "./helpers/pi-test-harness.ts";

const exec = promisify(execFile);

test("npm pack includes recorder bin, source, schema, and docs", async () => {
  await withHermeticHome({ prefix: "ak-recorder-pack-" }, async ({ home }) => {
    const pack = JSON.parse(
      (
        await exec("npm", ["pack", "--json", "--pack-destination", home], {
          cwd: packageRoot,
        })
      ).stdout,
    ) as Array<{ filename: string; files: Array<{ path: string }> }>;
    const paths = pack[0]!.files.map((file) => file.path);
    assert.ok(paths.includes("bin/ak-docket-record.js"));
    assert.ok(paths.includes("dist/recorder/cli.js"));
    assert.ok(paths.includes("dist/recorder/run.js"));
    assert.ok(paths.includes("src/recorder/cli.ts"));
    assert.ok(paths.includes("src/recorder/run.ts"));
    assert.ok(paths.includes("schemas/recorder-manifest-v1.schema.json"));
    assert.ok(paths.includes("README.md"));
  });
});

test("installed tarball .bin proves stdin, streams, exit/signal, one-spawn, and recorder failure", async () => {
  await withHermeticHome(
    { prefix: "ak-recorder-install-" },
    async ({ home }) => {
      const tarball = await npmPackTo(home);
      const consumer = resolve(home, "consumer");
      await mkdir(consumer, { recursive: true });
      await writeFile(
        resolve(consumer, "package.json"),
        JSON.stringify({
          private: true,
          dependencies: {
            "@ak/pi-workflow-roles": `file:${tarball}`,
          },
        }),
      );
      await exec("npm", ["install", "--omit=dev"], { cwd: consumer });
      const bin = resolve(consumer, "node_modules/.bin/ak-docket-record");
      await access(bin);

      const workspace = makeTempDir("ak-recorder-consumer-run-");
      try {
        const archive = initGitRepo(join(workspace, "archive"));
        const authority = commitFile(archive, "authority.md", "# authority\n");
        const task = commitFile(archive, "task.md", "# task\n");
        const script = writeCounterScript(workspace);
        const counter = join(workspace, "counter.txt");
        const auth = {
          repositoryRoot: archive,
          commit: authority.commit,
          path: authority.path,
          blobOid: authority.blobOid,
          sha256: authority.sha256,
        };
        const taskRef = {
          repositoryRoot: archive,
          commit: task.commit,
          path: task.path,
          blobOid: task.blobOid,
          sha256: task.sha256,
        };

        const runInstalled = (
          docketId: string,
          childArgs: string[],
          opts: { input?: string | Buffer } = {},
        ) => {
          const configPath = writeRecorderConfig(workspace, {
            archiveRepo: archive,
            cwd: workspace,
            docketId,
            authority: auth,
            task: taskRef,
          });
          // writeRecorderConfig always uses the same filename; unique per call via rewrite is fine
          // because runs are sequential.
          return runRecorderBin(
            ["--config", configPath, "--", process.execPath, script, ...childArgs],
            {
              cwd: workspace,
              env: { ...process.env, AK_RECORDER_COUNTER: counter },
              binPath: bin,
              ...(opts.input !== undefined ? { input: opts.input } : {}),
            },
          );
        };

        // Stream separation + one-spawn happy path
        const streams = await runInstalled(
          "issues/10/apply/apply-install-streams",
          ["stdout-stderr", "from-bin"],
        );
        assert.equal(streams.code, 0);
        assert.match(streams.stdout, /OUT:from-bin/);
        assert.match(streams.stderr, /ERR:marker/);
        assert.equal((await readFile(counter, "utf8")).trim().split("\n").length, 1);
        const streamManifest = JSON.parse(
          await readFile(
            join(
              archive,
              ".ak/dockets/issues/10/apply/apply-install-streams/manifest.json",
            ),
            "utf8",
          ),
        );
        assert.equal(streamManifest.recorder.status, "completed");
        assert.equal(streamManifest.child.exitCode, 0);

        // Inherited stdin
        const stdinPayload = "stdin-from-installed-bin\n";
        const stdinResult = await runInstalled(
          "issues/10/apply/apply-install-stdin",
          ["stdin-echo"],
          { input: stdinPayload },
        );
        assert.equal(stdinResult.code, 0);
        assert.equal(stdinResult.stdout, stdinPayload);

        // Child nonzero preserved
        const nonzero = await runInstalled(
          "issues/10/apply/apply-install-exit-9",
          ["exit", "9"],
        );
        assert.equal(nonzero.code, 9);
        const nonzeroManifest = JSON.parse(
          await readFile(
            join(
              archive,
              ".ak/dockets/issues/10/apply/apply-install-exit-9/manifest.json",
            ),
            "utf8",
          ),
        );
        assert.equal(nonzeroManifest.child.exitCode, 9);
        assert.equal(nonzeroManifest.recorder.status, "completed");

        // Child signal archived then re-raised through launcher
        const signaled = await runInstalled(
          "issues/10/apply/apply-install-signal",
          ["signal", "SIGTERM"],
        );
        assert.equal(signaled.signal, "SIGTERM");
        const signalManifest = JSON.parse(
          await readFile(
            join(
              archive,
              ".ak/dockets/issues/10/apply/apply-install-signal/manifest.json",
            ),
            "utf8",
          ),
        );
        assert.equal(signalManifest.child.status, "signaled");
        assert.equal(signalManifest.child.signal, "SIGTERM");

        // Recorder failure precedence via child-created collision
        const failId = "issues/10/apply/apply-install-rec-fail";
        const dest = join(archive, ".ak/dockets", failId);
        const collide = join(workspace, "install-collide.mjs");
        await writeFile(
          collide,
          `import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
process.stdout.write("install-collide-out\\n");
process.stderr.write("install-collide-err\\n");
mkdirSync(${JSON.stringify(dest)}, { recursive: true });
writeFileSync(join(${JSON.stringify(dest)}, "collision.txt"), "x\\n");
process.exit(4);
`,
        );
        const failConfig = writeRecorderConfig(workspace, {
          archiveRepo: archive,
          cwd: workspace,
          docketId: failId,
          authority: auth,
          task: taskRef,
        });
        const failed = await runRecorderBin(
          ["--config", failConfig, "--", process.execPath, collide],
          {
            cwd: workspace,
            env: { ...process.env, AK_RECORDER_COUNTER: counter },
            binPath: bin,
          },
        );
        assert.equal(failed.code, 125);
        assert.equal(failed.stdout, "install-collide-out\n");
        assert.match(failed.stderr, /^install-collide-err\n/);
        const failLines = failed.stderr.trim().split("\n");
        const failure = JSON.parse(failLines.at(-1)!);
        assert.equal(failure.recorder.status, "failed");
        assert.equal(failure.child.status, "exited");
        assert.equal(failure.child.exitCode, 4);
        assert.equal(existsSync(join(dest, "manifest.json")), false);

        // One-spawn total across successful counter uses: streams + stdin + exit + signal = 4
        // (collision script does not use counter)
        const counterText = await readFile(counter, "utf8");
        assert.equal(counterText.trim().split("\n").filter(Boolean).length, 4);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});

test("recorder modules do not import role-runtime extension surface", async () => {
  const { readdir, readFile } = await import("node:fs/promises");
  const dir = resolve(packageRoot, "src/recorder");
  const files = await readdir(dir);
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(resolve(dir, file), "utf8");
    assert.equal(
      text.includes("role-runtime"),
      false,
      `${file} must not import role-runtime`,
    );
    assert.equal(
      text.includes("extensions/"),
      false,
      `${file} must not import extensions`,
    );
    assert.equal(
      /from ["'].*\/(worker-role|judge-role|reviewer-role|collector-role|collector-ledger|collector-receipt)/.test(
        text,
      ),
      false,
      `${file} must not import full role registration surfaces`,
    );
  }
  void sha256File;
});

test("recorder startup module graph excludes role registration/model/help", async () => {
  const { readFile, readdir } = await import("node:fs/promises");
  const recorderDir = resolve(packageRoot, "src/recorder");
  const files = await readdir(recorderDir);
  for (const file of files) {
    if (!file.endsWith(".ts")) continue;
    const text = await readFile(resolve(recorderDir, file), "utf8");
    assert.equal(text.includes("role-runtime"), false, file);
    assert.equal(text.includes("souls/"), false, file);
    assert.equal(text.includes("reviewer-agent"), false, file);
    assert.equal(text.includes("collector-role"), false, file);
    assert.equal(text.includes("worker-role"), false, file);
    assert.equal(text.includes("judge-role"), false, file);
    assert.equal(text.includes("reviewer-role"), false, file);
    assert.equal(text.includes("collector-receipt"), false, file);
    assert.equal(text.includes("collector-ledger"), false, file);
  }
  const extract = await readFile(resolve(recorderDir, "extract.ts"), "utf8");
  assert.match(extract, /package-contracts\/terminating-tools/);
});
