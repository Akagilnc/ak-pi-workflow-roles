import assert from "node:assert/strict";
import { execFile } from "node:child_process";
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

test("installed tarball exposes node_modules/.bin/ak-docket-record and runs once", async () => {
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
        const configPath = writeRecorderConfig(workspace, {
          archiveRepo: archive,
          cwd: workspace,
          docketId: "issues/10/apply/apply-install-001",
          authority: {
            repositoryRoot: archive,
            commit: authority.commit,
            path: authority.path,
            blobOid: authority.blobOid,
            sha256: authority.sha256,
          },
          task: {
            repositoryRoot: archive,
            commit: task.commit,
            path: task.path,
            blobOid: task.blobOid,
            sha256: task.sha256,
          },
        });
        const { spawn } = await import("node:child_process");
        const result = await new Promise<{
          code: number | null;
          stdout: string;
          stderr: string;
        }>((resolveResult, reject) => {
          const child = spawn(
            bin,
            [
              "--config",
              configPath,
              "--",
              process.execPath,
              script,
              "stdout-stderr",
              "from-bin",
            ],
            {
              cwd: workspace,
              env: { ...process.env, AK_RECORDER_COUNTER: counter },
              stdio: ["ignore", "pipe", "pipe"],
            },
          );
          let stdout = "";
          let stderr = "";
          child.stdout.setEncoding("utf8").on("data", (c) => {
            stdout += c;
          });
          child.stderr.setEncoding("utf8").on("data", (c) => {
            stderr += c;
          });
          child.on("error", reject);
          child.on("close", (code) => resolveResult({ code, stdout, stderr }));
        });
        assert.equal(result.code, 0);
        assert.match(result.stdout, /OUT:from-bin/);
        const counterText = await readFile(counter, "utf8");
        assert.equal(counterText.trim(), "1");
        const manifest = JSON.parse(
          await readFile(
            join(
              archive,
              ".ak/dockets/issues/10/apply/apply-install-001/manifest.json",
            ),
            "utf8",
          ),
        );
        assert.equal(manifest.recorder.status, "completed");
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
