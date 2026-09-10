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

/** DurablePrincipalAuthority whose decode() throws starting from call N+1. */
function decodeThrowsAfter(
  base: DurablePrincipalAuthority,
  allowedCalls: number,
): DurablePrincipalAuthority {
  let calls = 0;
  return {
    ...base,
    decode(principal: unknown) {
      calls += 1;
      if (calls > allowedCalls) {
        throw new Error("decode boom (test-injected, #840 class 1 regression)");
      }
      return base.decode(principal);
    },
  };
}

/** DurablePrincipalAuthority whose isAvailable() always throws. */
function isAvailableThrows(base: DurablePrincipalAuthority): DurablePrincipalAuthority {
  return {
    ...base,
    isAvailable: async () => {
      throw new Error("isAvailable boom (test-injected, #840 class 1 last-resort net)");
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
    const principalAuthority = decodeThrowsAfter(piDurablePrincipalAuthority, 1);

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

test("#840 class 1: presentControlledFailure's own internals throwing still reports turnDispatched (last-resort net)", async () => {
  await withTempHome(async (home) => {
    const runId = "run-840-present-controlled-failure-throws";
    const { admitted, project, runDirectory } = await seedAdmittedJudge(home, runId);

    let executeTurnCalls = 0;
    const roleTurnHost: RoleTurnHost = {
      executeTurn: async () => {
        executeTurnCalls += 1;
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    let trySettleCalls = 0;
    const adapters: PostAdmissionAdapters<typeof admitted, TerminalResult> = {
      trySettle: async () => {
        trySettleCalls += 1;
        throw new Error("trySettle boom (test-injected)");
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
    };
    const { io } = captureIo();
    const lease = await acquireRunWriterLease(runDirectory);
    // presentControlledFailure's own body — not any of dispatchPostAdmissionTurn's
    // specific handlers — is what throws here (its unconditional
    // authority.isAvailable(...) call), simulating a failure inside the
    // settlement machinery itself rather than at any of the seams already
    // guarded individually.
    const principalAuthority = isAvailableThrows(piDurablePrincipalAuthority);

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
    assert.equal(trySettleCalls, 1);
    // presentControlledFailure threw while settling the trySettle throw — the
    // last-resort net must still report turnDispatched:true instead of
    // losing the dispatch fact one level further up (#840 r9 判词 class 1
    // boundary — covers failures inside the handlers themselves, not just
    // the handled exceptions they were built to settle).
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

test("#840 class 2: markRunRunning's partial progress (run-state written, host write failing) leaves the prior host untouched", async () => {
  await withTempHome(async (home) => {
    const runId = "run-840-mark-running-partial";
    const { admitted, project, runDirectory } = await seedAdmittedJudge(home, runId);
    const invocationFile = join(runDirectory, "invocation.json");
    await writeFile(invocationFile, `${JSON.stringify({ host: "prior-host" })}\n`, "utf8");

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

    // Only invocation.json is made unwritable — run-state.json stays
    // writable, so markRunRunning's run-state transition succeeds and only
    // its trailing host-page write fails (#840 r9 判词 class 2 变异真跑:
    // markRunRunning is not atomic; the fix orders the host write last so
    // this exact partial-progress window cannot leave a new host recorded).
    await chmod(invocationFile, 0o400);
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
        const invocation = JSON.parse(await readFile(invocationFile, "utf8")) as {
          host?: string;
        };
        assert.equal(invocation.host, "prior-host");
        const runState = JSON.parse(
          await readFile(join(runDirectory, "run-state.json"), "utf8"),
        ) as { state?: string };
        assert.equal(runState.state, "running");
      },
      async () => {
        await chmod(invocationFile, 0o644);
      },
    );
  });
});
