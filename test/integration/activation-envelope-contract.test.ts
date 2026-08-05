import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { afterEach } from "node:test";
import { pathToFileURL } from "node:url";
import { fauxProvider } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, ExtensionError } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import {
  ACCEPTED_ACTIVATION_EVENT,
  ActivationBarrierError,
  activationWaitingLedgerPath,
  buildAcceptedActivationFact,
  correlationIdentityFromEnv,
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
import { testActivationLedgerDeps } from "../helpers/activation-ledger.ts";
import {
  createFakeGitHubTransport,
  samplePull,
  sampleUser,
} from "../helpers/fake-github-transport.ts";
import { runFixerAuditFailureCli } from "../helpers/fixer-audit-cli.ts";
import { packageRoot, runNodeSubprocess, withHermeticHome, withInProcessPi } from "../helpers/pi-test-harness.ts";
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

const CONTENT_MARKERS = ["PROMPT_SECRET_BYTES", "transcript-body", "--ak-role", "excerpt-text"];

function runtimeHarness(options: {
  activate?: () => Promise<string>;
  clock?: () => string;
  writeTrace?: (record: ActivationTraceRecord) => void | Promise<void>;
  mode?: ExtensionContext["mode"];
  ledger?: ReturnType<typeof testActivationLedgerDeps>;
} = {}) {
  type Handler = (event: { reason?: string; systemPrompt?: string }, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const traces: ActivationTraceRecord[] = [];
  const ledger = options.ledger ?? testActivationLedgerDeps();
  let aborts = 0;
  const pi = {
    registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
    getFlag(name: string) { return name === "ak-role" ? "judge" : undefined; },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  createRoleRuntimeExtension({
    loadJudgeSoul: options.activate ?? (async () => { throw new TypeError("soul unavailable"); }),
    transcriptFromContext: () => "", auditSoulCompliance: async () => ({ status: "pass" }),
    activationClock: options.clock ?? (() => "2025-01-01T00:00:00.000Z"),
    activationTraceWriter: options.writeTrace ?? ((record) => { traces.push(record); }),
    ...ledger.deps,
  })(pi);
  const ctx = { mode: options.mode ?? "print", cwd: "/repository", abort() { aborts++; } } as unknown as ExtensionContext;
  const handler = (name: string): Handler => {
    const found = handlers.get(name)?.[0];
    assert.ok(found, `missing ${name} handler`);
    return found;
  };
  return { handler, traces, ctx, aborts: () => aborts, facts: ledger.facts };
}

function roleActivationHarness(options: {
  role: string;
  clock?: () => string;
  correlation?: import("../../src/activation-ledger.ts").ActivationCorrelationIdentity;
  bookKey?: string;
  sessionPath?: string;
  appendError?: Error;
  mode?: ExtensionContext["mode"];
}) {
  type Handler = (event: { reason?: string; systemPrompt?: string; systemPromptOptions?: unknown; prompt?: string }, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, unknown>();
  // Host tools exist before role registration (Merger/Doctor/Collector assert exact presence).
  for (const name of ["read", "grep", "find", "ls", "bash", "write", "edit", "Agent"]) {
    tools.set(name, { name });
  }
  let activeTools: string[] = [];
  const ledger = testActivationLedgerDeps({
    bookKey: options.bookKey ?? "envelope-book",
    ...(options.correlation === undefined ? {} : { correlation: options.correlation }),
    session: { kind: "session-file", path: options.sessionPath ?? "/ledger/home/session.jsonl" },
    ...(options.appendError === undefined ? {} : { appendError: options.appendError }),
  });
  let aborts = 0;
  let providerTurns = 0;
  const oid = (ch: string) => ch.repeat(40);
  const fixtureRoot = mkdtempSync(join(tmpdir(), "ak-role-admit-"));
  const legsPath = join(fixtureRoot, "legs.json");
  writeFileSync(legsPath, `${JSON.stringify({
    legs: [{ id: "codex", expectedAuthors: ["codexbot"], request: { body: "Please review." } }],
  })}\n`);
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
  const flags: Record<string, unknown> = {
    "ak-role": options.role,
    "ak-fixer-phase": "plan",
    "ak-fix-packet": "/lawful/packet.md",
    "ak-coder-phase": "plan",
    "ak-coder-task": "/lawful/task.md",
    "ak-review-task": "/lawful/review-task.md",
    "ak-review-capabilities": "/lawful/review-caps.md",
    "ak-doctor-case": "/lawful/case",
    "ak-merger-input": "/lawful/merger.json",
    "ak-collector-repo": "acme/widgets",
    "ak-collector-pr": "1",
    "ak-collector-legs": legsPath,
  };
  const pi = {
    registerFlag() {},
    registerTool(tool: { name: string }) { tools.set(tool.name, tool); },
    setActiveTools(names: string[]) { activeTools = [...names]; },
    getActiveTools() { return [...activeTools]; },
    getAllTools() { return [...tools.values()]; },
    getCommands() { return []; },
    getFlag(name: string) { return flags[name]; },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;

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

  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "LAW",
    loadFixerSoul: async () => "LAW",
    loadFixPacket: async () => "Repair the findings.\n",
    loadCoderSoul: async () => "LAW",
    loadCoderTask: async () => "Build it.\n",
    loadReviewerSoul: async () => "LAW",
    loadReviewerTask: async () => reviewTask,
    loadReviewerCapabilities: async () => reviewCaps,
    createReviewerPinnedGitReader: async () => {
      const pin = {
        repositoryRoot: "/repo",
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
    loadCollectorSoul: async () => "LAW",
    createCollectorTransport: () => createFakeGitHubTransport({
      user: sampleUser(),
      pullRequest: samplePull(),
      reviews: [],
      issueComments: [],
      reviewComments: [],
    }),
    loadDoctorSoul: async () => "LAW",
    loadDoctorCase: async () => ({
      version: 1 as const,
      identity: { issueNumber: 1, runsPath: "/lawful/case" },
      cost: emptyDoctorCost,
      evidence: [],
    }),
    auditDoctorCompliance: async () => ({ status: "pass" as const }),
    loadMergerSoul: async () => "LAW",
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
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
    activationClock: options.clock ?? (() => "2025-01-01T00:00:00.000Z"),
    activationTraceWriter: () => {},
    ...ledger.deps,
  })(pi);
  const ctx = {
    mode: options.mode ?? "print",
    cwd: "/repository",
    abort() { aborts++; },
    sessionManager: {
      getSessionDir: () => "/ledger/home/session",
      getSessionFile: () => options.sessionPath ?? "/ledger/home/session.jsonl",
    },
  } as unknown as ExtensionContext;
  return {
    handlers,
    facts: ledger.facts,
    ctx,
    aborts: () => aborts,
    dispose() {
      rmSync(fixtureRoot, { recursive: true, force: true });
    },
    async start() {
      const start = handlers.get("session_start")?.[0];
      assert.ok(start);
      await start({ reason: "startup" }, ctx);
    },
    async tryProvider() {
      for (const before of handlers.get("before_agent_start") ?? []) await before({
        systemPrompt: "BASE",
        systemPromptOptions: {},
        prompt: "go",
      }, ctx);
      providerTurns++;
    },
    providerTurns: () => providerTurns,
  };
}

test("every registered whole-activation rejection terminates nonzero with a named cause before a model turn", async () => {
  for (const entry of PACKAGED_ROLE_REGISTRY) {
    process.exitCode = undefined;
    const handlers = new Map<string, Array<(event: { reason?: string }, ctx: ExtensionContext) => unknown>>();
    const traces: ActivationTraceRecord[] = [];
    const ledger = testActivationLedgerDeps({ bookKey: "reject-book" });
    let aborts = 0;
    let providerTurns = 0;
    const flags: Record<string, unknown> = {
      "ak-role": entry.role,
      "ak-doctor-case": "/lawful/case",
      "ak-merger-input": "/lawful/merger.json",
    };
    const rejection = new TypeError(`${entry.role} activation rejected`);
    const reject = async (): Promise<never> => { throw rejection; };
    const pi = {
      registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
      getFlag(name: string) { return flags[name]; },
      on(name: string, handler: (event: { reason?: string }, ctx: ExtensionContext) => unknown) {
        handlers.set(name, [...(handlers.get(name) ?? []), handler]);
      },
    } as unknown as ExtensionAPI;
    createRoleRuntimeExtension({
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
      ...ledger.deps,
    })(pi);
    const ctx = { mode: "print", cwd: "/repository", abort() { aborts++; } } as unknown as ExtensionContext;
    const start = handlers.get("session_start")?.[0];
    assert.ok(start);
    await assert.rejects(async () => start({ reason: "startup" }, ctx), rejection);

    // Pi reaches its provider only after all before_agent_start handlers admit dispatch.
    await assert.rejects(async () => {
      for (const before of handlers.get("before_agent_start") ?? []) await before({}, ctx);
      providerTurns++;
    }, (error: unknown) => error instanceof ActivationBarrierError);
    assert.equal(providerTurns, 0, `${entry.role} reached the provider`);
    assert.equal(aborts, 2);
    assert.equal(process.exitCode, 1);
    assert.equal(ledger.facts.length, 0, `${entry.role} wrote an accepted-activation fact on rejection`);
    const failed = traces.find((trace) => trace.status === "failed");
    assert.ok(failed && failed.status === "failed");
    assert.equal(failed.cause.identity, "TypeError");
    assert.equal(failed.cause.name, "TypeError");
    assert.equal(failed.cause.message, `${entry.role} activation rejected`);
    if (typeof failed.cause.evidenceId !== "string") throw new Error("missing activation evidence id");
    assert.match(failed.cause.evidenceId, /^activation-cause-/);
  }
});

test("every registered role writes exactly one accepted-activation fact after admission", async () => {
  assert.ok(PACKAGED_ROLE_REGISTRY.some((entry) => entry.role === "collector"), "Collector must remain in the #52 registry gate");
  const harnesses: Array<{ dispose(): void }> = [];
  try {
    for (const entry of PACKAGED_ROLE_REGISTRY) {
      process.exitCode = undefined;
      const withCorrelation = roleActivationHarness({
        role: entry.role,
        correlation: { kind: "caller", id: `corr-${entry.role}` },
        sessionPath: `/sessions/${entry.role}.jsonl`,
        clock: () => "2025-06-01T12:00:00.000Z",
      });
      harnesses.push(withCorrelation);
      await withCorrelation.start();
      assert.equal(withCorrelation.facts.length, 1, `${entry.role} admitted fact count`);
      assert.deepEqual(withCorrelation.facts[0], {
        event: ACCEPTED_ACTIVATION_EVENT,
        role: entry.role,
        observedAt: "2025-06-01T12:00:00.000Z",
        bookKey: "envelope-book",
        session: { kind: "session-file", path: `/sessions/${entry.role}.jsonl` },
        correlation: { kind: "caller", id: `corr-${entry.role}` },
      });

      const missingCorrelation = roleActivationHarness({
        role: entry.role,
        correlation: { kind: "absent" },
        sessionPath: `/sessions/${entry.role}-absent.jsonl`,
      });
      harnesses.push(missingCorrelation);
      await missingCorrelation.start();
      assert.equal(missingCorrelation.facts.length, 1);
      assert.deepEqual(missingCorrelation.facts[0]?.correlation, { kind: "absent" });
    }

    // Envelope barrier opens only after admitted fact write (judge is a bare role with no extra before_agent_start policy).
    const admitted = roleActivationHarness({ role: "judge" });
    harnesses.push(admitted);
    await admitted.start();
    await admitted.tryProvider();
    assert.equal(admitted.providerTurns(), 1);
  } finally {
    for (const harness of harnesses) harness.dispose();
  }
});

test("unselected role and unsupported role leave zero accepted-activation facts", async () => {
  process.exitCode = undefined;
  const unselected = testActivationLedgerDeps();
  type Handler = (event: { reason?: string }, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
    getFlag() { return undefined; },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "LAW",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
    ...unselected.deps,
  })(pi);
  await handlers.get("session_start")?.[0]?.({}, { mode: "print", cwd: "/repo", abort() {} } as ExtensionContext);
  assert.equal(unselected.facts.length, 0);

  const unsupported = testActivationLedgerDeps();
  const badHandlers = new Map<string, Handler[]>();
  const badPi = {
    registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
    getFlag(name: string) { return name === "ak-role" ? "router" : undefined; },
    on(name: string, handler: Handler) { badHandlers.set(name, [...(badHandlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "LAW",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
    ...unsupported.deps,
  })(badPi);
  await assert.rejects(async () => badHandlers.get("session_start")?.[0]?.({}, {
    mode: "print", cwd: "/repo", abort() {},
  } as ExtensionContext));
  assert.equal(unsupported.facts.length, 0);
});

test("non-git cwd fails before model dispatch with zero accepted facts", async () => {
  process.exitCode = undefined;
  const facts: AcceptedActivationFact[] = [];
  type Handler = (event: { reason?: string }, ctx: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  let aborts = 0;
  let soulLoads = 0;
  let providerTurns = 0;
  const pi = {
    registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
    getFlag(name: string) { return name === "ak-role" ? "judge" : undefined; },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => { soulLoads += 1; return "LAW"; },
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
    activationTraceWriter: () => {},
    appendActivationLedgerFact: async (fact) => { facts.push(fact); },
    // production book-key path — no override
  })(pi);
  const nonGit = mkdtempSync(join(tmpdir(), "ak-nongit-"));
  try {
    const ctx = { mode: "print" as const, cwd: nonGit, abort() { aborts++; } };
    await assert.rejects(async () => handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx as ExtensionContext), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /git rev-parse --git-common-dir/);
      assert.ok(error.cause !== undefined, "original git cause must be retained");
      return true;
    });
    assert.equal(soulLoads, 0, "activation stage must not run before book-key resolution");
    assert.equal(facts.length, 0);
    assert.equal(aborts, 1);
    assert.equal(process.exitCode, 1);
    await assert.rejects(async () => {
      for (const before of handlers.get("before_agent_start") ?? []) await before({}, ctx as ExtensionContext);
      providerTurns++;
    }, (error: unknown) => error instanceof ActivationBarrierError);
    assert.equal(providerTurns, 0);
  } finally {
    rmSync(nonGit, { recursive: true, force: true });
  }
});

test("append failure preserves original cause, aborts nonzero, and blocks provider turns", async () => {
  process.exitCode = undefined;
  const appendError = new Error("disk full");
  const h = roleActivationHarness({ role: "judge", appendError });
  try {
    await assert.rejects(async () => h.start(), (error: unknown) => error === appendError);
    assert.equal(h.facts.length, 0);
    assert.equal(h.aborts(), 1);
    assert.equal(process.exitCode, 1);
    await assert.rejects(async () => h.tryProvider(), (error: unknown) => error instanceof ActivationBarrierError);
    assert.equal(h.providerTurns(), 0);
  } finally {
    h.dispose();
  }
});

test("accepted-activation serializer emits only index keys and zero known content bytes", () => {
  const fact = buildAcceptedActivationFact({
    role: "judge",
    observedAt: "2025-01-01T00:00:00.000Z",
    bookKey: "demo",
    session: { kind: "session-file", path: "/home/session.jsonl" },
    correlation: { kind: "caller", id: "c1" },
  });
  const smuggled = {
    ...fact,
    prompt: "PROMPT_SECRET_BYTES",
    transcript: "transcript-body",
    argv: ["--ak-role", "judge"],
    excerpt: "excerpt-text",
    content: "nope",
  } as AcceptedActivationFact & Record<string, unknown>;
  const line = serializeAcceptedActivationFact(smuggled);
  const parsed = JSON.parse(line) as Record<string, unknown>;
  assert.deepEqual(Object.keys(parsed).sort(), [
    "bookKey",
    "correlation",
    "event",
    "observedAt",
    "role",
    "session",
  ]);
  for (const marker of CONTENT_MARKERS) {
    assert.equal(line.includes(marker), false, `serialized fact must not contain ${marker}`);
  }
  assert.deepEqual(correlationIdentityFromEnv({}), { kind: "absent" });
  assert.deepEqual(correlationIdentityFromEnv({ AK_CORRELATION_ID: "" }), { kind: "absent" });
  assert.deepEqual(correlationIdentityFromEnv({ AK_CORRELATION_ID: "abc" }), { kind: "caller", id: "abc" });
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
    // linked worktree still points at renamed common dir host after directory rename of main checkout
    assert.equal(resolveBookKeyFromGit(renamed), "project-beta");

    const twin = join(root, "collision", "project-beta");
    mkdirSync(join(root, "collision"), { recursive: true });
    mkdirSync(twin);
    execFileSync("git", ["init", "-b", "main"], { cwd: twin, stdio: "ignore" });
    assert.equal(resolveBookKeyFromGit(twin), "project-beta");
    assert.equal(resolveBookKeyFromGit(renamed), resolveBookKeyFromGit(twin));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent child processes append intact JSONL records with exact cardinality", async () => {
  const root = mkdtempSync(join(tmpdir(), "ak-ledger-conc-"));
  const ledgerHome = join(root, "home");
  const bookKey = "concurrent-book";
  const ledgerPath = activationWaitingLedgerPath(ledgerHome, bookKey);
  const worker = join(root, "worker.mjs");
  writeFileSync(worker, `
import { appendAcceptedActivationFact, buildAcceptedActivationFact } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "src/activation-ledger.ts")).href)};
const index = Number(process.argv[2]);
const ledgerPath = process.argv[3];
appendAcceptedActivationFact(ledgerPath, buildAcceptedActivationFact({
  role: "judge",
  observedAt: new Date(Date.UTC(2025, 0, 1, 0, 0, index)).toISOString(),
  bookKey: "concurrent-book",
  session: { kind: "session-file", path: "/s/" + index + ".jsonl" },
  correlation: { kind: "caller", id: "c-" + index },
}));
`);
  const children = await Promise.all(Array.from({ length: 12 }, (_, index) =>
    runNodeSubprocess(
      ["--import", "tsx", worker, String(index), ledgerPath],
      { cwd: packageRoot, timeoutMs: 15_000 },
    )));
  for (const child of children) {
    assert.equal(child.code, 0, child.stderr);
  }
  const lines = readFileSync(ledgerPath, "utf8").split("\n").filter(Boolean);
  assert.equal(lines.length, 12);
  const ids = lines.map((line) => {
    const row = JSON.parse(line) as AcceptedActivationFact;
    assert.equal(row.event, ACCEPTED_ACTIVATION_EVENT);
    assert.equal(row.bookKey, bookKey);
    assert.equal(row.correlation.kind, "caller");
    return row.correlation.kind === "caller" ? row.correlation.id : "";
  });
  assert.deepEqual(ids.sort(), Array.from({ length: 12 }, (_, i) => `c-${i}`).sort());
  rmSync(root, { recursive: true, force: true });
});

test("real subprocess activation writes one enumerable fact; non-git writes none", async () => {
  await withHermeticHome({ prefix: "ak-act-subproc-" }, async ({ home, agentDir }) => {
    const ledgerHome = join(home, "roles-home");
    const repo = join(home, "repo-main");
    mkdirSync(repo);
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    const sessionDir = join(ledgerHome, "books", "repo-main", "sessions", "run-1");
    mkdirSync(sessionDir, { recursive: true });

    const ok = await runNodeSubprocess([
      "--import", "tsx", "-e",
      `
import { createRoleRuntimeExtension } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "src/role-runtime.ts")).href)};
const handlers = new Map();
const pi = {
  registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
  getFlag(name) { return name === "ak-role" ? "judge" : undefined; },
  on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
};
createRoleRuntimeExtension({
  loadJudgeSoul: async () => "LAW",
  transcriptFromContext: () => "",
  auditSoulCompliance: async () => ({ status: "pass" }),
  activationClock: () => "2025-01-02T00:00:00.000Z",
  activationTraceWriter: () => {},
  resolveActivationLedgerHome: () => process.env.AK_ROLES_HOME,
  resolveActivationCorrelation: () => ({ kind: "caller", id: "subproc-1" }),
})(pi);
const ctx = {
  mode: "print",
  cwd: process.env.REPO_CWD,
  abort() {},
  sessionManager: {
    getSessionDir: () => process.env.SESSION_DIR,
    getSessionFile: () => process.env.SESSION_DIR + "/session.jsonl",
  },
};
await handlers.get("session_start")[0]({ reason: "startup" }, ctx);
`,
    ], {
      cwd: packageRoot,
      env: {
        ...process.env,
        AK_ROLES_HOME: ledgerHome,
        REPO_CWD: repo,
        SESSION_DIR: sessionDir,
        HOME: home,
        PI_CODING_AGENT_DIR: agentDir,
      },
      timeoutMs: 20_000,
    });
    assert.equal(ok.code, 0, ok.stderr);
    const ledgerPath = activationWaitingLedgerPath(ledgerHome, "repo-main");
    const lines = readFileSync(ledgerPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    const fact = JSON.parse(lines[0]!) as AcceptedActivationFact;
    assert.equal(fact.event, ACCEPTED_ACTIVATION_EVENT);
    assert.equal(fact.role, "judge");
    assert.equal(fact.bookKey, "repo-main");
    assert.deepEqual(fact.session, { kind: "session-file", path: join(sessionDir, "session.jsonl") });
    assert.deepEqual(fact.correlation, { kind: "caller", id: "subproc-1" });
    // enumerable home → book → fact chain
    assert.deepEqual(readdirSync(join(ledgerHome, "books")), ["repo-main"]);

    // Outside the hermetic home so parent-directory git discovery cannot find a repo.
    const nonGit = mkdtempSync(join(tmpdir(), "ak-truly-nongit-"));
    const emptyHome = join(home, "empty-home");
    mkdirSync(emptyHome);
    const bad = await runNodeSubprocess([
      "--import", "tsx", "-e",
      `
import { createRoleRuntimeExtension } from ${JSON.stringify(pathToFileURL(resolve(packageRoot, "src/role-runtime.ts")).href)};
const handlers = new Map();
const pi = {
  registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
  getFlag(name) { return name === "ak-role" ? "judge" : undefined; },
  on(name, handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
};
createRoleRuntimeExtension({
  loadJudgeSoul: async () => "LAW",
  transcriptFromContext: () => "",
  auditSoulCompliance: async () => ({ status: "pass" }),
  activationTraceWriter: () => {},
  resolveActivationLedgerHome: () => process.env.AK_ROLES_HOME,
})(pi);
const ctx = { mode: "print", cwd: process.env.REPO_CWD, abort() {}, sessionManager: { getSessionDir: () => "/tmp", getSessionFile: () => undefined } };
try {
  await handlers.get("session_start")[0]({ reason: "startup" }, ctx);
  process.exitCode = 0;
} catch (error) {
  process.exitCode = 1;
  if (!(error instanceof Error) || !/git rev-parse --git-common-dir/.test(error.message)) process.exitCode = 2;
}
`,
    ], {
      cwd: packageRoot,
      env: { ...process.env, AK_ROLES_HOME: emptyHome, REPO_CWD: nonGit, HOME: home },
      timeoutMs: 20_000,
    });
    assert.equal(bad.code, 1, bad.stderr);
    assert.equal(readdirSync(emptyHome).length, 0);
    rmSync(nonGit, { recursive: true, force: true });
  });
});

test("incident 2026-08-02: malformed Fixer prerequisites fail the real Pi subprocess before provider dispatch", async () => {
  // Shared CLI harness with audit-failure-subprocess (same extension pair + provider + hermetic home).
  const result = await runFixerAuditFailureCli({
    packet: "Apply the assigned repair.\n",
    prerequisites: { prerequisites: [] },
    noSession: true,
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
  assert.match(failed.cause.message, /Fixer prerequisites/);
});

test("failed trace emission cannot mask the activation cause or skip termination", async () => {
  const activationError = new TypeError("soul unavailable");
  const traceError = new Error("trace unavailable");
  let writes = 0;
  const h = runtimeHarness({
    activate: async () => { throw activationError; },
    writeTrace: async () => { if (++writes === 1) throw traceError; },
  });
  await assert.rejects(
    async () => h.handler("session_start")({}, h.ctx),
    (error: unknown) => error instanceof AggregateError && error.errors[0] === activationError && error.errors[1] === traceError,
  );
  assert.equal(h.aborts(), 1);
  assert.equal(process.exitCode, 1);
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

for (const [mode, expected] of [["print", 1], ["json", 1], ["tui", undefined], ["rpc", undefined]] as const) {
  test(`activation failure applies ${mode} exit-code policy`, async () => {
    process.exitCode = undefined;
    const h = runtimeHarness({ mode });
    await assert.rejects(async () => h.handler("session_start")({}, h.ctx));
    assert.equal(process.exitCode, expected);
  });
}

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

test("shared role runtime registers tool observation only after admitted activation and never writes stdout", async () => {
  const observations: ToolExecutionObservationRecord[] = [];
  const ledger = testActivationLedgerDeps();
  type Handler = (event: Record<string, unknown>, ctx?: ExtensionContext) => unknown;
  const handlers = new Map<string, Handler[]>();
  const pi = {
    registerFlag() {}, registerTool() {}, setActiveTools() {}, getActiveTools() { return []; }, getAllTools() { return []; },
    getFlag(name: string) { return name === "ak-role" ? "judge" : undefined; },
    on(name: string, handler: Handler) { handlers.set(name, [...(handlers.get(name) ?? []), handler]); },
  } as unknown as ExtensionAPI;
  createRoleRuntimeExtension({
    loadJudgeSoul: async () => "LAW",
    transcriptFromContext: () => "",
    auditSoulCompliance: async () => ({ status: "pass" }),
    activationClock: () => "2025-01-01T00:00:00.000Z",
    activationTraceWriter: () => {},
    toolExecutionObservationWriter: (record) => { observations.push(record); },
    ...ledger.deps,
  })(pi);

  const startHandler = handlers.get("tool_execution_start")?.[0];
  const updateHandler = handlers.get("tool_execution_update")?.[0];
  const endHandler = handlers.get("tool_execution_end")?.[0];
  assert.ok(startHandler && updateHandler && endHandler);

  await startHandler({ toolCallId: "pre", toolName: "bash" });
  await updateHandler({ toolCallId: "pre", toolName: "bash", partialResult: { content: [{ type: "text", text: "x" }] } });
  await endHandler({ toolCallId: "pre", toolName: "bash", isError: false });
  assert.equal(observations.length, 0);

  const sessionStart = handlers.get("session_start")?.[0];
  assert.ok(sessionStart);
  await sessionStart({ reason: "startup" }, { mode: "print", cwd: "/repo", abort() {} } as unknown as ExtensionContext);
  assert.equal(ledger.facts.length, 1);

  await startHandler({ toolCallId: "post", toolName: "bash" });
  await updateHandler({ toolCallId: "post", toolName: "bash", partialResult: { content: [] } });
  await updateHandler({ toolCallId: "post", toolName: "bash", partialResult: { content: [{ type: "text", text: "hello" }] } });
  await endHandler({ toolCallId: "post", toolName: "bash", isError: true });
  assert.deepEqual(observations.map((record) => ({
    event: record.event,
    toolCallId: record.toolCallId,
    toolName: record.toolName,
    role: record.role,
    ...(record.event === "tool_execution_end" ? { isError: record.isError } : {}),
  })), [
    { event: "tool_execution_start", toolCallId: "post", toolName: "bash", role: "judge" },
    { event: "tool_execution_update", toolCallId: "post", toolName: "bash", role: "judge" },
    { event: "tool_execution_end", toolCallId: "post", toolName: "bash", role: "judge", isError: true },
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
  await withHermeticHome({ prefix: "ak-tool-obs-fail-" }, async ({ home, agentDir }) => {
    const faux = fauxProvider({ api: "ak-tool-obs-fail", provider: "ak-tool-obs-fail" });
    const writerError = new Error("stderr unavailable");
    const priorExitCode = process.exitCode;
    process.exitCode = undefined;
    let aborts = 0;
    const extensionErrors: ExtensionError[] = [];
    try {
      await withInProcessPi({
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
          ...testActivationLedgerDeps().deps,
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
