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
  ActivationGitRepositoryRequiredError,
  durableSessionPointer,
  resolveActivationLedgerHome,
  resolveBookKeyFromGit,
  type ToolExecutionObservationRecord,
} from "../../src/role-runtime.ts";
import { type ActivationTraceRecord } from "../../src/activation-trace.ts";
import { createPiRoleRuntimeExtension } from "../../src/pi/adapter.ts";
import { createRoleRuntimeExtension } from "../../src/role-runtime.ts";
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
  withActivationHome,
} from "../helpers/pi-test-harness.ts";
import { outsideWorktreeTempPrefix, worktreeTempPrefix } from "../helpers/worktree-temp.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

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
    loadRoleSoul: law,
    activationClock: () => "2025-06-01T12:00:00.000Z",
    activationTraceWriter: () => {},
  };
  switch (role) {
    case "judge":
      return base;
    case "fixer":
      return { ...base, loadFixPacket: async () => "Repair the findings.\n" };
    case "coder":
      return { ...base, loadCoderTask: async () => "Build it.\n" };
    case "reviewer":
      return {
        ...base,
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
            captureExpansion: () => undefined,
          };
        },
      };
    case "collector":
      return {
        ...base,
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
        loadDoctorCase: async () => ({
          version: 1 as const,
          identity: { issueNumber: 1, runsPath: "/lawful/case" },
          cost: emptyDoctorCost,
          evidence: [],
        }),
        auditDoctorCompliance: async () => ({ status: "converged" as const }),
      };
    case "merger": {
      const mergerInput = {
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
        loadMergerInput: async () => mergerInput,
      };
    }
    case "notary":
      return {
        ...base,
        loadNotarySourceRun: async (path: string) => ({
          runDirectory: path,
          runId: "01a034f1-75bf-71a6-bcf5-d1299145b1a5",
          role: "judge",
        }),
      };
    case "countersign":
    case "secretariat":
    case "gleaner-left":
    case "inspector":
    case "gatekeeper":
    case "navigator":
      return base;
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
        "ak-review-lens": "completeness",
        "ak-review-authority-refs": JSON.stringify(["CLAUDE.md"]),
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

test("book key follows git common-dir host basename across worktrees, rename, and basename collision", async () => {
  return await withTempRoot("ak-book-topo-", async (root) => {
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
    // Isolation root must sit outside this worktree's upward Git discovery; outside
    // named root is not deleted (owner 2026-09-06 directory boundary).
    const nonGit = mkdtempSync(outsideWorktreeTempPrefix("ak-book-topo-nongit-"));
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
    });
});

test("git spawn infrastructure failures retain identity and do not masquerade as non-git", async () => {
  return await withTempRoot("ak-book-infra-", async (root) => {
    // Non-git control cwd must sit outside this worktree; outside named root is not deleted.
    // Second acquire stays inside try so a failure still hits root's finally.
    const nonGitCwd = mkdtempSync(outsideWorktreeTempPrefix("ak-book-infra-nongit-"));
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
    });
});

// #855: waiting.jsonl append + symlink-escape matrix deleted with two-face reconciliation.
// ADR 0065 principal admission (activation does not police record placement) stays.
test("durable session principal admits escaped realpath without placement lock", async () => {
  await withActivationHome({ prefix: "ak-act-symlink-" }, async ({ home }) => {
    const bookKey = activationBookKeyFor(home);
    const ledgerHome = machineLedgerHome(home);
    const sessionFile = persistActivationSessionFile({ home, bookKey, cwd: home });
    const realSession = resolve(sessionFile);
    const bookDir = join(ledgerHome, "books", bookKey);
    const runsDir = join(bookDir, "runs");
    const decoyDir = join(home, "decoy-runs", "activation", "default");
    mkdirSync(dirname(decoyDir), { recursive: true });
    rmSync(runsDir, { recursive: true, force: true });
    mkdirSync(decoyDir, { recursive: true });
    const decoyFile = join(decoyDir, "session.jsonl");
    writeFileSync(
      decoyFile,
      `${JSON.stringify({ type: "session", version: 3, id: "decoy", timestamp: "2025-01-01T00:00:00.000Z", cwd: home })}\n`,
    );
    symlinkSync(join(home, "decoy-runs"), runsDir);
    const pointer = durableSessionPointer({
      getSessionFile: () => join(runsDir, "activation", "default", "session.jsonl"),
    });
    assert.equal(pointer.kind, "session-file");
    assert.equal(pointer.path, realpathSync(decoyFile));
    assert.notEqual(realSession, decoyFile);
  });
});
