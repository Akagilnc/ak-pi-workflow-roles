/** #369 submission-seam gates ①② + upgrade uninstall — real arm/assertAcceptable entry. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";

import { runAkRole } from "../../src/public-cli/cli.ts";
import {
  buildNavigatorInfrastructureFailureFact,
  FIXER_OUTPUT_TOOL_NAME,
} from "../../src/role-runtime.ts";
import { createRecordSession } from "../../src/sitian-record-entry.ts";
import {
  createWorkerSubmissionGate,
  WorkerCommitReminderError,
  WorkerPrefixReminderError,
  WorkerUnfinishedReasonReminderError,
  WORKER_COMMIT_BASELINE_ENTRY_TYPE,
  WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE,
  WORKER_PREFIX_REMINDER_BOUNCE_ENTRY_TYPE,
  WORKER_SUBMISSION_GATE_RECORD_KIND,
} from "../../src/worker-submission-gates.ts";
import {
  machineLedgerHome,
  packageRoot,
  resolvePackageEntrypoint,
  seedGitRepository,
  withHermeticHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";

const FACTORY = "ak-roles:";
const OWNED_MARKER = "ak-roles: worker-submission-gates reference-transaction";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function tempGitRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ak-worker-gate-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "gate@test.local"]);
  git(root, ["config", "user.name", "Gate Test"]);
  git(root, ["commit", "--allow-empty", "-m", "seed"]);
  return root;
}

async function tempUnborn(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "ak-worker-gate-unborn-"));
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "gate@test.local"]);
  git(root, ["config", "user.name", "Gate Test"]);
  return root;
}

function plantOwnedHooks(cwd: string): { hooksDir: string; hookPath: string } {
  git(cwd, ["config", "extensions.worktreeConfig", "true"]);
  const gitDir = git(cwd, ["rev-parse", "--path-format=absolute", "--git-dir"]);
  const hooksDir = join(gitDir, "ak-roles-hooks");
  const hookPath = join(hooksDir, "reference-transaction");
  mkdirSync(hooksDir, { recursive: true });
  writeFileSync(hookPath, `#!/bin/sh\n# ${OWNED_MARKER}\nexit 0\n`, "utf8");
  chmodSync(hookPath, 0o755);
  git(cwd, ["config", "--worktree", "core.hooksPath", hooksDir]);
  return { hooksDir, hookPath };
}

function hooksPathOf(cwd: string): string | undefined {
  try {
    return git(cwd, ["config", "--get", "core.hooksPath"]);
  } catch {
    return undefined;
  }
}

test("unfinished reason gate bounces missing reason up to twice then accepts; reasoned unfinished free; other statuses unchanged", () => {
  const gate = createWorkerSubmissionGate();
  assert.throws(
    () => gate.assertAcceptable("unfinished", {}),
    (error: unknown) =>
      error instanceof WorkerUnfinishedReasonReminderError &&
      error.code === "worker_unfinished_reason_reminder" &&
      error.message === "补理由（前置缺失/违宪之一）或继续施工",
  );
  assert.throws(() => gate.assertAcceptable("unfinished", { reason: "   " }), WorkerUnfinishedReasonReminderError);
  assert.doesNotThrow(() =>
    gate.assertAcceptable("unfinished", {
      reason: "prerequisite_missing: pending owner decision on adapter scope",
    }),
  );
  const loop = createWorkerSubmissionGate();
  assert.throws(() => loop.assertAcceptable("unfinished", {}), WorkerUnfinishedReasonReminderError);
  assert.throws(() => loop.assertAcceptable("unfinished", {}), WorkerUnfinishedReasonReminderError);
  assert.doesNotThrow(() => loop.assertAcceptable("unfinished", {}));
  assert.doesNotThrow(() => loop.assertAcceptable("planned"));
  assert.doesNotThrow(() => loop.assertAcceptable("refused"));
});

test("① completed/partially_completed zero-commit bounces once then confirm; other statuses free; git failure surfaces; unborn is no-commit", async () => {
  const root = await tempGitRepo();
  const bare = await mkdtemp(join(tmpdir(), "ak-worker-gate-bare-"));
  try {
    const gate = createWorkerSubmissionGate();
    gate.arm(root);
    for (const status of ["planned", "refused"] as const) {
      assert.doesNotThrow(() => gate.assertAcceptable(status), status);
    }
    assert.doesNotThrow(() =>
      gate.assertAcceptable("unfinished", { reason: "unconstitutional: task contradicts ADR 0055" }),
    );
    assert.throws(
      () => gate.assertAcceptable("completed"),
      (error: unknown) =>
        error instanceof WorkerCommitReminderError &&
        error.code === "worker_commit_reminder" &&
        error.message === "未观察到 commit",
    );
    assert.doesNotThrow(() => gate.assertAcceptable("completed"));
    const g2 = createWorkerSubmissionGate();
    g2.arm(root);
    assert.throws(() => g2.assertAcceptable("partially_completed"), WorkerCommitReminderError);
    git(root, ["commit", "--allow-empty", "-m", `${FACTORY} work`]);
    const g3 = createWorkerSubmissionGate();
    g3.arm(root);
    git(root, ["commit", "--allow-empty", "-m", `${FACTORY} more`]);
    assert.doesNotThrow(() => g3.assertAcceptable("completed"));

    assert.throws(() => createWorkerSubmissionGate().arm(bare), /not a git repository/);

    const unborn = await tempUnborn();
    try {
      const g = createWorkerSubmissionGate();
      g.arm(unborn);
      assert.throws(() => g.assertAcceptable("completed"), WorkerCommitReminderError);
    } finally {
      await rm(unborn, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(bare, { recursive: true, force: true });
  }
});

test("② missing prefix bounces once then confirm; open set + merge exempt; unreliable window skipped; status matrix free", async () => {
  const root = await tempGitRepo();
  try {
    const missing = createWorkerSubmissionGate();
    missing.arm(root);
    git(root, ["commit", "--allow-empty", "-m", "forgot the platform prefix"]);
    assert.throws(
      () => missing.assertAcceptable("completed"),
      (error: unknown) =>
        error instanceof WorkerPrefixReminderError &&
        error.code === "worker_prefix_reminder" &&
        error.message === "观察到缺前缀 commit，请重写后再交",
    );
    assert.doesNotThrow(() => missing.assertAcceptable("completed"));

    // Open set: not ak-roles: singleton; no conventional-type blacklist.
    for (const subject of [
      "claude: docs lawful open prefix",
      "feat: conventional type is not blacklisted",
      `${FACTORY} factory sample`,
    ]) {
      const g = createWorkerSubmissionGate();
      g.arm(root);
      git(root, ["commit", "--allow-empty", "-m", subject]);
      assert.doesNotThrow(() => g.assertAcceptable("completed"), subject);
    }

    // Merge commit exempt (GitHub merge shape, unprefixed subject).
    const mergeRepo = await tempGitRepo();
    try {
      const g = createWorkerSubmissionGate();
      g.arm(mergeRepo);
      git(mergeRepo, ["checkout", "-b", "topic"]);
      git(mergeRepo, ["commit", "--allow-empty", "-m", `${FACTORY} topic tip`]);
      git(mergeRepo, ["checkout", "main"]);
      git(mergeRepo, ["commit", "--allow-empty", "-m", `${FACTORY} main tip`]);
      git(mergeRepo, ["merge", "--no-ff", "-m", "Merge pull request #1 from topic", "topic"]);
      assert.doesNotThrow(() => g.assertAcceptable("completed"));
    } finally {
      await rm(mergeRepo, { recursive: true, force: true });
    }

    // planned / refused / unfinished never fire gate ②.
    const free = createWorkerSubmissionGate();
    free.arm(root);
    git(root, ["commit", "--allow-empty", "-m", "still missing prefix"]);
    assert.doesNotThrow(() => free.assertAcceptable("planned"));
    assert.doesNotThrow(() => free.assertAcceptable("refused"));
    assert.doesNotThrow(() =>
      free.assertAcceptable("unfinished", { reason: "prerequisite_missing: owner decision" }),
    );

    // baseline tip not ancestor of HEAD → unreliable → no prefix bounce.
    const unrelated = await tempGitRepo();
    try {
      const g = createWorkerSubmissionGate();
      g.arm(unrelated);
      git(unrelated, ["checkout", "--orphan", "other"]);
      git(unrelated, ["commit", "--allow-empty", "-m", "orphan tip without prefix"]);
      assert.doesNotThrow(() => g.assertAcceptable("completed"));
    } finally {
      await rm(unrelated, { recursive: true, force: true });
    }

    // Unborn positive: null baseline → first unprefixed commit → bounce once → confirm.
    const unbornPos = await tempUnborn();
    try {
      const g = createWorkerSubmissionGate();
      g.arm(unbornPos);
      git(unbornPos, ["commit", "--allow-empty", "-m", "first commit no prefix"]);
      assert.throws(() => g.assertAcceptable("completed"), WorkerPrefixReminderError);
      assert.doesNotThrow(() => g.assertAcceptable("completed"));
    } finally {
      await rm(unbornPos, { recursive: true, force: true });
    }

    // Unborn negative: zero commits → gate ① only.
    const unbornNeg = await tempUnborn();
    try {
      const g = createWorkerSubmissionGate();
      g.arm(unbornNeg);
      assert.throws(() => g.assertAcceptable("completed"), WorkerCommitReminderError);
      assert.doesNotThrow(() => g.assertAcceptable("completed"));
    } finally {
      await rm(unbornNeg, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("arm stops writing hooks and idempotently uninstalls package-owned traces only", async () => {
  const root = await tempGitRepo();
  const stranger = await tempGitRepo();
  try {
    const beforeLocal = git(root, ["config", "--local", "--list"]);
    createWorkerSubmissionGate().arm(root);
    assert.equal(git(root, ["config", "--local", "--list"]), beforeLocal);
    assert.equal(hooksPathOf(root), undefined);
    const gitDir = git(root, ["rev-parse", "--path-format=absolute", "--git-dir"]);
    assert.equal(existsSync(join(gitDir, "ak-roles-hooks")), false);

    const { hooksDir, hookPath } = plantOwnedHooks(root);
    assert.ok(existsSync(hookPath));
    const worktreeConfigBefore = git(root, ["config", "--local", "--get", "extensions.worktreeConfig"]);
    createWorkerSubmissionGate().arm(root);
    assert.equal(hooksPathOf(root), undefined);
    assert.equal(existsSync(hooksDir), false);
    assert.equal(git(root, ["config", "--local", "--get", "extensions.worktreeConfig"]), worktreeConfigBefore);
    assert.doesNotThrow(() => createWorkerSubmissionGate().arm(root));

    // Unmarked same-named dir must survive; hooksPath to non-owned dir stays.
    const foreignDir = join(gitDir, "ak-roles-hooks");
    const foreignHook = join(foreignDir, "reference-transaction");
    mkdirSync(foreignDir, { recursive: true });
    writeFileSync(foreignHook, "#!/bin/sh\n# foreign hook body\nexit 0\n", "utf8");
    git(root, ["config", "extensions.worktreeConfig", "true"]);
    git(root, ["config", "--worktree", "core.hooksPath", foreignDir]);
    createWorkerSubmissionGate().arm(root);
    assert.ok(existsSync(foreignHook), "unmarked same-named dir must survive");
    assert.equal(hooksPathOf(root), foreignDir);
    git(root, ["config", "--worktree", "--unset", "core.hooksPath"]);

    // Migrated core.bare / core.worktree stay (real path — fake path bricks git).
    const commonDir = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const mainWtConfig = join(commonDir, "config.worktree");
    writeFileSync(mainWtConfig, `[core]\n\tbare = false\n\tworktree = ${root}\n`, "utf8");
    plantOwnedHooks(root);
    createWorkerSubmissionGate().arm(root);
    const preserved = readFileSync(mainWtConfig, "utf8");
    assert.match(preserved, /bare\s*=\s*false/);
    assert.ok(preserved.includes(`worktree = ${root}`));
    assert.doesNotMatch(preserved, /hooksPath/);

    // Linked worktree owned hooks cleared with served repo.
    const wt = join(root, "wt-linked");
    git(root, ["worktree", "add", wt, "HEAD"]);
    const plantedWt = plantOwnedHooks(wt);
    createWorkerSubmissionGate().arm(root);
    assert.equal(hooksPathOf(wt), undefined);
    assert.equal(existsSync(plantedWt.hooksDir), false);

    // Unrelated repo out of discoverable range.
    const plantedStranger = plantOwnedHooks(stranger);
    createWorkerSubmissionGate().arm(root);
    assert.equal(hooksPathOf(stranger), plantedStranger.hooksDir);
    assert.ok(existsSync(plantedStranger.hookPath));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(stranger, { recursive: true, force: true });
  }
});

test("①② durability via real createRecordSession survives resume; no second false bounce", async () => {
  await withHermeticHome({ prefix: "ak-worker-gate-durable-" }, async ({ home }) => {
    async function parentSession(book: string, run: string, cwd: string): Promise<SessionManager> {
      const dir = join(machineLedgerHome(home), "books", book, "runs", "activation", run);
      await mkdir(dir, { recursive: true });
      const file = join(dir, "session.jsonl");
      await writeFile(
        file,
        `${JSON.stringify({
          type: "session",
          version: 3,
          id: run,
          timestamp: "2025-01-01T00:00:00.000Z",
          cwd,
        })}\n`,
      );
      return SessionManager.open(file);
    }

    const project = join(home, "proj");
    await mkdir(project, { recursive: true });
    seedGitRepository(project);
    git(project, ["config", "user.email", "gate@test.local"]);
    git(project, ["config", "user.name", "Gate Test"]);
    git(project, ["commit", "--allow-empty", "-m", "seed"]);
    const baselineHead = git(project, ["rev-parse", "HEAD"]);
    const parent = await parentSession("proj", "worker-run", project);

    const first = createWorkerSubmissionGate();
    first.arm(project, parent);
    assert.throws(() => first.assertAcceptable("completed"), WorkerCommitReminderError);

    const nest = join(dirname(parent.getSessionFile()!), WORKER_SUBMISSION_GATE_RECORD_KIND);
    const files = readdirSync(nest).filter((n) => n.endsWith(".jsonl"));
    assert.equal(files.length, 1);
    const gatePath = join(nest, files[0]!);
    const body = readFileSync(gatePath, "utf8");
    assert.match(body, new RegExp(WORKER_COMMIT_BASELINE_ENTRY_TYPE));
    assert.match(body, new RegExp(WORKER_COMMIT_REMINDER_BOUNCE_ENTRY_TYPE));
    assert.match(body, new RegExp(baselineHead));

    git(project, ["commit", "--allow-empty", "-m", `${FACTORY} after bounce`]);
    const bytesBefore = readFileSync(gatePath);
    const resumed = createWorkerSubmissionGate();
    resumed.arm(project, parent);
    assert.equal(readdirSync(nest).filter((n) => n.endsWith(".jsonl")).length, 1);
    assert.equal(Buffer.compare(bytesBefore, readFileSync(gatePath)), 0);
    assert.doesNotThrow(() => resumed.assertAcceptable("completed"));

    // Ordinary no-subject children mint fresh sessions (ADR 0065 caller-identity).
    const evidenceA = createRecordSession({ cwd: project, kind: "evidence-children", parent });
    evidenceA.appendCustomEntry("evidence-probe", { n: 1 });
    const evidenceB = createRecordSession({ cwd: project, kind: "evidence-children", parent });
    assert.notEqual(evidenceB.getSessionFile(), evidenceA.getSessionFile());
    const auditorA = createRecordSession({ cwd: project, kind: "auditor-roles", parent });
    const auditorB = createRecordSession({ cwd: project, kind: "auditor-roles", parent });
    assert.notEqual(auditorA.getSessionFile(), auditorB.getSessionFile());

    // ② durable prefix bounce survives resume.
    const projectP = join(home, "proj-prefix");
    await mkdir(projectP, { recursive: true });
    seedGitRepository(projectP);
    git(projectP, ["config", "user.email", "gate@test.local"]);
    git(projectP, ["config", "user.name", "Gate Test"]);
    git(projectP, ["commit", "--allow-empty", "-m", "seed-p"]);
    const parentP = await parentSession("proj-prefix", "worker-run-prefix", projectP);
    const prefixFirst = createWorkerSubmissionGate();
    prefixFirst.arm(projectP, parentP);
    git(projectP, ["commit", "--allow-empty", "-m", "no prefix on durable path"]);
    assert.throws(() => prefixFirst.assertAcceptable("completed"), WorkerPrefixReminderError);
    const nestP = join(dirname(parentP.getSessionFile()!), WORKER_SUBMISSION_GATE_RECORD_KIND);
    assert.match(
      readFileSync(join(nestP, readdirSync(nestP).filter((n) => n.endsWith(".jsonl"))[0]!), "utf8"),
      new RegExp(WORKER_PREFIX_REMINDER_BOUNCE_ENTRY_TYPE),
    );
    const prefixResumed = createWorkerSubmissionGate();
    prefixResumed.arm(projectP, parentP);
    assert.doesNotThrow(() => prefixResumed.assertAcceptable("completed"));

    // Same HEAD after durable bounce → confirm, no second fire.
    const project2 = join(home, "proj2");
    await mkdir(project2, { recursive: true });
    seedGitRepository(project2);
    git(project2, ["config", "user.email", "gate@test.local"]);
    git(project2, ["config", "user.name", "Gate Test"]);
    git(project2, ["commit", "--allow-empty", "-m", "seed2"]);
    const parent2 = await parentSession("proj2", "worker-run-2", project2);
    const a = createWorkerSubmissionGate();
    a.arm(project2, parent2);
    assert.throws(() => a.assertAcceptable("completed"), WorkerCommitReminderError);
    const b = createWorkerSubmissionGate();
    b.arm(project2, parent2);
    assert.doesNotThrow(() => b.assertAcceptable("completed"));
    assert.doesNotThrow(() => b.assertAcceptable("partially_completed"));

    // EACCES on gate record → public CLI settles terminal failure through real hostActions.
    const projectF = join(home, "proj-f-eacces");
    await mkdir(projectF, { recursive: true });
    seedGitRepository(projectF);
    git(projectF, ["config", "user.email", "gate@test.local"]);
    git(projectF, ["config", "user.name", "Gate Test"]);
    git(projectF, ["commit", "--allow-empty", "-m", "seed-f"]);
    const callIdF = "fixer-eacces";
    const completed = {
      status: "completed" as const,
      report: "done",
      classResults: [{
        name: "Contract",
        disposition: "completed" as const,
        searchScope: "all",
        exceptions: [] as Array<{ where: string; reason: string }>,
        commitSha: "a".repeat(40),
      }],
    };
    const stdout: string[] = [];
    const stderr: string[] = [];
    const prevExitF = process.exitCode;
    process.exitCode = undefined;
    let result: Awaited<ReturnType<typeof runAkRole>>;
    try {
      const agentDirF = join(home, ".pi-agent-eacces");
      await mkdir(agentDirF, { recursive: true });
      result = await runAkRole(
        ["fixer", "--project", projectF, "Exercise gate EACCES durability."],
        {
          packageRoot,
          home,
          agentDir: agentDirF,
          cwd: projectF,
          createRunId: () => "run-gate-eacces-001",
          io: {
            stdout: (t: string) => { stdout.push(t); },
            stderr: (t: string) => { stderr.push(t); },
          },
          piRunner: async (args, options) => {
            const sessionFile = args[args.indexOf("--session") + 1]!;
            const sessionDir = args[args.indexOf("--session-dir") + 1]!;
            const packetPath = args[args.indexOf("--ak-fix-packet") + 1]!;
            const agentDir = typeof options.env.PI_CODING_AGENT_DIR === "string"
              ? options.env.PI_CODING_AGENT_DIR
              : agentDirF;
            const parentF = SessionManager.open(sessionFile, sessionDir, projectF);
            createWorkerSubmissionGate().arm(projectF, parentF);
            const nestF = join(dirname(sessionFile), WORKER_SUBMISSION_GATE_RECORD_KIND);
            const filesF = readdirSync(nestF).filter((n) => n.endsWith(".jsonl"));
            assert.equal(filesF.length, 1);
            chmodSync(join(nestF, filesF[0]!), 0o444);
            const faux = fauxProvider({
              api: "ak-gate-eacces",
              provider: "ak-gate-eacces",
              tokenSize: { min: 1000, max: 1000 },
            });
            faux.setResponses([
              fauxAssistantMessage(
                fauxToolCall(FIXER_OUTPUT_TOOL_NAME, completed, { id: callIdF }),
                { stopReason: "toolUse" },
              ),
            ]);
            await withInProcessPi({
              cwd: projectF,
              agentDir,
              faux,
              sessionManager: SessionManager.open(sessionFile, sessionDir, projectF),
              additionalExtensionPaths: [resolvePackageEntrypoint()],
              systemPrompt: "GATE EACCES DURABILITY",
              mode: "json",
              flags: {
                "ak-role": "fixer",
                "ak-fixer-phase": "apply",
                "ak-fix-packet": packetPath,
              },
              noTools: "builtin",
              reviewerShutdown: true,
            }, async ({ session }) => {
              await session.prompt("Exercise gate EACCES durability.").catch(() => undefined);
            });
            return {
              code: typeof process.exitCode === "number" ? process.exitCode : 0,
              stderr: "",
              timedOut: false,
              args: [...args],
            };
          },
        },
      );
    } finally {
      process.exitCode = prevExitF;
    }

    assert.equal(result.exitCode, 1, stdout.join("") || stderr.join("") || "public CLI must exit nonzero");
    assert.ok(result.terminal);
    assert.equal(result.terminal!.roleOutcome.kind, "failure");
    if (result.terminal!.roleOutcome.kind === "failure") {
      assert.equal(result.terminal!.roleOutcome.cause, "output");
      assert.match(result.terminal!.roleOutcome.diagnostic, /EACCES/);
      assert.deepEqual(result.terminal!.roleOutcome.decisiveFacts.secondaryEvidence, {
        ...buildNavigatorInfrastructureFailureFact(),
        exitCode: 1,
      });
      assert.equal(result.terminal!.roleOutcome.decisiveFacts.errorName, FIXER_OUTPUT_TOOL_NAME);
      assert.equal(result.terminal!.roleOutcome.decisiveFacts.errorCode, callIdF);
    }
  });
});
