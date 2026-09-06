import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionError } from "@earendil-works/pi-coding-agent";
import {
  ACCEPTED_ACTIVATION_EVENT,
  ActivationGitRepositoryRequiredError,
  ActivationLedgerError,
  activationWaitingLedgerPath,
  appendAcceptedActivationFact,
  buildAcceptedActivationFact,
  durableSessionPointer,
  resolveActivationLedgerHome,
  resolveBookKeyFromGit,
  type AcceptedActivationFact,
  type ToolExecutionObservationRecord,
} from "../../src/role-runtime.ts";
import { type ActivationTraceRecord } from "../../src/activation-trace.ts";
import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";
import {
  buildDispatchStubFact,
  reconcileInvocation,
} from "../../src/activation-reconciliation.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import { TERMINATING_TOOL_NAMES } from "../../src/package-contracts/terminating-tools.ts";
import {
  createFakeGitHubTransport,
  samplePull,
  sampleUser,
} from "../helpers/fake-github-transport.ts";
import {
  activationBookKeyFor,
  machineLedgerHome,
  packageRoot,
  persistActivationSessionFile,
  readAcceptedActivationFacts,
  withActivationHome,
} from "../helpers/pi-test-harness.ts";
import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";

import { DOCTOR_EVIDENCE_TOOL_NAME } from "../../src/doctor-contracts.ts";
import { createNavigatorPrepareTool, NAVIGATOR_PREPARE_TOOL_NAME } from "../../src/navigator-attendance.ts";

function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function mergerMaterial(text: string) {
  const bytes = Buffer.from(text, "utf8");
  return { bytesBase64: bytes.toString("base64"), sha256: sha256Hex(bytes) };
}
const emptyDoctorCost = {
  invocations: { count: 0, sources: [] as string[] },
  legs: { count: 0, sources: [] as string[] },
  modelApiTurns: { count: 0, sources: [] as string[] },
  outputTokens: { count: 0, sources: [] as string[] },
  toolCalls: { count: 0, sources: [] as string[] },
  retries: { count: 0, sources: [] as string[], evidence: "literal run-dir naming" as const },
  statuses: [] as Array<{ source: string; status: string }>,
  commits: [] as Array<{ source: string; commit: string }>,
  sessions: [] as Array<{ source: string; completion: "incomplete" }>,
  outputBytes: {
    count: 0,
    sources: [] as string[],
    payload: "raw JSONL bytes" as const,
    providerWireBytes: "unavailable" as const,
  },
};

const originalExitCode = process.exitCode;
afterEach(() => { process.exitCode = originalExitCode; });

/** Role load stubs already owned by production RoleRuntimeDependencies — not ledger hooks. */
function admissionDepsForRole(role: string, fixtureRoot: string): Parameters<typeof createRoleRuntimeExtension>[0] {
  const law = async () => "LAW";
  const oid = (ch: string) => ch.repeat(40);
  const base = {
    loadJudgeSoul: law,
    auditSoulCompliance: async () => ({ status: "pass" as const }),
    activationClock: () => "2025-06-01T12:00:00.000Z",
    activationTraceWriter: () => {},
  };
  switch (role) {
    case "judge":
      return base;
    case "fixer":
      return { ...base, loadFixerSoul: law, loadFixPacket: async () => "Repair the findings.\n" };
    case "coder":
      return { ...base, loadCoderSoul: law, loadCoderTask: async () => "Build it.\n" };
    case "reviewer":
      return {
        ...base,
        loadReviewerSoul: law,
        createReviewerPinnedGitReader: async () => {
          const pin = {
            repositoryRoot: fixtureRoot,
            objectFormat: "sha1" as const,
            targetHead: oid("9"),
            refs: { "refs/heads/main": { objectId: oid("9"), peeledCommitId: oid("9") } },
          };
          // Pinned-target Spec path for unique production discovery (two-axis fixture).
          return {
            pin,
            snapshot: async () => pin,
            resolve: async () => oid("8"),
            range: async () => ({
              base: oid("8"),
              target: oid("9"),
              diffCommand: `git diff ${oid("8")}...${oid("9")}`,
              diffSha256: "2".repeat(64),
              commits: [oid("9")],
            }),
            featureTokens: async () => Object.freeze(["feature-login"]),
            listSpecCandidatePaths: async () => Object.freeze(["docs/feature-login.md"]),
            originRepository: async () => undefined,
            commitMessagesNewestFirst: async () => Object.freeze([]),
            readPinnedText: async () => undefined,
          };
        },
        loadCanonicalSkillBinding: async (name) => {
          const raw = "# skill\n";
          return {
            name,
            snapshot: {
              raw,
              path: "/skill",
              baseDir: "/",
              body: raw,
              snapshotIdentity: Object.freeze({ text: raw }),
            },
            invocation: (original: string) => `/skill:${name} ${original}`,
            captureExpansion: () => undefined,
          };
        },
        // Activation stage owns fixed two-axis dispatch (issue #236 lifecycle).
        runReviewerDispatch: async (execution) => {
          const pin = {
            repositoryRoot: fixtureRoot,
            objectFormat: "sha1" as const,
            targetHead: oid("9"),
            refs: { "refs/heads/main": { objectId: oid("9"), peeledCommitId: oid("9") } },
          };
          const usage = {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          };
          const standardsLeg = execution.legs.find((leg) => leg.axis === "standards");
          const specLeg = execution.legs.find((leg) => leg.axis === "spec");
          if (standardsLeg === undefined || specLeg === undefined) {
            throw new Error("fixture expects fixed two-axis dispatch");
          }
          const success = (prompt: string) => Object.freeze({
            status: "successful" as const,
            report: "ok",
            usage,
            target: pin,
            prompt,
            workspaceDisposition: "deleted" as const,
          });
          return Object.freeze({
            identity: execution.identity,
            target: pin,
            legs: Object.freeze({
              standards: success(standardsLeg.prompt),
              spec: success(specLeg.prompt),
            }),
          });
        },
      };
    case "collector":
      return {
        ...base,
        loadCollectorSoul: law,
        createCollectorTransport: () => createFakeGitHubTransport({
          user: sampleUser(),
          pullRequest: samplePull(),
          reviews: [],
          issueComments: [],
          reviewComments: [],
        }),
      };
    case "doctor":
      return {
        ...base,
        loadDoctorSoul: law,
        loadDoctorCase: async () => ({
          version: 1 as const,
          identity: { issueNumber: 1, runsPath: "/lawful/case" },
          cost: emptyDoctorCost,
          evidence: [],
        }),
        auditDoctorCompliance: async () => ({ status: "pass" as const }),
      };
    case "merger": {
      const mergerInput = {
        version: 1 as const,
        attemptId: "attempt-1",
        targetObjectId: oid("a"),
        sourceObjectId: oid("b"),
        expectedConflictPaths: ["conflict.txt"],
        resolutionScope: ["conflict.txt"],
        authorizedChecks: [{ name: "test", argv: ["npm", "test"] }],
        materials: {
          task: mergerMaterial("task"),
          authority: mergerMaterial("authority"),
          targetIntent: mergerMaterial("target intent"),
          sourceIntent: mergerMaterial("source intent"),
        },
      };
      return {
        ...base,
        loadMergerSoul: law,
        loadMergerInput: async () => mergerInput,
        createMergerGitState: () => ({
          activeMerge: async () => ({
            targetObjectId: oid("a"),
            sourceObjectId: oid("b"),
            unmergedPaths: ["conflict.txt"],
            automaticMergeTreeId: oid("c"),
          }),
          completedMerge: async () => { throw new Error("unused"); },
        }),
      };
    }
    case "notary":
      return {
        ...base,
        loadNotarySoul: law,
        loadNotarySourceRun: async (path: string) => ({
          runDirectory: path,
          runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
          role: "judge",
        }),
      };
    case "countersign":
      return { ...base, loadCountersignSoul: law };
    case "gleaner-left":
      return { ...base, loadGleanerLeftSoul: law };
    case "inspector":
      return { ...base, loadInspectorSoul: law };
    case "gatekeeper":
      return { ...base, loadGatekeeperSoul: law };
    case "navigator":
      return { ...base, loadNavigatorSoul: law };
    default:
      throw new Error(`unexpected packaged role: ${role}`);
  }
}

function admissionFlagsForRole(role: string, fixtureRoot: string): Record<string, unknown> {
  switch (role) {
    case "judge":
      return {};
    case "fixer":
      return { "ak-fixer-phase": "plan", "ak-fix-packet": "/lawful/packet.md" };
    case "coder":
      return { "ak-coder-phase": "plan", "ak-coder-task": "/lawful/task.md" };
    case "reviewer":
      return {
        "ak-review-base": "main~1",
      };
    case "collector":
      return {
        "ak-collector-repo": "acme/widgets",
        "ak-collector-pr": "1",
      };
    case "doctor":
      return { "ak-doctor-case": "/lawful/case" };
    case "merger":
      return { "ak-merger-input": "/lawful/merger.json" };
    case "notary":
      return { "ak-notary-source-run": "/lawful/01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge" };
    case "gleaner-left":
      return { "ak-gleaner-left-base": "HEAD" };
    default:
      return {};
  }
}

test("book key follows git common-dir host basename across worktrees, rename, and basename collision", () => {
  const root = mkdtempSync(worktreeTempPrefix("ak-book-topo-"));
  try {
    const main = join(root, "project-alpha");
    mkdirSync(main);
    execFileSync("git", ["init", "-b", "main"], { cwd: main, stdio: "ignore" });
    execFileSync("git", ["commit", "--allow-empty", "-m", "init"], {
      cwd: main,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" },
    });
    const worktree = join(root, "project-alpha-wt");
    execFileSync("git", ["worktree", "add", worktree], { cwd: main, stdio: "ignore" });
    assert.equal(resolveBookKeyFromGit(main), "project-alpha");
    assert.equal(resolveBookKeyFromGit(worktree), "project-alpha");

    const renamed = join(root, "project-beta");
    renameSync(main, renamed);
    assert.equal(resolveBookKeyFromGit(renamed), "project-beta");

    const twin = join(root, "collision", "project-beta");
    mkdirSync(join(root, "collision"), { recursive: true });
    mkdirSync(twin);
    execFileSync("git", ["init", "-b", "main"], { cwd: twin, stdio: "ignore" });
    assert.equal(resolveBookKeyFromGit(twin), "project-beta");
    assert.equal(resolveBookKeyFromGit(renamed), resolveBookKeyFromGit(twin));

    // Non-git cwd must loudly reject even when GIT_DIR points at another repository.
    // Isolation root must sit outside this worktree's upward Git discovery; /tmp
    // named root is not deleted (owner 2026-09-06 directory boundary).
    const nonGit = mkdtempSync(join("/tmp", "ak-book-topo-nongit-"));
    const previousGitDir = process.env.GIT_DIR;
    const previousGitCommon = process.env.GIT_COMMON_DIR;
    const previousGitWorkTree = process.env.GIT_WORK_TREE;
    try {
      process.env.GIT_DIR = join(renamed, ".git");
      process.env.GIT_COMMON_DIR = join(renamed, ".git");
      process.env.GIT_WORK_TREE = renamed;
      assert.throws(
        () => resolveBookKeyFromGit(nonGit),
        (error: unknown) => {
          assert.ok(error instanceof ActivationGitRepositoryRequiredError);
          assert.equal(error.code, "AK_ACTIVATION_GIT_REPOSITORY_REQUIRED");
          assert.ok(error.cause !== undefined, "original git cause must be retained");
          return true;
        },
      );
    } finally {
      if (previousGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = previousGitDir;
      if (previousGitCommon === undefined) delete process.env.GIT_COMMON_DIR;
      else process.env.GIT_COMMON_DIR = previousGitCommon;
      if (previousGitWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = previousGitWorkTree;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("git spawn infrastructure failures retain identity and do not masquerade as non-git", () => {
  const root = mkdtempSync(worktreeTempPrefix("ak-book-infra-"));
  // Non-git control cwd must sit outside this worktree; /tmp named root is not deleted.
  const nonGitCwd = mkdtempSync(join("/tmp", "ak-book-infra-nongit-"));
  try {
    const cwd = join(root, "workspace");
    mkdirSync(cwd);
    // Empty PATH makes spawn of `git` fail with ENOENT — infrastructure, not non-git cwd.
    const emptyBin = join(root, "empty-bin");
    mkdirSync(emptyBin);
    const previousPath = process.env.PATH;
    try {
      process.env.PATH = emptyBin;
      assert.throws(
        () => resolveBookKeyFromGit(cwd),
        (error: unknown) => {
          assert.equal(
            error instanceof ActivationGitRepositoryRequiredError,
            false,
            "ENOENT must not become ActivationGitRepositoryRequiredError",
          );
          assert.ok(error !== null && typeof error === "object" && "code" in error);
          assert.equal((error as NodeJS.ErrnoException).code, "ENOENT");
          return true;
        },
      );
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }

    // Control: a real git child that exits nonzero remains the typed non-git error.
    assert.throws(
      () => resolveBookKeyFromGit(nonGitCwd),
      (error: unknown) => {
        assert.ok(error instanceof ActivationGitRepositoryRequiredError);
        assert.equal(error.code, "AK_ACTIVATION_GIT_REPOSITORY_REQUIRED");
        assert.ok(error.cause !== undefined);
        const cause = error.cause as { status?: unknown };
        assert.equal(typeof cause.status, "number");
        assert.notEqual(cause.status, 0);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// #685: two real multi-process ledger race cases culled (8+8 O_APPEND mixed producers;
// 16-worker first-time mkdir race). Race-dedicated production proof 未结 — see
// docs/research/issue-685-c3-deleted-contract-handoff.md. Symlink escape matrix
// below stays as deterministic call-input negative without multi-worker spawn.

// Symlink escape matrix (#420 整改并一)：四条同根同形「ledger append 拒绝符号链接
// 逃逸且不写出界」——root home 链、跨簿 waiting.jsonl、跨簿目录、books 组件——
// 收成一条四向量表。ADR 0065 的 principal 不做卷宗放置检查断言随迁保留。
test("ledger append rejects every symlink escape vector without writing outside", async () => {
  // Vector 1: pre-existing root symlink escape.
  await withActivationHome({ prefix: "ak-act-root-symlink-" }, async ({ home }) => {
    const bookKey = activationBookKeyFor(home);
    const ledgerHome = machineLedgerHome(home);
    const outside = join(home, "consumer-repo-ledger");
    mkdirSync(outside, { recursive: true });
    // Configured machine home itself is a symlink into a consumer path.
    symlinkSync(outside, ledgerHome);

    assert.throws(
      () => appendAcceptedActivationFact(
        join(ledgerHome, "books", bookKey, "waiting.jsonl"),
        buildAcceptedActivationFact({
          role: "judge",
          observedAt: "2025-01-01T00:00:00.000Z",
          bookKey,
          session: { kind: "session-file", path: join(home, "s.jsonl") },
          correlation: { kind: "absent" },
        }),
        { ledgerHome },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
    assert.equal(existsSync(join(outside, "books", bookKey, "waiting.jsonl")), false);
    assert.equal(existsSync(join(outside, "books")), false);
  });

  // Vector 2: cross-book waiting.jsonl symlink.
  await withActivationHome({ prefix: "ak-act-cross-book-symlink-" }, async ({ home }) => {
    const sourceBook = activationBookKeyFor(home);
    const targetBook = `${sourceBook}-other`;
    const ledgerHome = machineLedgerHome(home);
    const sourceLedger = join(ledgerHome, "books", sourceBook, "waiting.jsonl");
    const targetLedger = join(ledgerHome, "books", targetBook, "waiting.jsonl");
    mkdirSync(dirname(sourceLedger), { recursive: true });
    mkdirSync(dirname(targetLedger), { recursive: true });
    writeFileSync(targetLedger, "");
    // Waiting path for the computed book redirects into another book still inside the home.
    symlinkSync(targetLedger, sourceLedger);

    assert.throws(
      () => appendAcceptedActivationFact(
        sourceLedger,
        buildAcceptedActivationFact({
          role: "judge",
          observedAt: "2025-01-01T00:00:00.000Z",
          bookKey: sourceBook,
          session: { kind: "session-file", path: join(home, "s.jsonl") },
          correlation: { kind: "absent" },
        }),
        { ledgerHome },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
    assert.equal(readFileSync(targetLedger, "utf8"), "");
  });

  // Vector 3: cross-book directory symlink.
  await withActivationHome({ prefix: "ak-act-cross-book-dir-symlink-" }, async ({ home }) => {
    const sourceBook = activationBookKeyFor(home);
    const targetBook = `${sourceBook}-other`;
    const ledgerHome = machineLedgerHome(home);
    const booksDir = join(ledgerHome, "books");
    const sourceDir = join(booksDir, sourceBook);
    const targetDir = join(booksDir, targetBook);
    const targetLedger = join(targetDir, "waiting.jsonl");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetLedger, "");
    // Computed basename book partition aliases another book still inside the home.
    symlinkSync(targetDir, sourceDir);

    assert.throws(
      () => appendAcceptedActivationFact(
        join(sourceDir, "waiting.jsonl"),
        buildAcceptedActivationFact({
          role: "judge",
          observedAt: "2025-01-01T00:00:00.000Z",
          bookKey: sourceBook,
          session: { kind: "session-file", path: join(home, "s.jsonl") },
          correlation: { kind: "absent" },
        }),
        { ledgerHome },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
    assert.equal(readFileSync(targetLedger, "utf8"), "");
  });

  // Vector 4: books component symlink escaping the machine home + ADR 0065
  // principal-admits half (activation no longer polices record placement).
  await withActivationHome({ prefix: "ak-act-symlink-" }, async ({ home }) => {
    const bookKey = activationBookKeyFor(home);
    const ledgerHome = machineLedgerHome(home);
    const outside = join(home, "outside-ledger");
    mkdirSync(outside, { recursive: true });

    // Pre-existing books component symlink that escapes the machine home.
    mkdirSync(ledgerHome, { recursive: true });
    symlinkSync(outside, join(ledgerHome, "books"));
    assert.throws(
      () => appendAcceptedActivationFact(
        join(ledgerHome, "books", bookKey, "waiting.jsonl"),
        buildAcceptedActivationFact({
          role: "judge",
          observedAt: "2025-01-01T00:00:00.000Z",
          bookKey,
          session: { kind: "session-file", path: join(home, "s.jsonl") },
          correlation: { kind: "absent" },
        }),
        { ledgerHome },
      ),
      (error: unknown) => error instanceof Error,
    );
    assert.equal(existsSync(join(outside, bookKey, "waiting.jsonl")), false);

    // Session path lexically under book but final realpath escapes.
    // ADR 0065 / #221: activation no longer polices record placement — admit the
    // existing regular-file principal; archivist createRecordSession owns that lock.
    rmSync(join(ledgerHome, "books"), { force: true });
    const sessionFile = persistActivationSessionFile({ home, bookKey, cwd: home });
    const realSession = resolve(sessionFile);
    // Replace runs dir with symlink to consumer path holding a decoy file.
    const bookDir = join(ledgerHome, "books", bookKey);
    const runsDir = join(bookDir, "runs");
    const decoyDir = join(home, "decoy-runs", "activation", "default");
    mkdirSync(dirname(decoyDir), { recursive: true });
    // Move real tree aside then link.
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(decoyDir, { recursive: true });
    const decoyFile = join(decoyDir, "session.jsonl");
    writeFileSync(decoyFile, `${JSON.stringify({ type: "session", version: 3, id: "decoy", timestamp: "2025-01-01T00:00:00.000Z", cwd: home })}\n`);
    symlinkSync(join(home, "decoy-runs"), runsDir);
    const pointer = durableSessionPointer(
      { getSessionFile: () => join(runsDir, "activation", "default", "session.jsonl") },
    );
    assert.equal(pointer.kind, "session-file");
    assert.equal(pointer.path, realpathSync(decoyFile));
    assert.notEqual(realSession, decoyFile);
  });
});
