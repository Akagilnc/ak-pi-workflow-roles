import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #840 r9 判词 (大理寺 r6 送修, 2 classes): dispatchPostAdmissionTurn must not lose
 * the "host turn genuinely started" fact to an uncaught throw, and must not
 * commit the authoritative host write before every retryable pre-turn step
 * has succeeded on this attempt.
 *
 * Seam: dispatchPostAdmissionTurn (src/public-cli/post-admission.ts), called
 * directly with hand-built fixtures — the same real entry point
 * runWithAutoResumeLoop drives, without the surrounding retry loop's own
 * plumbing so each class's boundary is isolated.
 *
 * Class 1: a post-settlement cleanup failure (clearCurrentCourt) after an
 * accepted terminal must still report turnDispatched:true and the accepted
 * terminal — never an uncaught throw that would make the caller replay the
 * initial payload / this court's summons over already-delivered work.
 * Class 2: the authoritative host write (markRunRunning) must sit at the
 * real dispatch boundary — immediately before executeTurn — so a pre-turn
 * step that throws between beforeDispatch and executeTurn leaves the prior
 * invocation host untouched for the next attempt.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { ActivationLedgerError } from "../../src/activation-ledger-topology.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { appendPiSessionCustomEntry } from "../../src/pi/role-turn-host.ts";
import { fixturePrincipal } from "../helpers/admitted-principal-fixture.ts";
import type {
  DurablePrincipalAuthority,
  RoleTurnHost,
  RoleTurnRequest,
} from "../../src/host-contracts.ts";
import {
  dispatchPostAdmissionTurn,
  type PostAdmissionAdapters,
} from "../../src/public-cli/post-admission.ts";
import {
  acquireRunWriterLease,
  markRunAdmitted,
  recordCurrentCourt,
} from "../../src/public-cli/run-lifecycle.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-840-dispatch-boundary-", fn);
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (t: string) => stdout.push(t), stderr: (t: string) => stderr.push(t) } };
}

function seedGitProject(root: string) {
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.email", "840@test.local"], { cwd: root });
  execFileSync("git", ["config", "user.name", "840"], { cwd: root });
  execFileSync("git", ["commit", "--allow-empty", "-m", "seed"], { cwd: root });
}

/** Minimal admitted judge fixture, seeded through the real markRunAdmitted seam. */
async function seedAdmittedJudge(
  home: string,
  runId: string,
  extra?: { readonly ticketNumber?: number },
) {
  const project = join(home, "proj");
  await mkdir(project, { recursive: true });
  seedGitProject(project);
  const bookKey = resolveBookKeyFromGit(project);
  const runDirectory = join(home, ".ak-roles", "books", bookKey, "runs", `${runId}@judge`);
  const sessionDirectory = join(runDirectory, "session");
  const sessionFile = join(sessionDirectory, "session.jsonl");
  await mkdir(sessionDirectory, { recursive: true });
  const admittedRequestPath = join(runDirectory, "admitted-request.json");
  await writeFile(admittedRequestPath, "{}\n", "utf8");
  const admitted = {
    role: "judge" as const,
    runId,
    bookKey,
    projectRoot: project,
    instruction: "x",
    instructionEmpty: false,
    attachments: [],
    runDirectory,
    principal: fixturePrincipal(sessionDirectory, sessionFile),
    admittedRequestPath,
    ...(extra?.ticketNumber === undefined ? {} : { ticketNumber: extra.ticketNumber }),
  };
  await markRunAdmitted(admitted, piDurablePrincipalAuthority);
  // markRunAdmitted does not create invocation.json (it owns run-state.json
  // only) — markRunRunning's recordEffectiveInvocationModel merges into an
  // already-existing page, matching the real admission facade's write order.
  await writeFile(join(runDirectory, "invocation.json"), "{}\n", "utf8");
  return { admitted, project, runDirectory };
}

/**
 * DurablePrincipalAuthority whose decode() throws on exactly the Nth call and
 * succeeds on every other — isolates one specific decode call site (sessionFile
 * computation) without also breaking presentControlledFailure's own internal
 * authority.isAvailable() → decode() call that runs unconditionally afterward.
 */
function decodeThrowsOnce(
  base: DurablePrincipalAuthority,
  atCall: number,
): DurablePrincipalAuthority {
  let calls = 0;
  return {
    ...base,
    decode(principal: unknown) {
      calls += 1;
      if (calls === atCall) {
        throw new Error("decode boom (test-injected, #840 class 1 regression)");
      }
      return base.decode(principal);
    },
  };
}

test("#840 class 1: cleanup failure after accepted settlement still reports turnDispatched, not an uncaught throw", async () => {
  await withTempHome(async (home) => {
    const runId = "run-840-clear-court-throws";
    const { admitted, project, runDirectory } = await seedAdmittedJudge(home, runId);
    const courtAttemptId = "court-attempt-1";
    await recordCurrentCourt(runDirectory, { courtAttemptId });
    const runStateFile = join(runDirectory, "run-state.json");

    let executeTurnCalls = 0;
    const roleTurnHost: RoleTurnHost = {
      executeTurn: async () => {
        executeTurnCalls += 1;
        // The host turn genuinely ran (markRunRunning already committed for
        // this attempt, per class 2's fix). Make the subsequent post-settle
        // clearCurrentCourt write fail — the run-state file itself is made
        // read-only so the read that clearCurrentCourt performs still
        // succeeds and only its write fails (#840 r9 判词 class 1).
        await chmod(runStateFile, 0o400);
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    let trySettleCalls = 0;
    const acceptedTerminal: TerminalResult = {
      roleOutcome: { kind: "accepted", role: "judge", status: "converged", decisiveFacts: {} },
      navigator: { disposition: "no-advice" },
      artifacts: [],
      runId,
    };
    const adapters: PostAdmissionAdapters<typeof admitted, TerminalResult> = {
      trySettle: async () => {
        trySettleCalls += 1;
        return acceptedTerminal;
      },
    };
    const request: RoleTurnRequest = {
      principal: admitted.principal,
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "go" },
      cwd: project,
      home,
      agentDir: join(runDirectory, "agent"),
      runDirectory,
      courtAttemptId,
    };
    const { io, stderr } = captureIo();
    const lease = await acquireRunWriterLease(runDirectory);

    await withPrimaryAwareCleanup(
      async () => {
        const result = await dispatchPostAdmissionTurn({
          admitted,
          io,
          request,
          lease,
          adapters,
          env: {
            home,
            agentDir: join(runDirectory, "agent"),
            packageRoot,
            cwd: project,
            roleTurnHost,
            principalAuthority: piDurablePrincipalAuthority,
            sessionAppender: appendPiSessionCustomEntry,
          },
          persistRunState: false,
        });
        assert.equal(executeTurnCalls, 1);
        assert.equal(trySettleCalls, 1);
        // The dispatch fact must survive the cleanup failure — a caller loop
        // must see turnDispatched:true and the accepted terminal, not a
        // thrown exception that would make it replay the initial payload.
        assert.equal(result.turnDispatched, true);
        assert.equal(result.exitCode, 0);
        assert.equal(result.terminal?.roleOutcome.kind, "accepted");
        // The cleanup failure's true cause must still leave a trace — caught
        // is fine, laundered is not (失败诚实宪法).
        assert.match(stderr.join(""), /current-court cleanup failed after accepted settlement/);
      },
      async () => {
        await chmod(runStateFile, 0o644);
      },
    );
  });
});

test("#840 class 2: a pre-turn failure between beforeDispatch and executeTurn leaves the prior invocation host untouched", async () => {
  await withTempHome(async (home) => {
    const runId = "run-840-host-write-boundary";
    const { admitted, project, runDirectory } = await seedAdmittedJudge(home, runId, {
      ticketNumber: 123,
    });
    // Seed a recorded prior host, matching a real admission page (#617 DK-4).
    await writeFile(
      join(runDirectory, "invocation.json"),
      `${JSON.stringify({ host: "prior-host" })}\n`,
      "utf8",
    );

    let executeTurnCalls = 0;
    const roleTurnHost: RoleTurnHost = {
      executeTurn: async () => {
        executeTurnCalls += 1;
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    const adapters: PostAdmissionAdapters<typeof admitted, TerminalResult> = {
      trySettle: async () => undefined,
    };
    const request: RoleTurnRequest = {
      principal: admitted.principal,
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "go" },
      cwd: project,
      home,
      agentDir: join(runDirectory, "agent"),
      runDirectory,
    };
    const { io } = captureIo();
    const lease = await acquireRunWriterLease(runDirectory);

    // env.home is deliberately a non-absolute value: case-dossier pointer
    // projection (ticketNumber is bound) resolves the ticket's sitian volume
    // through this home and throws ActivationLedgerError — deterministically
    // exercising the exact pre-turn window between beforeDispatch and
    // executeTurn (#840 r9 判词 class 2 变异真跑).
    await assert.rejects(
      () =>
        dispatchPostAdmissionTurn({
          admitted,
          io,
          request,
          lease,
          adapters,
          env: {
            home: "relative-not-absolute-home",
            agentDir: join(runDirectory, "agent"),
            packageRoot,
            cwd: project,
            roleTurnHost,
            principalAuthority: piDurablePrincipalAuthority,
            sessionAppender: appendPiSessionCustomEntry,
            host: "new-host",
          },
          persistRunState: false,
        }),
      (error: unknown) => error instanceof ActivationLedgerError,
    );
    // The turn never actually started, and the authoritative host write must
    // not have run ahead of it — a retry must still read this true prior
    // host, not this failed attempt's target (#840 r9 判词 class 2).
    assert.equal(executeTurnCalls, 0);
    const invocation = JSON.parse(
      await readFile(join(runDirectory, "invocation.json"), "utf8"),
    ) as { host?: string };
    assert.equal(invocation.host, "prior-host");
  });
});

test("#840 class 1: a failure-path exception (session-file decode) after the host turn started still reports turnDispatched", async () => {
  await withTempHome(async (home) => {
    const runId = "run-840-sessionfile-decode-throws";
    const { admitted, project, runDirectory } = await seedAdmittedJudge(home, runId);

    let executeTurnCalls = 0;
    const roleTurnHost: RoleTurnHost = {
      executeTurn: async () => {
        executeTurnCalls += 1;
        return { code: 1, stderr: "boom", timedOut: false };
      },
    };
    // No settlement reached — falls through to the failure-fact resolution
    // path, where sessionFile is decoded a second time (the first decode,
    // for hostTransition, is allowed to succeed).
    const adapters: PostAdmissionAdapters<typeof admitted, TerminalResult> = {
      trySettle: async () => undefined,
    };
    const request: RoleTurnRequest = {
      principal: admitted.principal,
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "go" },
      cwd: project,
      home,
      agentDir: join(runDirectory, "agent"),
      runDirectory,
    };
    const { io } = captureIo();
    const lease = await acquireRunWriterLease(runDirectory);
    // Call 1 = early hostTransition decode (must succeed so beforeDispatch is
    // reached normally); call 2 = the sessionFile decode under test; calls 3+
    // (presentControlledFailure's own internal isAvailable() → decode()) must
    // keep succeeding — this test isolates the sessionFile seam, not
    // presentControlledFailure's own machinery.
    const principalAuthority = decodeThrowsOnce(piDurablePrincipalAuthority, 2);

    const result = await dispatchPostAdmissionTurn({
      admitted,
      io,
      request,
      lease,
      adapters,
      env: {
        home,
        agentDir: join(runDirectory, "agent"),
        packageRoot,
        cwd: project,
        roleTurnHost,
        principalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
      },
      persistRunState: false,
    });

    assert.equal(executeTurnCalls, 1);
    // The dispatch fact must survive — a caller loop must see
    // turnDispatched:true, not an uncaught throw escaping from the decode
    // call inside the failure-fact resolution path (#840 r9 判词 class 1:
    // "不限于 clearCurrentCourt 实例").
    assert.equal(result.turnDispatched, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.terminal?.roleOutcome.kind, "failure");
  });
});

test("#840 class 1: stderr.log write failure leaves a diagnostic trace instead of a silent catch", async () => {
  await withTempHome(async (home) => {
    const runId = "run-840-stderr-log-write-fails";
    const { admitted, project, runDirectory } = await seedAdmittedJudge(home, runId);
    // stderr.log's path is occupied by a directory — writeFile fails (EISDIR)
    // without disturbing any other write under the same run directory.
    await mkdir(join(runDirectory, "stderr.log"));

    const roleTurnHost: RoleTurnHost = {
      executeTurn: async () => ({ code: 0, stderr: "hello", timedOut: false }),
    };
    const acceptedTerminal: TerminalResult = {
      roleOutcome: { kind: "accepted", role: "judge", status: "converged", decisiveFacts: {} },
      navigator: { disposition: "no-advice" },
      artifacts: [],
      runId,
    };
    const adapters: PostAdmissionAdapters<typeof admitted, TerminalResult> = {
      trySettle: async () => acceptedTerminal,
    };
    const request: RoleTurnRequest = {
      principal: admitted.principal,
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "go" },
      cwd: project,
      home,
      agentDir: join(runDirectory, "agent"),
      runDirectory,
    };
    const { io, stderr } = captureIo();
    const lease = await acquireRunWriterLease(runDirectory);

    const result = await dispatchPostAdmissionTurn({
      admitted,
      io,
      request,
      lease,
      adapters,
      env: {
        home,
        agentDir: join(runDirectory, "agent"),
        packageRoot,
        cwd: project,
        roleTurnHost,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
      },
      persistRunState: false,
    });

    // The write failure must not silently vanish while settlement proceeds
    // past it — caught is fine, laundered is not (失败诚实宪法 真因必须落痕).
    assert.match(stderr.join(""), /stderr\.log write failed/);
    assert.equal(result.turnDispatched, true);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
  });
});

test("#840 class 1: a throwing lease.release() must not override an already-computed dispatch result", async () => {
  await withTempHome(async (home) => {
    const runId = "run-840-lease-release-throws";
    const { admitted, project, runDirectory } = await seedAdmittedJudge(home, runId);

    const roleTurnHost: RoleTurnHost = {
      executeTurn: async () => ({ code: 0, stderr: "", timedOut: false }),
    };
    const acceptedTerminal: TerminalResult = {
      roleOutcome: { kind: "accepted", role: "judge", status: "converged", decisiveFacts: {} },
      navigator: { disposition: "no-advice" },
      artifacts: [],
      runId,
    };
    const adapters: PostAdmissionAdapters<typeof admitted, TerminalResult> = {
      trySettle: async () => acceptedTerminal,
    };
    const request: RoleTurnRequest = {
      principal: admitted.principal,
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "go" },
      cwd: project,
      home,
      agentDir: join(runDirectory, "agent"),
      runDirectory,
    };
    const { io, stderr } = captureIo();
    // A lease double whose release() rejects. The real acquireRunWriterLease
    // release() is proven non-throwing (createWriterLease reports cleanup
    // failures via a callback, never throws) — this models the general
    // finally-throws-and-clobbers-the-return footgun defensively, since
    // dispatchPostAdmissionTurn's lease parameter is typed generically and
    // this guard is what keeps that footgun from silently reaching here.
    const lease = {
      lockPath: "unused",
      release: async () => {
        throw new Error("release boom (test-injected)");
      },
    };

    const result = await dispatchPostAdmissionTurn({
      admitted,
      io,
      request,
      lease,
      adapters,
      env: {
        home,
        agentDir: join(runDirectory, "agent"),
        packageRoot,
        cwd: project,
        roleTurnHost,
        principalAuthority: piDurablePrincipalAuthority,
        sessionAppender: appendPiSessionCustomEntry,
      },
      persistRunState: false,
    });

    assert.equal(result.turnDispatched, true);
    assert.equal(result.terminal?.roleOutcome.kind, "accepted");
    assert.match(stderr.join(""), /writer lease release failed unexpectedly/);
  });
});

test("#840 class 2: markRunRunning failing on its run-state step must not have already committed the new host", async () => {
  await withTempHome(async (home) => {
    const runId = "run-840-mark-running-partial";
    const { admitted, project, runDirectory } = await seedAdmittedJudge(home, runId);
    const invocationFile = join(runDirectory, "invocation.json");
    await writeFile(invocationFile, `${JSON.stringify({ host: "prior-host" })}\n`, "utf8");
    const runStateFile = join(runDirectory, "run-state.json");

    let executeTurnCalls = 0;
    const roleTurnHost: RoleTurnHost = {
      executeTurn: async () => {
        executeTurnCalls += 1;
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    const adapters: PostAdmissionAdapters<typeof admitted, TerminalResult> = {
      trySettle: async () => undefined,
    };
    const request: RoleTurnRequest = {
      principal: admitted.principal,
      activation: { role: "judge" },
      methods: [],
      continuation: { kind: "initial", prompt: "go" },
      cwd: project,
      home,
      agentDir: join(runDirectory, "agent"),
      runDirectory,
    };
    const { io } = captureIo();
    const lease = await acquireRunWriterLease(runDirectory);

    // run-state.json is made unwritable (its read still succeeds) while
    // invocation.json stays writable — the discriminating case (#840 r9 判词
    // class 2 变异真跑): markRunRunning is not atomic, so whichever of its two
    // writes runs first is the one a caller must trust after a mid-function
    // failure. Ordering the run-state write first (this fix) means this
    // failure aborts before the host page is ever touched; ordering the host
    // write first (the reverted state) would commit the new host, then fail
    // here — that mutation is exercised and confirmed red separately.
    await chmod(runStateFile, 0o400);
    await withPrimaryAwareCleanup(
      async () => {
        await assert.rejects(() =>
          dispatchPostAdmissionTurn({
            admitted,
            io,
            request,
            lease,
            adapters,
            env: {
              home,
              agentDir: join(runDirectory, "agent"),
              packageRoot,
              cwd: project,
              roleTurnHost,
              principalAuthority: piDurablePrincipalAuthority,
              sessionAppender: appendPiSessionCustomEntry,
              host: "new-host",
            },
            persistRunState: false,
          }),
        );
        assert.equal(executeTurnCalls, 0);
        // The only externally observable contract under test: invocation.json's
        // host must still be the true prior value, not this failed attempt's
        // target — a later retry must not lose hostTransition.
        const invocation = JSON.parse(await readFile(invocationFile, "utf8")) as {
          host?: string;
        };
        assert.equal(invocation.host, "prior-host");
      },
      async () => {
        await chmod(runStateFile, 0o644);
      },
    );
  });
});
