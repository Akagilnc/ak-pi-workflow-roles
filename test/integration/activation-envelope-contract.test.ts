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
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionError } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  ACCEPTED_ACTIVATION_EVENT,
  ActivationGitRepositoryRequiredError,
  ActivationLedgerError,
  activationWaitingLedgerPath,
  appendAcceptedActivationFact,
  buildAcceptedActivationFact,
  correlationIdentityFromEnv,
  durableSessionPointer,
  resolveActivationLedgerHome,
  resolveBookKeyFromGit,
  serializeAcceptedActivationFact,
  TOOL_EXECUTION_UPDATE_HEARTBEAT,
  TOOL_EXECUTION_UPDATE_THROTTLE_MS,
  createRoleRuntimeExtension,
  createToolExecutionObservationFace,
  isProducingToolUpdate,
  systemToolExecutionObservationMonoNow,
  toolExecutionObservationRecordSchema,
  writeActivationTraceRecord,
  writeToolExecutionObservationRecord,
  type AcceptedActivationFact,
  type ToolExecutionObservationRecord,
} from "../../src/role-runtime.ts";
import { activationTraceRecordSchema, type ActivationTraceRecord } from "../../src/activation-trace.ts";
import { PACKAGED_ROLE_REGISTRY } from "../../src/packaged-role-registry.ts";
import {
  createFakeGitHubTransport,
  samplePull,
  sampleUser,
} from "../helpers/fake-github-transport.ts";
import { runFixerAuditFailureCli } from "../helpers/fixer-audit-cli.ts";
import {
  activationBookKeyFor,
  machineLedgerHome,
  packageRoot,
  persistActivationSessionFile,
  readAcceptedActivationFacts,
  runNodeSubprocess,
  withActivationHome,
  withInProcessPi,
} from "../helpers/pi-test-harness.ts";
import { reviewerPromptIdentity } from "../../src/reviewer-prompt-identity.ts";

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
  const reviewTask = new TextEncoder().encode("Review the fixed point.\n");
  const reviewOps = [
    "preflight.git.pin-target", "preflight.git.resolve-base", "preflight.git.derive-range",
    "preflight.git.list-ordered-commits", "preflight.git.read-material",
    "runner.git.materialize-mirror", "runner.git.materialize-workspace", "runner.git.verify-snapshot",
  ] as const;
  const reviewCaps = new TextEncoder().encode(JSON.stringify({
    version: 1,
    taskSha256: sha256Hex(reviewTask),
    tools: ["read", "bash"],
    prerequisiteOperations: [...reviewOps],
  }));
  const base = {
    loadJudgeSoul: law,
    transcriptFromContext: () => "",
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
        loadReviewerTask: async () => reviewTask,
        loadReviewerCapabilities: async () => reviewCaps,
        createReviewerPinnedGitReader: async () => {
          const pin = {
            repositoryRoot: fixtureRoot,
            objectFormat: "sha1" as const,
            targetHead: oid("9"),
            refs: { "refs/heads/main": { objectId: oid("9"), peeledCommitId: oid("9") } },
          };
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
            material: async () => new TextEncoder().encode("material"),
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
              snapshotIdentity: reviewerPromptIdentity(raw),
            },
            invocation: (original: string) => `/skill:${name} ${original}`,
            captureExpansion: () => undefined,
          };
        },
        runReviewerDispatch: async () => {
          throw new Error("dispatch unused during activation");
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
    default:
      throw new Error(`unexpected packaged role: ${role}`);
  }
}

function admissionFlagsForRole(role: string, fixtureRoot: string): Record<string, unknown> {
  const legsPath = join(fixtureRoot, "legs.json");
  switch (role) {
    case "judge":
      return {};
    case "fixer":
      return { "ak-fixer-phase": "plan", "ak-fix-packet": "/lawful/packet.md" };
    case "coder":
      return { "ak-coder-phase": "plan", "ak-coder-task": "/lawful/task.md" };
    case "reviewer":
      return {
        "ak-review-task": "/lawful/review-task.md",
        "ak-review-capabilities": "/lawful/review-caps.md",
      };
    case "collector":
      writeFileSync(legsPath, `${JSON.stringify({
        legs: [{ id: "codex", expectedAuthors: ["codexbot"], request: { body: "Please review." } }],
      })}\n`);
      return {
        "ak-collector-repo": "acme/widgets",
        "ak-collector-pr": "1",
        "ak-collector-legs": legsPath,
      };
    case "doctor":
      return { "ak-doctor-case": "/lawful/case" };
    case "merger":
      return { "ak-merger-input": "/lawful/merger.json" };
    default:
      return {};
  }
}

test("every registered role writes exactly one accepted-activation fact after admission", async () => {
  assert.ok(PACKAGED_ROLE_REGISTRY.some((entry) => entry.role === "collector"), "Collector must remain in the #52 registry gate");
  // #52 registry activation seam via shared withInProcessPi owner (not a local registry harness).
  await withActivationHome({ prefix: "ak-act-admit-" }, async ({ home, agentDir }) => {
    const fixtureRoot = join(home, "admit-fixtures");
    mkdirSync(fixtureRoot, { recursive: true });
    const bookKey = activationBookKeyFor(home);
    const previousCorr = process.env.AK_CORRELATION_ID;
    const faux = fauxProvider({ api: "ak-act-admit", provider: "ak-act-admit" });

    try {
      for (const entry of PACKAGED_ROLE_REGISTRY) {
        process.exitCode = undefined;
        process.env.AK_CORRELATION_ID = `corr-${entry.role}`;
        const roleFlags = Object.fromEntries(
          Object.entries({
            "ak-role": entry.role,
            ...admissionFlagsForRole(entry.role, fixtureRoot),
          }).map(([key, value]) => [key, String(value)]),
        );
        await withInProcessPi({
          activationLedgerSession: true,
          cwd: home,
          agentDir,
          faux,
          modelsPath: null,
          noExtensions: true,
          systemPrompt: `ADMIT ${entry.role}`,
          mode: "print",
          flags: roleFlags,
          extensionFactories: [createRoleRuntimeExtension(admissionDepsForRole(entry.role, fixtureRoot))],
        }, async ({ sessionManager }) => {
          const sessionFile = sessionManager.getSessionFile();
          assert.ok(typeof sessionFile === "string" && sessionFile.length > 0);
          const facts = readAcceptedActivationFacts(home, bookKey);
          const roleFacts = facts.filter((fact) => fact.role === entry.role);
          assert.equal(roleFacts.length, 1, `${entry.role} admitted fact count`);
          assert.deepEqual(roleFacts[0], {
            event: ACCEPTED_ACTIVATION_EVENT,
            role: entry.role,
            observedAt: "2025-06-01T12:00:00.000Z",
            bookKey,
            session: { kind: "session-file", path: realpathSync(sessionFile) },
            correlation: { kind: "caller", id: `corr-${entry.role}` },
          });
        });
      }

      // Missing correlation identity uses the production env channel (typed absent).
      delete process.env.AK_CORRELATION_ID;
      process.exitCode = undefined;
      const beforeAbsent = readAcceptedActivationFacts(home, bookKey).length;
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: "ADMIT ABSENT",
        mode: "print",
        flags: { "ak-role": "judge" },
        extensionFactories: [createRoleRuntimeExtension(admissionDepsForRole("judge", fixtureRoot))],
      }, async () => {
        const afterAbsent = readAcceptedActivationFacts(home, bookKey);
        assert.equal(afterAbsent.length, beforeAbsent + 1);
        assert.deepEqual(afterAbsent.at(-1)?.correlation, { kind: "absent" });
      });

      // Envelope barrier opens only after admitted fact write (real ExtensionRunner).
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: "ADMIT BARRIER",
        mode: "print",
        flags: { "ak-role": "judge" },
        extensionFactories: [createRoleRuntimeExtension(admissionDepsForRole("judge", fixtureRoot))],
      }, async ({ session }) => {
        await session.extensionRunner.emitBeforeAgentStart("go", undefined, "BASE", { cwd: home });
      });
    } finally {
      if (previousCorr === undefined) delete process.env.AK_CORRELATION_ID;
      else process.env.AK_CORRELATION_ID = previousCorr;
    }
  });
});

test("unselected role and unsupported role leave zero accepted-activation facts", async () => {
  await withActivationHome({ prefix: "ak-act-unsel-" }, async ({ home, agentDir }) => {
    const faux = fauxProvider({ api: "ak-act-unsel", provider: "ak-act-unsel" });
    process.exitCode = undefined;
    await withInProcessPi({
      activationLedgerSession: true,
      cwd: home,
      agentDir,
      faux,
      modelsPath: null,
      noExtensions: true,
      systemPrompt: "UNSELECTED",
      mode: "print",
      flags: {},
      extensionFactories: [createRoleRuntimeExtension({
        loadJudgeSoul: async () => "LAW",
        transcriptFromContext: () => "",
        auditSoulCompliance: async () => ({ status: "pass" }),
      })],
    }, async () => {
      assert.equal(readAcceptedActivationFacts(home, activationBookKeyFor(home)).length, 0);
    });

    process.exitCode = undefined;
    await assert.rejects(async () => withInProcessPi({
      activationLedgerSession: true,
      cwd: home,
      agentDir,
      faux,
      modelsPath: null,
      noExtensions: true,
      systemPrompt: "UNSUPPORTED",
      mode: "print",
      flags: { "ak-role": "router" },
      extensionFactories: [createRoleRuntimeExtension({
        loadJudgeSoul: async () => "LAW",
        transcriptFromContext: () => "",
        auditSoulCompliance: async () => ({ status: "pass" }),
      })],
    }, async () => {
      throw new Error("unsupported role must not complete bindExtensions");
    }));
    assert.equal(readAcceptedActivationFacts(home, activationBookKeyFor(home)).length, 0);
  });
});

test("every registered whole-activation rejection terminates nonzero with a named cause before a model turn", async () => {
  // Ordinary integration owner: real ExtensionRunner via withInProcessPi (not a handler-capture seam).
  await withActivationHome({ prefix: "ak-act-reject-" }, async ({ home, agentDir }) => {
    const faux = fauxProvider({ api: "ak-act-reject", provider: "ak-act-reject" });
    for (const entry of PACKAGED_ROLE_REGISTRY) {
      process.exitCode = undefined;
      const traces: ActivationTraceRecord[] = [];
      const rejection = new TypeError(`${entry.role} activation rejected`);
      const reject = async (): Promise<never> => { throw rejection; };
      const flags: Record<string, string> = {
        "ak-role": entry.role,
        "ak-doctor-case": "/lawful/case",
        "ak-merger-input": "/lawful/merger.json",
      };
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: `REJECT ${entry.role}`,
        mode: "print",
        flags,
        extensionFactories: [createRoleRuntimeExtension({
          loadJudgeSoul: reject,
          loadFixerSoul: reject,
          loadCoderSoul: reject,
          loadReviewerSoul: reject,
          loadCollectorSoul: reject,
          loadDoctorSoul: reject,
          loadMergerSoul: reject,
          createMergerGitState: () => ({ activeMerge: reject, completedMerge: reject }),
          transcriptFromContext: () => "",
          auditSoulCompliance: async () => ({ status: "pass" }),
          activationClock: () => "2025-01-01T00:00:00.000Z",
          activationTraceWriter: (record) => { traces.push(record); },
        })],
      }, async ({ session }) => {
        // session_start rejection is swallowed by ExtensionRunner.emit after failInfrastructure.
        assert.equal(process.exitCode, 1, `${entry.role} must terminate nonzero on rejection`);
        assert.equal(
          readAcceptedActivationFacts(home, activationBookKeyFor(home)).length,
          0,
          `${entry.role} wrote an accepted-activation fact on rejection`,
        );
        const failed = traces.find((trace) => trace.status === "failed");
        assert.ok(failed && failed.status === "failed", `${entry.role} missing failed activation trace`);
        assert.equal(failed.cause.identity, "TypeError");
        assert.equal(failed.cause.name, "TypeError");
        assert.equal(failed.cause.message, `${entry.role} activation rejected`);
        if (typeof failed.cause.evidenceId !== "string") throw new Error("missing activation evidence id");
        assert.match(failed.cause.evidenceId, /^activation-cause-/);

        // Barrier through the real ExtensionRunner before any provider turn.
        // emitBeforeAgentStart swallows handler throws after failInfrastructure; observe abort + exit + extension error.
        const extensionErrors: ExtensionError[] = [];
        session.extensionRunner.onError((error) => { extensionErrors.push(error); });
        let aborts = 0;
        await session.bindExtensions({
          mode: "print",
          abortHandler: () => { aborts += 1; },
        });
        process.exitCode = undefined;
        aborts = 0;
        extensionErrors.length = 0;
        await session.extensionRunner.emitBeforeAgentStart("go", undefined, "BASE", { cwd: home });
        assert.equal(aborts, 1, `${entry.role} barrier must abort`);
        assert.equal(process.exitCode, 1, `${entry.role} barrier must set nonzero exit`);
        assert.ok(
          extensionErrors.some((error) => (
            error.event === "before_agent_start"
            && error.error.includes("activation did not complete")
          )),
          `${entry.role} barrier must surface ActivationBarrierError via extension error; got ${JSON.stringify(extensionErrors)}`,
        );
        // This suite never prompts the session after rejection — barrier owns the before_agent_start seam.
        assert.equal(session.agent.state.messages.length, 0, `${entry.role} must not dispatch a model turn`);
      });
    }
  });
});

test("accepted-activation fact is closed at the typed API and omits injected content keys", () => {
  const closed: AcceptedActivationFact = {
    event: ACCEPTED_ACTIVATION_EVENT,
    role: "judge",
    observedAt: "2025-01-01T00:00:00.000Z",
    bookKey: "demo",
    session: { kind: "session-file", path: "/home/session.jsonl" },
    correlation: { kind: "caller", id: "c1" },
  };
  const injectedExtraKeys = ["prompt", "transcript", "argv", "excerpt", "content"] as const;
  const smuggled = {
    ...closed,
    prompt: "PROMPT_SECRET_BYTES",
    transcript: "transcript-body",
    argv: ["--ak-role", "judge"],
    excerpt: "excerpt-text",
    content: "nope",
  } as AcceptedActivationFact & Record<string, unknown>;
  // Closed at the typed construction API via descriptor-driven projection.
  assert.deepEqual(buildAcceptedActivationFact(smuggled), closed);

  // Serialized projection retains typed descriptor exclusion of injected content keys.
  // Exact key-set spelling/order is owned by the production descriptor + compile-time proof — not asserted here.
  const parsed = JSON.parse(serializeAcceptedActivationFact(smuggled)) as Record<string, unknown>;
  for (const key of injectedExtraKeys) {
    assert.equal(Object.hasOwn(parsed, key), false, `descriptor projection must omit injected ${key}`);
  }
  assert.deepEqual(correlationIdentityFromEnv({}), { kind: "absent" });
  assert.deepEqual(correlationIdentityFromEnv({ AK_CORRELATION_ID: "" }), { kind: "absent" });
  assert.deepEqual(correlationIdentityFromEnv({ AK_CORRELATION_ID: "   " }), { kind: "absent" });
  assert.deepEqual(correlationIdentityFromEnv({ AK_CORRELATION_ID: "\t\n" }), { kind: "absent" });
  assert.deepEqual(correlationIdentityFromEnv({ AK_CORRELATION_ID: "abc" }), { kind: "caller", id: "abc" });
  // Non-blank caller value is preserved verbatim (including surrounding whitespace).
  assert.deepEqual(
    correlationIdentityFromEnv({ AK_CORRELATION_ID: "  keep-me  " }),
    { kind: "caller", id: "  keep-me  " },
  );
});

test("book key follows git common-dir host basename across worktrees, rename, and basename collision", () => {
  const root = mkdtempSync(join(tmpdir(), "ak-book-topo-"));
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
    const nonGit = join(root, "not-a-repo");
    mkdirSync(nonGit);
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
  const root = mkdtempSync(join(tmpdir(), "ak-book-infra-"));
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
      () => resolveBookKeyFromGit(cwd),
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

test("mixed concurrent O_APPEND producers keep intact records with exact cardinality", async () => {
  // Shared-ledger contract: package append and a foreign O_APPEND producer must not
  // overwrite one another. No private lock / positional rewrite / truncate ownership.
  const root = mkdtempSync(join(tmpdir(), "ak-ledger-mixed-"));
  const ledgerHome = join(root, "home");
  const bookKey = "mixed-book";
  const ledgerPath = activationWaitingLedgerPath(ledgerHome, bookKey);
  const packageWorker = join(root, "package-worker.mjs");
  const foreignWorker = join(root, "foreign-worker.mjs");
  writeFileSync(packageWorker, `
import { appendAcceptedActivationFact, buildAcceptedActivationFact } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "src/activation-ledger.ts")).href)};
const index = Number(process.argv[2]);
const ledgerPath = process.argv[3];
const ledgerHome = process.argv[4];
appendAcceptedActivationFact(ledgerPath, buildAcceptedActivationFact({
  role: "judge",
  observedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
  bookKey: "mixed-book",
  session: { kind: "session-file", path: "/s/pkg-" + index + ".jsonl" },
  correlation: { kind: "caller", id: "pkg-" + index },
}), { ledgerHome });
`);
  writeFileSync(foreignWorker, `
import { constants, closeSync, openSync, writeSync } from "node:fs";
const index = Number(process.argv[2]);
const ledgerPath = process.argv[3];
const line = Buffer.from(JSON.stringify({ producer: "foreign", id: "foreign-" + index }) + "\\n", "utf8");
const fd = openSync(ledgerPath, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY, 0o644);
try {
  const written = writeSync(fd, line, 0, line.length, null);
  if (written !== line.length) throw new Error("foreign short write " + written + "/" + line.length);
} finally {
  closeSync(fd);
}
`);
  // Ensure parent tree exists so foreign O_APPEND open does not race mkdir.
  mkdirSync(dirname(ledgerPath), { recursive: true });
  const packageCount = 8;
  const foreignCount = 8;
  const children = await Promise.all([
    ...Array.from({ length: packageCount }, (_, index) =>
      runNodeSubprocess(
        ["--import", "tsx", packageWorker, String(index), ledgerPath, ledgerHome],
        { cwd: packageRoot, timeoutMs: 15_000 },
      )),
    ...Array.from({ length: foreignCount }, (_, index) =>
      runNodeSubprocess(
        ["--import", "tsx", foreignWorker, String(index), ledgerPath],
        { cwd: packageRoot, timeoutMs: 15_000 },
      )),
  ]);
  for (const child of children) {
    assert.equal(child.code, 0, child.stderr);
  }
  const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, packageCount + foreignCount);
  const packageIds: string[] = [];
  const foreignIds: string[] = [];
  for (const line of lines) {
    const row = JSON.parse(line) as Record<string, unknown>;
    if (row.event === ACCEPTED_ACTIVATION_EVENT) {
      const fact = row as unknown as AcceptedActivationFact;
      assert.equal(fact.bookKey, bookKey);
      assert.equal(fact.correlation.kind, "caller");
      if (fact.correlation.kind === "caller") packageIds.push(fact.correlation.id);
      continue;
    }
    assert.equal(row.producer, "foreign");
    assert.equal(typeof row.id, "string");
    foreignIds.push(row.id as string);
  }
  assert.deepEqual(packageIds.sort(), Array.from({ length: packageCount }, (_, i) => `pkg-${i}`).sort());
  assert.deepEqual(foreignIds.sort(), Array.from({ length: foreignCount }, (_, i) => `foreign-${i}`).sort());
  rmSync(root, { recursive: true, force: true });
});

test("concurrent first-time ledger directory creation across books stays race-safe", async () => {
  // Fresh home: workers race on creating shared ledgerHome/books components plus distinct books.
  const root = mkdtempSync(join(tmpdir(), "ak-ledger-mkdir-race-"));
  const ledgerHome = join(root, "home");
  const worker = join(root, "mkdir-race-worker.mjs");
  writeFileSync(worker, `
import { appendAcceptedActivationToBook, buildAcceptedActivationFact } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "src/activation-ledger.ts")).href)};
const index = Number(process.argv[2]);
const ledgerHome = process.argv[3];
const bookKey = "book-" + index;
appendAcceptedActivationToBook({
  ledgerHome,
  fact: buildAcceptedActivationFact({
    role: "judge",
    observedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
    bookKey,
    session: { kind: "session-file", path: "/s/" + index + ".jsonl" },
    correlation: { kind: "caller", id: "mkdir-" + index },
  }),
});
`);
  const workerCount = 16;
  const children = await Promise.all(Array.from({ length: workerCount }, (_, index) =>
    runNodeSubprocess(
      ["--import", "tsx", worker, String(index), ledgerHome],
      { cwd: packageRoot, timeoutMs: 15_000 },
    )));
  for (const child of children) {
    assert.equal(child.code, 0, child.stderr);
  }
  for (let index = 0; index < workerCount; index += 1) {
    const bookKey = `book-${index}`;
    const lines = readFileSync(activationWaitingLedgerPath(ledgerHome, bookKey), "utf8")
      .split("\n")
      .filter(Boolean);
    assert.equal(lines.length, 1, `${bookKey} must keep exactly one accepted fact`);
    const row = JSON.parse(lines[0]!) as AcceptedActivationFact;
    assert.equal(row.event, ACCEPTED_ACTIVATION_EVENT);
    assert.equal(row.bookKey, bookKey);
    assert.deepEqual(row.correlation, { kind: "caller", id: `mkdir-${index}` });
  }
  rmSync(root, { recursive: true, force: true });
});

test("resolved ledger home rejects relative process home before filesystem writes", () => {
  for (const relativeHome of [".", "relative-home", ""] as const) {
    assert.throws(
      () => resolveActivationLedgerHome(() => relativeHome),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
  }

  const absoluteHome = resolve(tmpdir(), "ak-ledger-abs-home");
  const ledgerHome = resolveActivationLedgerHome(() => absoluteHome);
  assert.equal(isAbsolute(ledgerHome), true);
  assert.equal(ledgerHome, resolve(absoluteHome, ".ak-roles"));

  const root = mkdtempSync(join(tmpdir(), "ak-ledger-rel-home-"));
  try {
    const relativeLedgerHome = "relative-ledger-home";
    assert.equal(isAbsolute(relativeLedgerHome), false);
    assert.throws(
      () => appendAcceptedActivationFact(
        join(relativeLedgerHome, "books", "b", "waiting.jsonl"),
        buildAcceptedActivationFact({
          role: "judge",
          observedAt: "2025-01-01T00:00:00.000Z",
          bookKey: "b",
          session: { kind: "session-file", path: "/s/x.jsonl" },
          correlation: { kind: "absent" },
        }),
        { ledgerHome: relativeLedgerHome },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ActivationLedgerError);
        assert.equal(error.code, "AK_ACTIVATION_LEDGER");
        return true;
      },
    );
    assert.equal(existsSync(join(root, relativeLedgerHome)), false);
    assert.equal(existsSync(resolve(relativeLedgerHome)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ledger append rejects pre-existing root symlink escape without writing outside", async () => {
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
});

test("ledger append rejects cross-book waiting.jsonl symlink without writing the target book", async () => {
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
});

test("ledger append rejects cross-book directory symlink without writing the target book", async () => {
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
});

test("ledger append and durable session admission reject symlink component escapes", async () => {
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
    assert.throws(
      () => durableSessionPointer(
        { getSessionFile: () => join(runsDir, "activation", "default", "session.jsonl") },
        { ledgerHome, bookKey },
      ),
      (error: unknown) => error instanceof Error,
    );
    assert.notEqual(realSession, decoyFile);
  });
});

test("incident 2026-08-02: malformed Fixer prerequisites fail the real Pi subprocess before provider dispatch", async () => {
  // Shared CLI harness with audit-failure-subprocess (same extension pair + provider + hermetic home).
  const result = await runFixerAuditFailureCli({
    packet: "Apply the assigned repair.\n",
    prerequisites: { prerequisites: [] },
    timeoutMs: 15_000,
    prefix: "ak-fixer-activation-incident-",
  });
  assert.equal(result.timedOut, false, "malformed prerequisites subprocess did not time out");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /FIXER_AUDIT_FAILURE_PROVIDER_CALLS=0/);
  const traces = result.stderr.split("\n").flatMap((line) => {
    try { const value = JSON.parse(line) as ActivationTraceRecord; return Value.Check(activationTraceRecordSchema, value) ? [value] : []; }
    catch { return []; }
  });
  assert.deepEqual(traces.map(({ role, stageId, status }) => ({ role, stageId, status })), [
    { role: "fixer", stageId: "load-and-install", status: "failed" },
  ]);
  const failed = traces[0];
  assert.ok(failed?.status === "failed");
  assert.ok(["AK_INVALID_FIX_PACKET", "FixerPacketValidationError"].includes(failed.cause.identity));
  assert.equal(failed.cause.name, "FixerPacketValidationError");
  if (typeof failed.cause.evidenceId !== "string") throw new Error("missing activation evidence id");
  assert.match(failed.cause.evidenceId, /^activation-cause-/);
});


function assertRetryingJsonlWriter(input: {
  write: (record: never, writeSync: typeof import("node:fs").writeSync) => void;
  record: unknown;
  schema: unknown;
  chunkSize: number;
  expectedFd?: number;
  invalidRecord?: unknown;
}): void {
  const chunks: Buffer[] = [];
  let calls = 0;
  input.write(
    input.record as never,
    ((_fd: number, buffer: Uint8Array, offset: number, length: number) => {
      if (input.expectedFd !== undefined) assert.equal(_fd, input.expectedFd);
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("busy"), { code: "EAGAIN" });
      const count = Math.min(input.chunkSize, length);
      chunks.push(Buffer.from(buffer.subarray(offset, offset + count)));
      return count;
    }) as typeof import("node:fs").writeSync,
  );
  const line = Buffer.concat(chunks).toString();
  assert.equal(line.endsWith("\n"), true);
  assert.equal(Value.Check(input.schema as never, JSON.parse(line)), true);
  assert.ok(calls > 2);
  if (input.invalidRecord !== undefined) {
    assert.throws(() => input.write(input.invalidRecord as never, (() => 0) as never), /observation record does not match its contract/);
  }
}

test("default trace and tool observation writers retry short writes and reject schema-invalid records", () => {
  assertRetryingJsonlWriter({
    write: writeActivationTraceRecord as never,
    record: { role: "judge", stageId: "load", status: "failed", timestamp: "2025-01-01T00:00:00.000Z", cause: { identity: "Error", name: "Error", message: "failed" } },
    schema: activationTraceRecordSchema,
    chunkSize: 7,
  });
  assertRetryingJsonlWriter({
    write: writeToolExecutionObservationRecord as never,
    record: {
      event: "tool_execution_start",
      role: "judge",
      toolCallId: "t1",
      toolName: "bash",
      timestamp: "2025-01-01T00:00:00.000Z",
    },
    schema: toolExecutionObservationRecordSchema,
    chunkSize: 9,
    expectedFd: 2,
    invalidRecord: { event: "nope" },
  });
});

test("tool-execution observation contract retains reader-required events and output-driven updates", () => {
  assert.equal(TOOL_EXECUTION_UPDATE_THROTTLE_MS, 30_000);
  assert.equal(TOOL_EXECUTION_UPDATE_HEARTBEAT, "output-driven");
  assert.equal(isProducingToolUpdate({ content: [], details: undefined }), false);
  assert.equal(isProducingToolUpdate({ content: [{ type: "text", text: "" }] }), false);
  assert.equal(isProducingToolUpdate({ content: [{ type: "text", text: "chunk" }] }), true);
  for (const record of [
    { event: "tool_execution_start", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:00.000Z" },
    { event: "tool_execution_update", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:30.000Z" },
    { event: "tool_execution_end", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:01:00.000Z", isError: false },
  ] as const) {
    assert.equal(Value.Check(toolExecutionObservationRecordSchema, record), true);
  }
  assert.equal(Value.Check(toolExecutionObservationRecordSchema, {
    event: "tool_execution_end", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:00.000Z",
  }), false);
  assert.equal(Value.Check(toolExecutionObservationRecordSchema, {
    event: "tool_execution_start", role: "judge", toolCallId: "c1", toolName: "bash", timestamp: "2025-01-01T00:00:00.000Z", extra: true,
  }), true);
});

test("observation face emits start/end always, throttles producing updates per toolCallId, and ignores non-admitted sessions", async () => {
  const records: ToolExecutionObservationRecord[] = [];
  let admitted = true;
  let mono = 0;
  const face = createToolExecutionObservationFace({
    role: () => "fixer",
    admitted: () => admitted,
    clock: () => new Date(1_700_000_000_000 + mono).toISOString(),
    monoNow: () => mono,
    write: (record) => { records.push(record); },
  });

  await face.onStart({ toolCallId: "a", toolName: "bash" });
  await face.onUpdate({ toolCallId: "a", toolName: "bash", partialResult: { content: [] } });
  await face.onUpdate({ toolCallId: "a", toolName: "bash", partialResult: { content: [{ type: "text", text: "one" }] } });
  mono = 10_000;
  await face.onUpdate({ toolCallId: "a", toolName: "bash", partialResult: { content: [{ type: "text", text: "two" }] } });
  mono = 30_000;
  await face.onUpdate({ toolCallId: "a", toolName: "bash", partialResult: { content: [{ type: "text", text: "three" }] } });
  await face.onEnd({ toolCallId: "a", toolName: "bash", isError: false });

  await face.onStart({ toolCallId: "b", toolName: "read" });
  await face.onStart({ toolCallId: "c", toolName: "bash" });
  await face.onUpdate({ toolCallId: "b", toolName: "read", partialResult: { content: [{ type: "text", text: "b-out" }] } });
  await face.onUpdate({ toolCallId: "c", toolName: "bash", partialResult: { content: [{ type: "text", text: "c-out" }] } });
  await face.onEnd({ toolCallId: "b", toolName: "read", isError: true });
  await face.onEnd({ toolCallId: "c", toolName: "bash", isError: false });

  admitted = false;
  const before = records.length;
  await face.onStart({ toolCallId: "d", toolName: "bash" });
  await face.onUpdate({ toolCallId: "d", toolName: "bash", partialResult: { content: [{ type: "text", text: "nope" }] } });
  await face.onEnd({ toolCallId: "d", toolName: "bash", isError: false });
  assert.equal(records.length, before);

  assert.deepEqual(records.map((record) => (
    record.event === "tool_execution_end"
      ? { event: record.event, toolCallId: record.toolCallId, isError: record.isError }
      : { event: record.event, toolCallId: record.toolCallId }
  )), [
    { event: "tool_execution_start", toolCallId: "a" },
    { event: "tool_execution_update", toolCallId: "a" },
    { event: "tool_execution_update", toolCallId: "a" },
    { event: "tool_execution_end", toolCallId: "a", isError: false },
    { event: "tool_execution_start", toolCallId: "b" },
    { event: "tool_execution_start", toolCallId: "c" },
    { event: "tool_execution_update", toolCallId: "b" },
    { event: "tool_execution_update", toolCallId: "c" },
    { event: "tool_execution_end", toolCallId: "b", isError: true },
    { event: "tool_execution_end", toolCallId: "c", isError: false },
  ]);
  for (const record of records) {
    assert.equal(Value.Check(toolExecutionObservationRecordSchema, record), true);
    assert.equal(record.role, "fixer");
  }
});

test("observation face rejects throttleMs override at the typed call site and ignores it at runtime", async () => {
  // Typed surface has no throttleMs — excess key must not type-check.
  const faceOptions = {
    role: () => "fixer" as string | undefined,
    admitted: () => true,
    clock: () => "2025-01-01T00:00:00.000Z",
    monoNow: () => 0,
    write: (_record: ToolExecutionObservationRecord) => {},
  };
  type FaceOptions = Parameters<typeof createToolExecutionObservationFace>[0];
  type HasThrottleMs = "throttleMs" extends keyof FaceOptions ? true : false;
  const throttleMsOnFaceOptions: HasThrottleMs = false;
  assert.equal(throttleMsOnFaceOptions, false);

  // Runtime: smuggled throttleMs: 0 must not disable the 30s coalesce.
  const records: ToolExecutionObservationRecord[] = [];
  let mono = 0;
  const face = createToolExecutionObservationFace({
    ...faceOptions,
    throttleMs: 0,
    monoNow: () => mono,
    write: (record) => { records.push(record); },
  } as FaceOptions);

  await face.onStart({ toolCallId: "t", toolName: "bash" });
  await face.onUpdate({
    toolCallId: "t",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "first" }] },
  });
  mono = 10_000; // < TOOL_EXECUTION_UPDATE_THROTTLE_MS
  await face.onUpdate({
    toolCallId: "t",
    toolName: "bash",
    partialResult: { content: [{ type: "text", text: "second" }] },
  });

  assert.deepEqual(records.map((r) => r.event), [
    "tool_execution_start",
    "tool_execution_update",
  ]);
});

test("tool observation writer failure does not fake success on the face", async () => {
  const face = createToolExecutionObservationFace({
    role: () => "judge",
    admitted: () => true,
    clock: () => "2025-01-01T00:00:00.000Z",
    monoNow: () => 0,
    write: () => { throw new Error("stderr unavailable"); },
  });
  await assert.rejects(async () => face.onStart({ toolCallId: "x", toolName: "bash" }), /stderr unavailable/);
});

test("production observation mono clock is monotonic and not wall-clock Date.now", () => {
  const samples = Array.from({ length: 32 }, () => systemToolExecutionObservationMonoNow());
  for (let i = 1; i < samples.length; i++) {
    assert.ok(samples[i]! >= samples[i - 1]!, `monoNow must not go backwards: ${samples[i - 1]} -> ${samples[i]}`);
  }
  // Date.now is epoch ms (~1e12); performance.now is process-relative ms (far smaller in tests).
  assert.ok(samples[0]! < 1e11, `production monoNow must not default to wall-clock Date.now; got ${samples[0]}`);
});

test("observation writer failure aborts through real ExtensionRunner emit with original cause", async () => {
  await withActivationHome({ prefix: "ak-tool-obs-fail-" }, async ({ home, agentDir }) => {
    const faux = fauxProvider({ api: "ak-tool-obs-fail", provider: "ak-tool-obs-fail" });
    const writerError = new Error("stderr unavailable");
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let aborts = 0;
    const extensionErrors: ExtensionError[] = [];
    try {
      await withInProcessPi({
        activationLedgerSession: true,
        cwd: home,
        agentDir,
        faux,
        modelsPath: null,
        noExtensions: true,
        systemPrompt: "JUDGE",
        mode: "print",
        flags: { "ak-role": "judge" },
        extensionFactories: [createRoleRuntimeExtension({
          loadJudgeSoul: async () => "LAW",
          transcriptFromContext: () => "",
          auditSoulCompliance: async () => ({ status: "pass" }),
          activationClock: () => "2025-01-01T00:00:00.000Z",
          activationTraceWriter: () => {},
          toolExecutionObservationWriter: () => { throw writerError; },
        })],
      }, async ({ session }) => {
        session.extensionRunner.onError((error) => { extensionErrors.push(error); });
        // Rebind abort so the infrastructure path is observable without depending on agent internals.
        await session.bindExtensions({
          mode: "print",
          abortHandler: () => { aborts += 1; },
        });
        // emit() swallows handler throws after emitError — termination must still have run.
        await session.extensionRunner.emit({
          type: "tool_execution_start",
          toolCallId: "obs-fail-1",
          toolName: "bash",
          args: {},
        });
        assert.equal(aborts, 1, "observation failure must call ExtensionContext.abort");
        assert.equal(process.exitCode, 1, "print mode observation failure must set nonzero exitCode");
        assert.ok(
          extensionErrors.some((error) => error.event === "tool_execution_start" && error.error.includes("stderr unavailable")),
          `ExtensionRunner must retain the original cause via extension error; got ${JSON.stringify(extensionErrors)}`,
        );

        // Same termination for update and end seams.
        aborts = 0;
        process.exitCode = undefined;
        extensionErrors.length = 0;
        await session.extensionRunner.emit({
          type: "tool_execution_update",
          toolCallId: "obs-fail-1",
          toolName: "bash",
          args: {},
          partialResult: { content: [{ type: "text", text: "chunk" }] },
        });
        assert.equal(aborts, 1);
        assert.equal(process.exitCode, 1);
        assert.ok(extensionErrors.some((error) => error.event === "tool_execution_update" && error.error.includes("stderr unavailable")));

        aborts = 0;
        process.exitCode = undefined;
        extensionErrors.length = 0;
        await session.extensionRunner.emit({
          type: "tool_execution_end",
          toolCallId: "obs-fail-1",
          toolName: "bash",
          isError: false,
          result: { content: [], details: {} },
        });
        assert.equal(aborts, 1);
        assert.equal(process.exitCode, 1);
        assert.ok(extensionErrors.some((error) => error.event === "tool_execution_end" && error.error.includes("stderr unavailable")));
      });
    } finally {
      process.exitCode = priorExitCode;
    }
  });
});
