import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import test from "node:test";

import {
  commitFile,
  initGitRepo,
  makeTempDir,
  runRecorderBin,
  sha256File,
  writeCounterScript,
  writeRecorderConfig,
} from "./helpers/recorder-test-harness.ts";

function gitState(repo: string): { head: string; status: string } {
  return {
    head: execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    status: execFileSync("git", ["-C", repo, "status", "--porcelain"], {
      encoding: "utf8",
    }),
  };
}

test("git references verify committed bytes and leave HEAD/index unchanged", async () => {
  const root = makeTempDir("ak-recorder-admit-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "docs/authority.md", "# authority\n");
    const task = commitFile(archive, "docs/task.md", "# task\n");
    const before = gitState(archive);
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");
    const configPath = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-admit-001",
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
    const result = await runRecorderBin(
      ["--config", configPath, "--", process.execPath, script, "ok"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(result.code, 0);
    const after = gitState(archive);
    // Recorder never mutates HEAD/index; docket bytes may appear untracked.
    assert.equal(after.head, before.head);
    const staged = after.status
      .split("\n")
      .filter((line) => line && !line.startsWith("??"));
    assert.deepEqual(staged, []);
    const manifest = JSON.parse(
      readFileSync(
        join(archive, ".ak/dockets/issues/10/apply/apply-admit-001/manifest.json"),
        "utf8",
      ),
    );
    const auth = manifest.artifacts.find((a: { id: string }) => a.id === "authority");
    assert.equal(auth.reference.identity, "reference");
    assert.equal(auth.reference.blobOid, authority.blobOid);
    assert.equal(auth.stored, undefined);
    // committed material not copied
    assert.equal(
      existsSync(
        join(archive, ".ak/dockets/issues/10/apply/apply-admit-001/docs/authority.md"),
      ),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dirty worktree bytes cannot satisfy a git reference", async () => {
  const root = makeTempDir("ak-recorder-dirty-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "authority.md", "# authority\n");
    const task = commitFile(archive, "task.md", "# task\n");
    // dirty the authority file and try to claim dirty bytes via wrong hash
    writeFileSync(join(archive, "authority.md"), "# dirty secret\n");
    const dirtyHash = sha256File("# dirty secret\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");
    const configPath = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-dirty-001",
      authority: {
        repositoryRoot: archive,
        commit: authority.commit,
        path: authority.path,
        blobOid: authority.blobOid,
        sha256: dirtyHash, // mismatch against committed bytes
      },
      task: {
        repositoryRoot: archive,
        commit: task.commit,
        path: task.path,
        blobOid: task.blobOid,
        sha256: task.sha256,
      },
    });
    const result = await runRecorderBin(
      ["--config", configPath, "--", process.execPath, script, "ok"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(result.code, 125);
    assert.equal(
      existsSync(join(archive, ".ak/dockets/issues/10/apply/apply-dirty-001")),
      false,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("blob/path/commit mismatches and short commits fail admission", async () => {
  const root = makeTempDir("ak-recorder-mismatch-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "authority.md", "# authority\n");
    const task = commitFile(archive, "task.md", "# task\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");
    const base = {
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
    };
    const cases = [
      {
        docketId: "issues/10/apply/apply-bad-blob-001",
        patch: {
          authority: { ...base.authority, blobOid: "0".repeat(40) },
        },
      },
      {
        docketId: "issues/10/apply/apply-bad-path-001",
        patch: {
          authority: { ...base.authority, path: "missing.md" },
        },
      },
      {
        docketId: "issues/10/apply/apply-short-001",
        patch: {
          authority: {
            ...base.authority,
            commit: authority.commit.slice(0, 12),
          },
        },
      },
    ];
    for (const item of cases) {
      const configPath = writeRecorderConfig(root, {
        ...base,
        docketId: item.docketId,
        ...item.patch,
      });
      // short commit is rejected at config parse
      const result = await runRecorderBin(
        ["--config", configPath, "--", process.execPath, script, "ok"],
        { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
      );
      assert.equal(result.code, 125, item.docketId);
      assert.equal(
        existsSync(join(archive, ".ak/dockets", item.docketId.replace(/^issues/, "issues"))),
        false,
      );
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("external inputs and exhibits are stored once with exact digests", async () => {
  const root = makeTempDir("ak-recorder-stored-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "authority.md", "# authority\n");
    const task = commitFile(archive, "task.md", "# task\n");
    const inputPath = join(root, "input.txt");
    const exhibitPath = join(root, "exhibit.txt");
    writeFileSync(inputPath, "input-bytes\n");
    writeFileSync(exhibitPath, "exhibit-bytes\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");
    const configPath = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-stored-001",
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
      externalInputs: [{
        id: "extra-input",
        sourcePath: inputPath,
        sha256: sha256File("input-bytes\n"),
        kind: "input",
      }],
      exhibits: [{
        id: "proof",
        sourcePath: exhibitPath,
        sha256: sha256File("exhibit-bytes\n"),
      }],
    });
    const result = await runRecorderBin(
      ["--config", configPath, "--", process.execPath, script, "ok"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(result.code, 0);
    const dest = join(archive, ".ak/dockets/issues/10/apply/apply-stored-001");
    assert.equal(readFileSync(join(dest, "inputs/extra-input"), "utf8"), "input-bytes\n");
    assert.equal(readFileSync(join(dest, "exhibits/proof"), "utf8"), "exhibit-bytes\n");
    const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
    const stored = manifest.artifacts.filter((a: { stored?: unknown }) => a.stored);
    assert.ok(stored.length >= 2);
    for (const item of stored) {
      assert.equal(item.stored.identity, "stored");
      assert.equal(typeof item.stored.byteLength, "number");
      assert.equal(item.reference, undefined);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cross-repository reference success and repository confusion failure", async () => {
  const root = makeTempDir("ak-recorder-crossref-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const other = initGitRepo(join(root, "other"));
    // seed archive so it is a valid archive root
    commitFile(archive, "README.md", "archive\n");
    const authority = commitFile(other, "authority.md", "# authority\n");
    const task = commitFile(other, "task.md", "# task\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");

    const okConfig = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-crossref-ok",
      authority: {
        repositoryRoot: other,
        commit: authority.commit,
        path: authority.path,
        blobOid: authority.blobOid,
        sha256: authority.sha256,
      },
      task: {
        repositoryRoot: other,
        commit: task.commit,
        path: task.path,
        blobOid: task.blobOid,
        sha256: task.sha256,
      },
    });
    const ok = await runRecorderBin(
      ["--config", okConfig, "--", process.execPath, script, "ok"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(ok.code, 0);

    // confusion: declare other commit but claim archive as repositoryRoot
    const badConfig = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-crossref-bad",
      authority: {
        repositoryRoot: archive,
        commit: authority.commit,
        path: authority.path,
        blobOid: authority.blobOid,
        sha256: authority.sha256,
      },
      task: {
        repositoryRoot: other,
        commit: task.commit,
        path: task.path,
        blobOid: task.blobOid,
        sha256: task.sha256,
      },
    });
    const bad = await runRecorderBin(
      ["--config", badConfig, "--", process.execPath, script, "ok"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(bad.code, 125);
    void mkdirSync;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
