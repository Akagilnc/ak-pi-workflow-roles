import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { tmpdir } from "node:os";

import { runPublicCliSubprocess } from "../helpers/public-cli-subprocess.ts";
import {
  constructionProvenance,
  getSharedIsolatedPack,
  packageRoot,
  runNodeSubprocess,
  runPiSubprocess,
  withHermeticHome,
  withProcessCwd,
} from "../helpers/pi-test-harness.ts";
import {
  TestSubprocessOperationalError,
} from "../helpers/test-subprocess.ts";

test("subprocess result seam classifies localTimeout, signal, nonzero exit, clean exit, and post-exit deadline", async () => {
  const localTimeoutMs = 0;
  const timed = await runPiSubprocess(["--help"], {
    cwd: packageRoot,
    timeoutMs: localTimeoutMs,
  });
  assert.equal(timed.localTimeout, true);
  assert.equal(timed.localTimeoutOwner, "runPiSubprocess");
  assert.equal(timed.localTimeoutMs, localTimeoutMs);
  assert.equal(timed.code, null);
  assert.equal(timed.signal, "SIGTERM");

  const signaled = await runNodeSubprocess(
    ["-e", "process.kill(process.pid, 'SIGTERM')"],
    { cwd: packageRoot, timeoutMs: 15_000 },
  );
  assert.equal(signaled.localTimeout, false);
  assert.equal(signaled.localTimeoutOwner, null);
  assert.equal(signaled.localTimeoutMs, null);
  assert.equal(signaled.signal, "SIGTERM");
  assert.equal(signaled.code, null);

  const failed = await runNodeSubprocess(
    ["-e", "process.stderr.write('ERR_ASSERTION boom'); process.exit(7)"],
    { cwd: packageRoot, timeoutMs: 15_000 },
  );
  assert.equal(failed.localTimeout, false);
  assert.equal(failed.signal, null);
  assert.equal(failed.code, 7);
  assert.equal(failed.stderr, "ERR_ASSERTION boom");

  const clean = await runNodeSubprocess(
    ["-e", "process.stdout.write('ok'); process.exit(0)"],
    { cwd: packageRoot, timeoutMs: 15_000 },
  );
  assert.equal(clean.localTimeout, false);
  assert.equal(clean.signal, null);
  assert.equal(clean.code, 0);
  assert.equal(clean.stdout, "ok");

  // Causal order (not a tight timer race): parent exits(42) immediately after
  // spawning a detached descendant that inherits stdio; deadline has ample
  // margin so exit precedes it under load; descendant hold strictly past the
  // deadline keeps close pending. Classification must follow exit facts.
  const postExitDeadlineMs = 2_000;
  const postExitHoldMs = postExitDeadlineMs + 500;
  const postExit = await runNodeSubprocess(
    [
      "-e",
      [
        "const { spawn } = require('node:child_process');",
        `const hold = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${postExitHoldMs})'], {`,
        "  stdio: ['ignore', 'inherit', 'inherit'],",
        "  detached: true,",
        "});",
        "hold.unref();",
        "process.stdout.write('exited-before-close');",
        "process.exit(42);",
      ].join(""),
    ],
    { cwd: packageRoot, timeoutMs: postExitDeadlineMs },
  );
  assert.equal(postExit.localTimeout, false);
  assert.equal(postExit.localTimeoutOwner, null);
  assert.equal(postExit.localTimeoutMs, null);
  assert.equal(postExit.signal, null);
  assert.equal(postExit.code, 42);
  assert.equal(postExit.stdout, "exited-before-close");

  await assert.rejects(
    () =>
      runPublicCliSubprocess("/no/such/ak-roles-bin", ["--help"], {
        home: packageRoot,
        agentDir: packageRoot,
        cwd: packageRoot,
        timeoutMs: 1_000,
      }),
    (error: unknown) => {
      assert.ok(error instanceof TestSubprocessOperationalError);
      // Operational rejection must carry available facts at reject time
      // (code/signal/local-deadline/collected stdout/stderr) — same contract
      // for spawn and stdout/stderr collection errors on the unified path.
      assert.equal(error.code, "ENOENT");
      assert.equal(error.signal, null);
      assert.equal(error.localTimeout, false);
      assert.equal(error.localTimeoutOwner, null);
      assert.equal(error.localTimeoutMs, null);
      assert.equal(error.stdout, "");
      assert.equal(error.stderr, "");
      return true;
    },
  );

  // Post-exit collection error on the real helper: descendant holds stdio so
  // exit is recorded while pipes stay open; test-side ChildProcess.emit wrap
  // (not a production hook) destroys stdout after exit listeners run. Must
  // keep process code/signal — not stream errno — plus localTimeout facts and
  // collected output. Reverting exited?exitCode/exitSignal selection fails this.
  const collectionHoldMs = 2_000;
  const originalEmit = ChildProcess.prototype.emit;
  ChildProcess.prototype.emit = function (
    this: ChildProcess,
    event: string | symbol,
    ...args: unknown[]
  ): boolean {
    if (event === "exit" && args[0] === 7) {
      const emitted = originalEmit.apply(this, arguments as never);
      if (this.stdout && !this.stdout.destroyed) {
        this.stdout.destroy(
          Object.assign(new Error("forced collection"), {
            code: "ERR_STREAM_DESTROYED",
          }),
        );
      }
      return emitted;
    }
    return originalEmit.apply(this, arguments as never);
  };
  try {
    await assert.rejects(
      () =>
        runNodeSubprocess(
          [
            "-e",
            [
              "const { spawn } = require('node:child_process');",
              `const hold = spawn(process.execPath, ['-e', 'setTimeout(() => {}, ${collectionHoldMs})'], {`,
              "  stdio: ['ignore', 'inherit', 'inherit'],",
              "  detached: true,",
              "});",
              "hold.unref();",
              "process.stdout.write('out');",
              "process.stderr.write('err');",
              "process.exit(7);",
            ].join(""),
          ],
          { cwd: packageRoot, timeoutMs: 15_000 },
        ),
      (error: unknown) => {
        assert.ok(error instanceof TestSubprocessOperationalError);
        assert.equal(error.code, 7);
        assert.equal(error.signal, null);
        assert.equal(error.localTimeout, false);
        assert.equal(error.localTimeoutOwner, null);
        assert.equal(error.localTimeoutMs, null);
        assert.equal(error.stdout, "out");
        assert.equal(error.stderr, "err");
        return true;
      },
    );
  } finally {
    ChildProcess.prototype.emit = originalEmit;
  }
});

test("hermetic HOME restores the exact prior value and recursively cleans up after a throw", async () => {
  const originalHome = process.env.HOME;
  const priorHome = "/preserved/home/value";
  const sentinel = { reason: "callback sentinel" };
  let allocatedHome: string | undefined;

  process.env.HOME = priorHome;
  try {
    await assert.rejects(
      withHermeticHome({ prefix: "ak-harness-cleanup-" }, async ({ home }) => {
        allocatedHome = home;
        assert.equal(process.env.HOME, home);
        await mkdir(resolve(home, "nested", "tree"), { recursive: true });
        await writeFile(
          resolve(home, "nested", "tree", "evidence.txt"),
          "evidence",
        );
        throw sentinel;
      }),
      (error) => {
        assert.equal(error, sentinel);
        return true;
      },
    );
    assert.equal(process.env.HOME, priorHome);
    assert.ok(allocatedHome);
    await assert.rejects(access(allocatedHome), { code: "ENOENT" });
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("withProcessCwd restores the prior working directory after a throw", async () => {
  const prior = process.cwd();
  const target = await realpathMkdir();
  const sentinel = { reason: "cwd sentinel" };
  await assert.rejects(
    withProcessCwd(target, async () => {
      assert.equal(process.cwd(), target);
      throw sentinel;
    }),
    (error) => {
      assert.equal(error, sentinel);
      return true;
    },
  );
  assert.equal(process.cwd(), prior);
});

async function realpathMkdir(): Promise<string> {
  return await realpath(await mkdtemp(resolve(tmpdir(), "ak-cwd-scope-")));
}

interface DistSnapshotEntry {
  size: number;
  mtimeMs: number;
  sha256: string;
}

type DistSnapshot = Map<string, DistSnapshotEntry>;

function walkFiles(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, name.name);
      if (name.isDirectory()) stack.push(full);
      else if (name.isFile() || name.isSymbolicLink()) out.push(full);
    }
  }
  return out.sort();
}

async function snapshotDistTree(distRoot: string): Promise<DistSnapshot> {
  const snapshot: DistSnapshot = new Map();
  for (const full of walkFiles(distRoot)) {
    const rel = relative(distRoot, full).split("\\").join("/");
    const st = statSync(full);
    const body = await readFile(full);
    snapshot.set(rel, {
      size: st.size,
      mtimeMs: st.mtimeMs,
      sha256: createHash("sha256").update(body).digest("hex"),
    });
  }
  return snapshot;
}

function assertDistSnapshotUnchanged(
  before: DistSnapshot,
  after: DistSnapshot,
): void {
  assert.deepEqual(
    [...after.keys()],
    [...before.keys()],
    "shared dist inventory must be unchanged by isolated packs",
  );
  for (const [rel, prior] of before) {
    const next = after.get(rel);
    assert.ok(next, `missing shared dist entry after packs: ${rel}`);
    assert.deepEqual(
      next,
      prior,
      `shared dist entry mutated during isolated packs: ${rel}`,
    );
  }
}

async function exerciseSharedPackageContracts(): Promise<void> {
  // Previously-failing chain: terminating-tools imports judge-output from shared dist.
  const terminatingUrl = pathToFileURL(
    resolve(packageRoot, "dist/package-contracts/terminating-tools.js"),
  ).href;
  // Cache-bust so each iteration re-reads from disk (race class is partial rewrite).
  const mod = await import(`${terminatingUrl}?t=${Date.now()}-${Math.random()}`);
  assert.equal(typeof mod.isTerminatingToolName, "function");
  assert.equal(typeof mod.acceptedTextFor, "function");
  assert.equal(typeof mod.validateAcceptedDetails, "function");
  assert.equal(mod.isTerminatingToolName(mod.JUDGE_OUTPUT_TOOL_NAME), true);
  assert.equal(
    mod.acceptedTextFor(mod.JUDGE_OUTPUT_TOOL_NAME),
    mod.JUDGE_ACCEPTED_TEXT,
  );
  // Touch judge-output leaf through the same graph.
  const judgeUrl = pathToFileURL(
    resolve(packageRoot, "dist/package-contracts/judge-output.js"),
  ).href;
  const judge = await import(`${judgeUrl}?t=${Date.now()}-${Math.random()}`);
  assert.equal(judge.JUDGE_OUTPUT_TOOL_NAME, mod.JUDGE_OUTPUT_TOOL_NAME);
  assert.equal(typeof judge.validateAcceptedJudgeDetails, "function");

  // Navigator package graph: attendance imports topology + registry + shared
  // typed-provider-http owner from emitted dist (never a non-entry public-cli path).
  const typedHttpUrl = pathToFileURL(
    resolve(packageRoot, "dist/typed-provider-http.js"),
  ).href;
  const typedHttp = await import(`${typedHttpUrl}?t=${Date.now()}-${Math.random()}`);
  assert.equal(typeof typedHttp.recordTypedProviderHttpStatus, "function");
  assert.equal(typeof typedHttp.clearTypedProviderHttpObservation, "function");
  assert.equal(typeof typedHttp.readLatestTypedProviderHttpObservation, "function");
  const navigatorSource = await readFile(
    resolve(packageRoot, "dist/navigator-attendance.js"),
    "utf8",
  );
  assert.match(
    navigatorSource,
    /from\s+["']\.\/typed-provider-http\.js["']/,
    "navigator-attendance must statically import the shared typed-provider-http owner",
  );
  assert.equal(
    navigatorSource.includes("public-cli/run-lifecycle"),
    false,
    "navigator-attendance must not import non-entry public-cli/run-lifecycle",
  );
  const navigatorUrl = pathToFileURL(
    resolve(packageRoot, "dist/navigator-attendance.js"),
  ).href;
  const navigator = await import(`${navigatorUrl}?t=${Date.now()}-${Math.random()}`);
  assert.equal(navigator.NAVIGATOR_EVENT_TYPE, "ak-navigator-attendance");
  assert.equal(typeof navigator.createNavigatorAttendance, "function");
  assert.ok(Array.isArray(navigator.NAVIGATOR_TARGETS));
  assert.ok(
    navigator.NAVIGATOR_TARGETS.some(
      (target: { role: string }) => target.role === "judge",
    ),
  );
  const topologyUrl = pathToFileURL(
    resolve(packageRoot, "dist/activation-ledger-topology.js"),
  ).href;
  const topology = await import(`${topologyUrl}?t=${Date.now()}-${Math.random()}`);
  assert.equal(typeof topology.resolveActivationLedgerHome, "function");
  assert.equal(typeof topology.pathContainedIn, "function");
  assert.equal(typeof topology.ActivationLedgerError, "function");
  assert.equal(
    topology.resolveActivationLedgerHome(() => "/tmp/ak-package-import-home"),
    resolve("/tmp/ak-package-import-home", ".ak-roles"),
  );
  assert.equal(
    topology.pathContainedIn("/ledger", "/ledger/books/x"),
    true,
  );
  assert.throws(
    () => topology.resolveActivationLedgerHome(() => "relative-home"),
    (error: unknown) => error instanceof topology.ActivationLedgerError,
  );

  // Activation reconciliation deep module: builder + pure reconciler (no role-runtime).
  const reconciliationUrl = pathToFileURL(
    resolve(packageRoot, "dist/activation-reconciliation.js"),
  ).href;
  const reconciliation = await import(
    `${reconciliationUrl}?t=${Date.now()}-${Math.random()}`
  );
  assert.equal(typeof reconciliation.buildDispatchStubFact, "function");
  assert.equal(typeof reconciliation.reconcileInvocation, "function");
  assert.equal(reconciliation.DISPATCH_STUB_EVENT, "dispatch-stub");
  const dispatch = reconciliation.buildDispatchStubFact({
    observedAt: "2025-06-01T12:00:00.000Z",
    bookKey: "pack-deep-book",
    dispatch: { kind: "process", pid: 4242 },
    correlation: { kind: "caller", id: "pack-deep-corr" },
  });
  const outcome = reconciliation.reconcileInvocation({
    dispatch,
    process: { state: "alive" },
  });
  assert.equal(outcome.kind, "pending");
  assert.equal(outcome.correlationId, "pack-deep-corr");
  assert.equal(outcome.bookKey, "pack-deep-book");
}

test("isolated packs leave shared dist identity stable under concurrent contract imports", async () => {
  const distRoot = resolve(packageRoot, "dist");
  const before = await snapshotDistTree(distRoot);
  assert.ok(
    before.has("package-contracts/terminating-tools.js"),
    "shared terminating-tools.js must exist before stress",
  );
  assert.ok(
    before.has("package-contracts/judge-output.js"),
    "shared judge-output.js must exist before stress",
  );

  // Structural invariant: one private pack (shared fixture) never rewrites packageRoot/dist.
  const shared = await getSharedIsolatedPack();
  assert.notEqual(shared.root, packageRoot);
  assert.ok(shared.root.startsWith(tmpdir()) || shared.cacheDir.includes("ak-pi-workflow-roles-cold-fixtures"));
  await access(shared.tarball);
  const paths = shared.files.map((file) => file.path);
  assert.ok(paths.includes("dist/package-contracts/terminating-tools.js"));
  assert.ok(paths.includes("dist/package-contracts/judge-output.js"));
  assert.ok(paths.includes("dist/navigator-attendance.js"));
  assert.ok(paths.includes("dist/typed-provider-http.js"));
  assert.ok(paths.includes("dist/activation-ledger-topology.js"));
  assert.ok(paths.includes("dist/activation-reconciliation.js"));
  assert.ok(!paths.some((path) => path.includes("recorder")));

  // Provenance must bind the fixture to the current construction HEAD.
  const live = constructionProvenance();
  assert.equal(shared.provenance.head, live.head);
  assert.equal(shared.provenance.fingerprint, live.fingerprint);

  // Keep reading the shared contract chain after the private pack completes.
  for (let i = 0; i < 8; i++) {
    await exerciseSharedPackageContracts();
  }

  const after = await snapshotDistTree(distRoot);
  assertDistSnapshotUnchanged(before, after);
});
