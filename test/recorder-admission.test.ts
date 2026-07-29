import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
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

function spawnCount(counter: string): number {
  if (!existsSync(counter)) return 0;
  return readFileSync(counter, "utf8").split("\n").filter(Boolean).length;
}

async function expectAdmissionFailure(options: {
  root: string;
  archive: string;
  configPath: string;
  script: string;
  counter: string;
  docketId: string;
  label: string;
}): Promise<void> {
  const before = gitState(options.archive);
  const beforeSpawns = spawnCount(options.counter);
  const result = await runRecorderBin(
    [
      "--config",
      options.configPath,
      "--",
      process.execPath,
      options.script,
      "ok",
    ],
    {
      cwd: options.root,
      env: { ...process.env, AK_RECORDER_COUNTER: options.counter },
    },
  );
  assert.equal(result.code, 125, `${options.label}: exit ${result.code}\n${result.stderr}`);
  assert.equal(
    spawnCount(options.counter),
    beforeSpawns,
    `${options.label}: child must not spawn`,
  );
  assert.equal(
    existsSync(join(options.archive, ".ak/dockets", options.docketId)),
    false,
    `${options.label}: no promoted docket`,
  );
  const after = gitState(options.archive);
  // Recorder must not mutate HEAD or the index; pre-existing dirty worktree may remain.
  assert.equal(after.head, before.head, `${options.label}: HEAD unchanged`);
  assert.equal(
    after.status,
    before.status,
    `${options.label}: worktree/index status unchanged by recorder`,
  );
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

test("dirty tracked path cannot satisfy a git reference even with committed hashes", async () => {
  const root = makeTempDir("ak-recorder-dirty-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "authority.md", "# authority\n");
    const task = commitFile(archive, "task.md", "# task\n");
    writeFileSync(join(archive, "authority.md"), "# dirty but declaration names commit\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");
    const docketId = "issues/10/apply/apply-dirty-001";
    const configPath = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId,
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
    await expectAdmissionFailure({
      root,
      archive,
      configPath,
      script,
      counter,
      docketId,
      label: "dirty tracked path",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("admission counterexample matrix rejects before spawn", async () => {
  const root = makeTempDir("ak-recorder-admit-matrix-");
  try {
    const archive = initGitRepo(join(root, "archive"));
    const authority = commitFile(archive, "authority.md", "# authority\n");
    const task = commitFile(archive, "task.md", "# task\n");
    const script = writeCounterScript(root);
    const counter = join(root, "counter.txt");

    const baseAuthority = {
      repositoryRoot: archive,
      commit: authority.commit,
      path: authority.path,
      blobOid: authority.blobOid,
      sha256: authority.sha256,
    };
    const baseTask = {
      repositoryRoot: archive,
      commit: task.commit,
      path: task.path,
      blobOid: task.blobOid,
      sha256: task.sha256,
    };

    // Orphan commit not reachable from HEAD.
    const orphanCommit = execFileSync(
      "git",
      [
        "-C",
        archive,
        "commit-tree",
        execFileSync("git", ["-C", archive, "rev-parse", "HEAD^{tree}"], {
          encoding: "utf8",
        }).trim(),
        "-m",
        "orphan",
      ],
      { encoding: "utf8" },
    ).trim();

    // Future/unreachable: commit on a side branch then reset main away from it.
    execFileSync("git", ["-C", archive, "checkout", "-b", "side"], {
      stdio: "ignore",
    });
    const future = commitFile(archive, "future.md", "future\n");
    execFileSync("git", ["-C", archive, "checkout", "main"], { stdio: "ignore" });

    // Directory-as-blob fixture.
    mkdirSync(join(archive, "dirblob"), { recursive: true });
    writeFileSync(join(archive, "dirblob/nested.md"), "nested\n");
    execFileSync("git", ["-C", archive, "add", "dirblob"], { stdio: "ignore" });
    execFileSync("git", ["-C", archive, "commit", "-m", "dir"], {
      stdio: "ignore",
    });
    const dirCommit = execFileSync("git", ["-C", archive, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    // Refresh task after extra commits so reachability holds for the control path.
    const latestTask = {
      repositoryRoot: archive,
      commit: dirCommit,
      path: task.path,
      blobOid: execFileSync("git", ["-C", archive, "rev-parse", `${dirCommit}:task.md`], {
        encoding: "utf8",
      }).trim(),
      sha256: sha256File("# task\n"),
    };
    const latestAuthority = {
      repositoryRoot: archive,
      commit: dirCommit,
      path: authority.path,
      blobOid: execFileSync(
        "git",
        ["-C", archive, "rev-parse", `${dirCommit}:authority.md`],
        { encoding: "utf8" },
      ).trim(),
      sha256: sha256File("# authority\n"),
    };

    const other = initGitRepo(join(root, "other"));
    // Distinct bytes so foreign commit SHAs cannot accidentally equal archive objects.
    const otherAuth = commitFile(other, "authority.md", "# other-authority\n");
    const otherTask = commitFile(other, "task.md", "# other-task\n");

    const externalPath = join(root, "external.txt");
    writeFileSync(externalPath, "external-bytes\n");
    const externalSha = sha256File("external-bytes\n");
    const committedExternal = join(archive, "committed-external.txt");
    writeFileSync(committedExternal, "committed-external\n");
    execFileSync("git", ["-C", archive, "add", "committed-external.txt"], {
      stdio: "ignore",
    });
    execFileSync("git", ["-C", archive, "commit", "-m", "committed external"], {
      stdio: "ignore",
    });
    const afterCommitHead = execFileSync("git", ["-C", archive, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
    const postCommitAuthority = {
      repositoryRoot: archive,
      commit: afterCommitHead,
      path: authority.path,
      blobOid: execFileSync(
        "git",
        ["-C", archive, "rev-parse", `${afterCommitHead}:authority.md`],
        { encoding: "utf8" },
      ).trim(),
      sha256: sha256File("# authority\n"),
    };
    const postCommitTask = {
      repositoryRoot: archive,
      commit: afterCommitHead,
      path: task.path,
      blobOid: execFileSync(
        "git",
        ["-C", archive, "rev-parse", `${afterCommitHead}:task.md`],
        { encoding: "utf8" },
      ).trim(),
      sha256: sha256File("# task\n"),
    };

    type Case = {
      label: string;
      docketId: string;
      patch?: Record<string, unknown>;
      mutate?: () => void;
      restore?: () => void;
      rawConfig?: unknown;
    };

    const cases: Case[] = [
      {
        label: "repository root is .git",
        docketId: "issues/10/apply/apply-gitdir-root",
        patch: {
          authority: {
            ...postCommitAuthority,
            repositoryRoot: join(archive, ".git"),
          },
        },
      },
      {
        label: "nested noncanonical worktree path",
        docketId: "issues/10/apply/apply-nested-root",
        patch: {
          authority: {
            ...postCommitAuthority,
            repositoryRoot: join(archive, "dirblob"),
          },
          task: postCommitTask,
        },
      },
      {
        label: "reference path contains .git",
        docketId: "issues/10/apply/apply-dotgit-path",
        patch: {
          authority: {
            ...postCommitAuthority,
            path: ".git/config",
          },
        },
      },
      {
        label: "directory supplied as blob",
        docketId: "issues/10/apply/apply-dir-blob",
        patch: {
          authority: {
            repositoryRoot: archive,
            commit: dirCommit,
            path: "dirblob",
            blobOid: execFileSync(
              "git",
              ["-C", archive, "rev-parse", `${dirCommit}:dirblob`],
              { encoding: "utf8" },
            ).trim(),
            sha256: sha256File("nested\n"),
          },
          task: latestTask,
        },
      },
      {
        label: "missing path",
        docketId: "issues/10/apply/apply-missing-path",
        patch: {
          authority: { ...postCommitAuthority, path: "missing.md" },
          task: postCommitTask,
        },
      },
      {
        label: "short commit",
        docketId: "issues/10/apply/apply-short-commit",
        patch: {
          authority: {
            ...postCommitAuthority,
            commit: postCommitAuthority.commit.slice(0, 12),
          },
          task: postCommitTask,
        },
      },
      {
        label: "malformed commit",
        docketId: "issues/10/apply/apply-bad-commit",
        patch: {
          authority: { ...postCommitAuthority, commit: "not-a-sha" },
          task: postCommitTask,
        },
      },
      {
        label: "all-zero commit",
        docketId: "issues/10/apply/apply-zero-commit",
        patch: {
          authority: { ...postCommitAuthority, commit: "0".repeat(40) },
          task: postCommitTask,
        },
      },
      {
        label: "commit from another repository",
        docketId: "issues/10/apply/apply-foreign-commit",
        patch: {
          authority: {
            repositoryRoot: archive,
            commit: otherAuth.commit,
            path: otherAuth.path,
            blobOid: otherAuth.blobOid,
            sha256: otherAuth.sha256,
          },
          task: postCommitTask,
        },
      },
      {
        label: "orphan commit not reachable from HEAD",
        docketId: "issues/10/apply/apply-orphan",
        patch: {
          authority: {
            ...postCommitAuthority,
            commit: orphanCommit,
          },
          task: postCommitTask,
        },
      },
      {
        label: "future/side commit not reachable from HEAD",
        docketId: "issues/10/apply/apply-future",
        patch: {
          authority: {
            repositoryRoot: archive,
            commit: future.commit,
            path: future.path,
            blobOid: future.blobOid,
            sha256: future.sha256,
          },
          task: postCommitTask,
        },
      },
      {
        label: "deleted referenced path",
        docketId: "issues/10/apply/apply-deleted",
        mutate: () => {
          unlinkSync(join(archive, "authority.md"));
        },
        restore: () => {
          writeFileSync(join(archive, "authority.md"), "# authority\n");
        },
        patch: {
          authority: postCommitAuthority,
          task: postCommitTask,
        },
      },
      {
        label: "untracked path claimed as reference",
        docketId: "issues/10/apply/apply-untracked",
        mutate: () => {
          writeFileSync(join(archive, "untracked.md"), "u\n");
        },
        restore: () => {
          unlinkSync(join(archive, "untracked.md"));
        },
        patch: {
          authority: {
            repositoryRoot: archive,
            commit: postCommitAuthority.commit,
            path: "untracked.md",
            blobOid: postCommitAuthority.blobOid,
            sha256: sha256File("u\n"),
          },
          task: postCommitTask,
        },
      },
      {
        label: "blob oid mismatch",
        docketId: "issues/10/apply/apply-blob-mismatch",
        patch: {
          authority: { ...postCommitAuthority, blobOid: "0".repeat(40) },
          task: postCommitTask,
        },
      },
      {
        label: "sha mismatch",
        docketId: "issues/10/apply/apply-sha-mismatch",
        patch: {
          authority: { ...postCommitAuthority, sha256: "d".repeat(64) },
          task: postCommitTask,
        },
      },
      {
        label: "missing authority",
        docketId: "issues/10/apply/apply-no-authority",
        rawConfig: {
          version: 1,
          archive: {
            repositoryRoot: archive,
            root: ".ak/dockets",
            docketId: "issues/10/apply/apply-no-authority",
          },
          execution: {
            cwd: root,
            environment: { inherit: true, overrides: {}, unset: [] },
            stdin: "inherit",
          },
          declarations: {
            gitReferences: [
              {
                id: "task",
                repositoryRoot: archive,
                commit: postCommitTask.commit,
                path: postCommitTask.path,
                blobOid: postCommitTask.blobOid,
                sha256: postCommitTask.sha256,
                kind: "task",
              },
              {
                id: "input-only",
                repositoryRoot: archive,
                commit: postCommitAuthority.commit,
                path: postCommitAuthority.path,
                blobOid: postCommitAuthority.blobOid,
                sha256: postCommitAuthority.sha256,
                kind: "input",
              },
            ],
            externalInputs: [],
            exhibits: [],
          },
          provenance: { package: null, model: null, target: null },
        },
      },
      {
        label: "missing task",
        docketId: "issues/10/apply/apply-no-task",
        rawConfig: {
          version: 1,
          archive: {
            repositoryRoot: archive,
            root: ".ak/dockets",
            docketId: "issues/10/apply/apply-no-task",
          },
          execution: {
            cwd: root,
            environment: { inherit: true, overrides: {}, unset: [] },
            stdin: "inherit",
          },
          declarations: {
            gitReferences: [
              {
                id: "authority",
                repositoryRoot: archive,
                commit: postCommitAuthority.commit,
                path: postCommitAuthority.path,
                blobOid: postCommitAuthority.blobOid,
                sha256: postCommitAuthority.sha256,
                kind: "authority",
              },
              {
                id: "input-only",
                repositoryRoot: archive,
                commit: postCommitTask.commit,
                path: postCommitTask.path,
                blobOid: postCommitTask.blobOid,
                sha256: postCommitTask.sha256,
                kind: "input",
              },
            ],
            externalInputs: [],
            exhibits: [],
          },
          provenance: { package: null, model: null, target: null },
        },
      },
      {
        label: "reserved generated id receipt",
        docketId: "issues/10/apply/apply-reserved-receipt",
        rawConfig: {
          version: 1,
          archive: {
            repositoryRoot: archive,
            root: ".ak/dockets",
            docketId: "issues/10/apply/apply-reserved-receipt",
          },
          execution: {
            cwd: root,
            environment: { inherit: true, overrides: {}, unset: [] },
            stdin: "inherit",
          },
          declarations: {
            gitReferences: [
              {
                id: "receipt",
                repositoryRoot: archive,
                commit: postCommitAuthority.commit,
                path: postCommitAuthority.path,
                blobOid: postCommitAuthority.blobOid,
                sha256: postCommitAuthority.sha256,
                kind: "authority",
              },
              {
                id: "task",
                repositoryRoot: archive,
                commit: postCommitTask.commit,
                path: postCommitTask.path,
                blobOid: postCommitTask.blobOid,
                sha256: postCommitTask.sha256,
                kind: "task",
              },
            ],
            externalInputs: [],
            exhibits: [],
          },
          provenance: { package: null, model: null, target: null },
        },
      },
      {
        label: "reserved generated id audit-observation",
        docketId: "issues/10/apply/apply-reserved-audit",
        rawConfig: {
          version: 1,
          archive: {
            repositoryRoot: archive,
            root: ".ak/dockets",
            docketId: "issues/10/apply/apply-reserved-audit",
          },
          execution: {
            cwd: root,
            environment: { inherit: true, overrides: {}, unset: [] },
            stdin: "inherit",
          },
          declarations: {
            gitReferences: [
              {
                id: "audit-observation",
                repositoryRoot: archive,
                commit: postCommitAuthority.commit,
                path: postCommitAuthority.path,
                blobOid: postCommitAuthority.blobOid,
                sha256: postCommitAuthority.sha256,
                kind: "authority",
              },
              {
                id: "task",
                repositoryRoot: archive,
                commit: postCommitTask.commit,
                path: postCommitTask.path,
                blobOid: postCommitTask.blobOid,
                sha256: postCommitTask.sha256,
                kind: "task",
              },
            ],
            externalInputs: [],
            exhibits: [],
          },
          provenance: { package: null, model: null, target: null },
        },
      },
      {
        label: "reserved generated id manifest",
        docketId: "issues/10/apply/apply-reserved-manifest",
        rawConfig: {
          version: 1,
          archive: {
            repositoryRoot: archive,
            root: ".ak/dockets",
            docketId: "issues/10/apply/apply-reserved-manifest",
          },
          execution: {
            cwd: root,
            environment: { inherit: true, overrides: {}, unset: [] },
            stdin: "inherit",
          },
          declarations: {
            gitReferences: [
              {
                id: "manifest",
                repositoryRoot: archive,
                commit: postCommitAuthority.commit,
                path: postCommitAuthority.path,
                blobOid: postCommitAuthority.blobOid,
                sha256: postCommitAuthority.sha256,
                kind: "authority",
              },
              {
                id: "task",
                repositoryRoot: archive,
                commit: postCommitTask.commit,
                path: postCommitTask.path,
                blobOid: postCommitTask.blobOid,
                sha256: postCommitTask.sha256,
                kind: "task",
              },
            ],
            externalInputs: [],
            exhibits: [],
          },
          provenance: { package: null, model: null, target: null },
        },
      },
      {
        label: "reserved generated id redaction-report",
        docketId: "issues/10/apply/apply-reserved-redaction",
        rawConfig: {
          version: 1,
          archive: {
            repositoryRoot: archive,
            root: ".ak/dockets",
            docketId: "issues/10/apply/apply-reserved-redaction",
          },
          execution: {
            cwd: root,
            environment: { inherit: true, overrides: {}, unset: [] },
            stdin: "inherit",
          },
          declarations: {
            gitReferences: [
              {
                id: "redaction-report",
                repositoryRoot: archive,
                commit: postCommitAuthority.commit,
                path: postCommitAuthority.path,
                blobOid: postCommitAuthority.blobOid,
                sha256: postCommitAuthority.sha256,
                kind: "authority",
              },
              {
                id: "task",
                repositoryRoot: archive,
                commit: postCommitTask.commit,
                path: postCommitTask.path,
                blobOid: postCommitTask.blobOid,
                sha256: postCommitTask.sha256,
                kind: "task",
              },
            ],
            externalInputs: [],
            exhibits: [],
          },
          provenance: { package: null, model: null, target: null },
        },
      },
      {
        label: "generated future path receipt.json as reference",
        docketId: "issues/10/apply/apply-future-receipt-path",
        patch: {
          authority: { ...postCommitAuthority, path: "receipt.json" },
          task: postCommitTask,
        },
      },
      {
        label: "duplicate artifact id across classes",
        docketId: "issues/10/apply/apply-dup-id",
        patch: {
          authority: postCommitAuthority,
          task: postCommitTask,
          externalInputs: [{
            id: "authority",
            sourcePath: externalPath,
            sha256: externalSha,
            kind: "input",
          }],
        },
      },
      {
        label: "duplicate canonical reference identity",
        docketId: "issues/10/apply/apply-dup-ref",
        rawConfig: {
          version: 1,
          archive: {
            repositoryRoot: archive,
            root: ".ak/dockets",
            docketId: "issues/10/apply/apply-dup-ref",
          },
          execution: {
            cwd: root,
            environment: { inherit: true, overrides: {}, unset: [] },
            stdin: "inherit",
          },
          declarations: {
            gitReferences: [
              {
                id: "authority",
                repositoryRoot: archive,
                commit: postCommitAuthority.commit,
                path: postCommitAuthority.path,
                blobOid: postCommitAuthority.blobOid,
                sha256: postCommitAuthority.sha256,
                kind: "authority",
              },
              {
                id: "task",
                repositoryRoot: archive,
                commit: postCommitTask.commit,
                path: postCommitTask.path,
                blobOid: postCommitTask.blobOid,
                sha256: postCommitTask.sha256,
                kind: "task",
              },
              {
                id: "authority-dup",
                repositoryRoot: archive,
                commit: postCommitAuthority.commit,
                path: postCommitAuthority.path,
                blobOid: postCommitAuthority.blobOid,
                sha256: postCommitAuthority.sha256,
                kind: "input",
              },
            ],
            externalInputs: [],
            exhibits: [],
          },
          provenance: { package: null, model: null, target: null },
        },
      },
      {
        label: "duplicate copied bytes across external/exhibit",
        docketId: "issues/10/apply/apply-dup-bytes",
        patch: {
          authority: postCommitAuthority,
          task: postCommitTask,
          externalInputs: [{
            id: "extra-input",
            sourcePath: externalPath,
            sha256: externalSha,
            kind: "input",
          }],
          exhibits: [{
            id: "proof",
            sourcePath: externalPath,
            sha256: externalSha,
          }],
        },
      },
      {
        label: "committed tracked source as external copy",
        docketId: "issues/10/apply/apply-committed-external",
        patch: {
          authority: postCommitAuthority,
          task: postCommitTask,
          externalInputs: [{
            id: "from-repo",
            sourcePath: committedExternal,
            sha256: sha256File("committed-external\n"),
            kind: "input",
          }],
        },
      },
      {
        label: "external digest mismatch",
        docketId: "issues/10/apply/apply-ext-digest",
        patch: {
          authority: postCommitAuthority,
          task: postCommitTask,
          externalInputs: [{
            id: "extra-input",
            sourcePath: externalPath,
            sha256: "e".repeat(64),
            kind: "input",
          }],
        },
      },
      {
        label: "unreadable external source",
        docketId: "issues/10/apply/apply-ext-missing",
        patch: {
          authority: postCommitAuthority,
          task: postCommitTask,
          externalInputs: [{
            id: "extra-input",
            sourcePath: join(root, "no-such-external.txt"),
            sha256: externalSha,
            kind: "input",
          }],
        },
      },
      {
        label: "archive/reference repository confusion",
        docketId: "issues/10/apply/apply-repo-confusion",
        patch: {
          authority: {
            repositoryRoot: archive,
            commit: otherAuth.commit,
            path: otherAuth.path,
            blobOid: otherAuth.blobOid,
            sha256: otherAuth.sha256,
          },
          task: {
            repositoryRoot: other,
            commit: otherTask.commit,
            path: otherTask.path,
            blobOid: otherTask.blobOid,
            sha256: otherTask.sha256,
          },
        },
      },
    ];

    for (const item of cases) {
      item.mutate?.();
      try {
        let configPath: string;
        if (item.rawConfig) {
          configPath = join(root, `cfg-${item.docketId.replaceAll("/", "_")}.json`);
          writeFileSync(configPath, `${JSON.stringify(item.rawConfig, null, 2)}\n`);
        } else {
          configPath = writeRecorderConfig(root, {
            archiveRepo: archive,
            cwd: root,
            docketId: item.docketId,
            authority: baseAuthority,
            task: baseTask,
            ...(item.patch ?? {}),
          } as Parameters<typeof writeRecorderConfig>[1]);
        }
        await expectAdmissionFailure({
          root,
          archive,
          configPath,
          script,
          counter,
          docketId: item.docketId,
          label: item.label,
        });
      } finally {
        item.restore?.();
      }
    }

    // Positive controls: clean committed refs and unique external copies.
    const okExternal = join(root, "ok-external.txt");
    const okExhibit = join(root, "ok-exhibit.txt");
    writeFileSync(okExternal, "ok-input\n");
    writeFileSync(okExhibit, "ok-exhibit\n");
    const okConfig = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-admit-ok",
      authority: postCommitAuthority,
      task: postCommitTask,
      externalInputs: [{
        id: "extra-input",
        sourcePath: okExternal,
        sha256: sha256File("ok-input\n"),
        kind: "input",
      }],
      exhibits: [{
        id: "proof",
        sourcePath: okExhibit,
        sha256: sha256File("ok-exhibit\n"),
      }],
    });
    const beforeSpawns = spawnCount(counter);
    const ok = await runRecorderBin(
      ["--config", okConfig, "--", process.execPath, script, "ok"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(spawnCount(counter), beforeSpawns + 1);
    assert.equal(
      existsSync(join(archive, ".ak/dockets/issues/10/apply/apply-admit-ok/manifest.json")),
      true,
    );

    // Cross-repository success control.
    const cross = writeRecorderConfig(root, {
      archiveRepo: archive,
      cwd: root,
      docketId: "issues/10/apply/apply-crossref-ok",
      authority: {
        repositoryRoot: other,
        commit: otherAuth.commit,
        path: otherAuth.path,
        blobOid: otherAuth.blobOid,
        sha256: otherAuth.sha256,
      },
      task: {
        repositoryRoot: other,
        commit: otherTask.commit,
        path: otherTask.path,
        blobOid: otherTask.blobOid,
        sha256: otherTask.sha256,
      },
    });
    const crossOk = await runRecorderBin(
      ["--config", cross, "--", process.execPath, script, "ok"],
      { cwd: root, env: { ...process.env, AK_RECORDER_COUNTER: counter } },
    );
    assert.equal(crossOk.code, 0, crossOk.stderr);

    void latestAuthority;
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
