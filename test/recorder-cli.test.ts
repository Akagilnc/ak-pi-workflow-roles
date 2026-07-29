import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function setupRepos() {
  const root = makeTempDir("ak-recorder-cli-");
  const archive = initGitRepo(join(root, "archive"));
  const authority = commitFile(archive, "authority.md", "# authority\n");
  const task = commitFile(archive, "task.md", "# task\n");
  const counter = join(root, "counter.txt");
  const script = writeCounterScript(root);
  const configPath = writeRecorderConfig(root, {
    archiveRepo: archive,
    cwd: root,
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
  return { root, archive, configPath, script, counter };
}

test("malformed grammar fails before spawn with 125 and not-spawned", async () => {
  const { root, script, counter } = setupRepos();
  try {
    const cases = [
      [],
      ["--help"],
      ["--config"],
      ["--config", join(root, "missing.json"), "--"],
      ["--config", join(root, "missing.json"), "--", script],
      ["--other", "x", "--", script],
      ["--config", join(root, "nope.json")],
    ];
    for (const args of cases) {
      const result = await runRecorderBin(args, {
        cwd: root,
        env: { ...process.env, AK_RECORDER_COUNTER: counter },
      });
      assert.equal(result.code, 125, `args=${JSON.stringify(args)}`);
      assert.equal(existsSync(counter), false, "child must not run");
      const failure = JSON.parse(result.stderr.trim().split("\n").at(-1)!);
      assert.equal(failure.recorder.status, "failed");
      assert.equal(failure.child.status, "not-spawned");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("closed config rejects unknown fields and invalid archive values", async () => {
  const { root, archive, configPath, script, counter } = setupRepos();
  try {
    const base = JSON.parse(readFileSync(configPath, "utf8"));
    const invalids = [
      { ...base, extra: true },
      { ...base, version: 2 },
      {
        ...base,
        archive: { ...base.archive, docketId: "../escape" },
      },
      {
        ...base,
        archive: { ...base.archive, docketId: "/absolute" },
      },
      {
        ...base,
        execution: {
          ...base.execution,
          environment: {
            inherit: true,
            overrides: { A: "1" },
            unset: ["A"],
          },
        },
      },
    ];
    for (const [index, config] of invalids.entries()) {
      const path = join(root, `bad-${index}.json`);
      writeFileSync(path, JSON.stringify(config));
      const result = await runRecorderBin(
        ["--config", path, "--", process.execPath, script, "ok"],
        { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
      );
      assert.equal(result.code, 125, `case ${index}`);
      assert.equal(existsSync(counter), false);
      void archive;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exact argv, cwd, env precedence, separate stdout/stderr tee, one spawn", async () => {
  const { root, archive, configPath, script, counter } = setupRepos();
  try {
    // rewrite config with env controls
    const authority = commitFile(archive, "authority2.md", "# a2\n");
    // use existing refs from setup — rewrite config file
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.execution.environment = {
      inherit: true,
      overrides: { REC_OVR: "from-override", REC_SHARED: "override-wins" },
      unset: ["REC_UNSET"],
    };
    cfg.execution.cwd = root;
    cfg.archive.docketId = "issues/10/apply/apply-spawn-001";
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));

    const env = {
      ...process.env,
      AK_RECORDER_COUNTER: counter,
      REC_UNSET: "should-go",
      REC_SHARED: "parent",
      REC_KEEP: "kept",
    };

    const difficult = ["a b", "--flag=x", "weird|token", ""];
    // empty string argv element is allowed as child arg after command
    const result = await runRecorderBin(
      [
        "--config",
        configPath,
        "--",
        process.execPath,
        script,
        "stdout-stderr",
        ...difficult,
      ],
      { cwd: root, env },
    );
    assert.equal(result.code, 0);
    assert.equal(readFileSync(counter, "utf8").trim(), "1");
    assert.match(result.stdout, /OUT:a b\|--flag=x\|weird\|token\|/);
    assert.match(result.stderr, /ERR:marker/);
    // no recorder success JSON
    assert.equal(result.stderr.includes('"recorder":{"status":"failed"'), false);

    const dest = join(
      archive,
      ".ak/dockets/issues/10/apply/apply-spawn-001",
    );
    assert.equal(existsSync(join(dest, "manifest.json")), true);
    const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.execution.argv.slice(2), [
      "stdout-stderr",
      ...difficult,
    ]);
    assert.equal(manifest.recorder.status, "completed");
    assert.equal(manifest.child.status, "exited");
    assert.equal(manifest.child.exitCode, 0);
    void authority;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("environment inherit false starts empty then applies unset/overrides", async () => {
  const { root, archive, configPath, script, counter } = setupRepos();
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.execution.environment = {
      inherit: false,
      overrides: {
        ONLY: "yes",
        AK_RECORDER_COUNTER: counter,
      },
      unset: [],
    };
    cfg.archive.docketId = "issues/10/apply/apply-env-001";
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    const result = await runRecorderBin(
      [
        "--config",
        configPath,
        "--",
        process.execPath,
        script,
        "env",
        "ONLY",
        "PATH",
        "HOME",
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          AK_RECORDER_COUNTER: counter,
          ONLY: "parent",
          PATH: process.env.PATH,
        },
      },
    );
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /ONLY=yes/);
    assert.match(result.stdout, /PATH=<unset>/);
    assert.match(result.stdout, /HOME=<unset>/);
    void archive;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-repository archive root differs from cwd and reference repos", async () => {
  const root = makeTempDir("ak-recorder-cross-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const refs = initGitRepo(join(root, "refs"));
    const authority = commitFile(refs, "authority.md", "# authority\n");
    const task = commitFile(refs, "task.md", "# task\n");
    const cwd = join(root, "cwd");
    mkdirSync(cwd, { recursive: true });
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");
    const configPath = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd,
      docketId: "issues/10/apply/apply-cross-001",
      authority: {
        repositoryRoot: refs,
        commit: authority.commit,
        path: authority.path,
        blobOid: authority.blobOid,
        sha256: authority.sha256,
      },
      task: {
        repositoryRoot: refs,
        commit: task.commit,
        path: task.path,
        blobOid: task.blobOid,
        sha256: task.sha256,
      },
    });
    const result = await runRecorderBin(
      ["--config", configPath, "--", process.execPath, script, "cwd"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(result.code, 0, result.stderr);
    const { realpathSync } = await import("node:fs");
    assert.equal(result.stdout.trim(), realpathSync(cwd));
    assert.equal(
      existsSync(join(archive, ".ak/dockets/issues/10/apply/apply-cross-001/manifest.json")),
      true,
    );
    assert.equal(
      existsSync(join(refs, ".ak/dockets/issues/10/apply/apply-cross-001")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("existing destination is never overwritten", async () => {
  const { root, archive, configPath, script, counter } = setupRepos();
  try {
    const cfg = JSON.parse(readFileSync(configPath, "utf8"));
    cfg.archive.docketId = "issues/10/apply/apply-exists-001";
    writeFileSync(configPath, JSON.stringify(cfg, null, 2));
    const dest = join(archive, ".ak/dockets/issues/10/apply/apply-exists-001");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "marker.txt"), "keep\n");
    const result = await runRecorderBin(
      ["--config", configPath, "--", process.execPath, script, "ok"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(result.code, 125);
    assert.equal(existsSync(counter), false);
    assert.equal(readFileSync(join(dest, "marker.txt"), "utf8"), "keep\n");
    assert.equal(existsSync(join(dest, "manifest.json")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
