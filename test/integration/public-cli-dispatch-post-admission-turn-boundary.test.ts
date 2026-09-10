import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #840 r9 判词 (大理寺 r7 送修, class 1), compressed to the two external
 * contracts dispatchPostAdmissionTurn (src/public-cli/post-admission.ts)
 * owes its caller:
 *
 * ① An accepted settlement is never redone or lost to an unrelated failure
 *    that happens after it (post-settlement cleanup, e.g. clearCurrentCourt).
 *    Dispatched with the same no-op io shape every real auto-resume attempt
 *    actually receives (src/public-cli/auto-resume.ts's dummyIo — only the
 *    loop's own final presentation reaches a real caller's io), so the
 *    cleanup failure's true cause must be recovered from the dossier, not
 *    from an attempt-scoped stderr line no real caller ever sees.
 * ② A pre-turn failure (anywhere before the authoritative host write, or
 *    inside that write's own non-atomic steps) never leaves the caller's
 *    prior invocation host overwritten. One shortest tracer bullet for this
 *    contract; mutation evidence for the specific alternative trigger point
 *    (markRunRunning's own internal write ordering) was gathered during
 *    development and is not kept as a second permanent case for the same
 *    external behavior (probe lifecycle, CLAUDE.md).
 *
 * The companion contract — a settlement-authority failure after the turn
 * started still switches the caller's next real retry to a resume payload —
 * is proven at test/integration/public-cli-auto-resume-dispatch-throw.test.ts,
 * the seam that owns runWithAutoResumeLoop's retry-payload selection.
 */
import assert from "node:assert/strict";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ActivationLedgerError } from "../../src/activation-ledger-topology.ts";
import type { RoleTurnHost } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import {
  dispatchPostAdmissionTurn,
  POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE,
  type PostAdmissionAdapters,
} from "../../src/public-cli/post-admission.ts";
import { acquireRunWriterLease } from "../../src/public-cli/run-lifecycle.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import {
  acceptedTerminal,
  buildEnv,
  buildFixture,
} from "../helpers/dispatch-post-admission-fixture.ts";
import { withPrimaryAwareCleanup, withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-840-dispatch-boundary-", fn);
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (t: string) => stdout.push(t), stderr: (t: string) => stderr.push(t) } };
}

test("#840 class 1: cleanup failure after accepted settlement still reports turnDispatched, with its true cause durable in the dossier — not merely an attempt-scoped io", async () => {
  await withTempHome(async (home) => {
    const { admitted, runDirectory, request } = await buildFixture(home, "run-840-clear-court-throws", {
      courtAttemptId: "court-attempt-1",
    });
    const runStateFile = join(runDirectory, "run-state.json");
    // The dossier append reads the existing session file (fixturePrincipal
    // alone does not create it — see the sibling class-1 test in
    // public-cli-auto-resume-dispatch-throw.test.ts for the same seed).
    await writeFile(piDurablePrincipalAuthority.decode(admitted.principal).sessionFile, "{}\n", "utf8");

    let executeTurnCalls = 0;
    const roleTurnHost: RoleTurnHost = {
      executeTurn: async () => {
        executeTurnCalls += 1;
        // The host turn genuinely ran. Make the subsequent post-settle
        // clearCurrentCourt write fail — the run-state file itself is made
        // read-only so the read that clearCurrentCourt performs still
        // succeeds and only its write fails (#840 r9 判词 class 1).
        await chmod(runStateFile, 0o400);
        return { code: 0, stderr: "", timedOut: false };
      },
    };
    let trySettleCalls = 0;
    const terminal = acceptedTerminal(admitted.runId);
    const adapters: PostAdmissionAdapters<typeof admitted, TerminalResult> = {
      trySettle: async () => {
        trySettleCalls += 1;
        return terminal;
      },
    };
    const env = buildEnv({ project: admitted.projectRoot, runDirectory }, home, roleTurnHost);
    // Every real auto-resume attempt dispatches with a no-op io (dummyIo,
    // src/public-cli/auto-resume.ts) — only the loop's own final
    // presentation ever reaches a real caller's io. Dispatching with that
    // same no-op shape here — instead of a capturing io, as an earlier
    // version of this test did — proves the cleanup failure's trace
    // survives on the path a real caller actually gets, rather than
    // asserting on an attempt-scoped stderr line no real caller ever sees
    // (#840 r9 判词 r7 class 2).
    const noopIo = { stdout: () => {}, stderr: () => {} };
    const lease = await acquireRunWriterLease(runDirectory);

    await withPrimaryAwareCleanup(
      async () => {
        const result = await dispatchPostAdmissionTurn({
          admitted,
          io: noopIo,
          request,
          lease,
          adapters,
          env,
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
        // The cleanup failure's true cause must still leave a real trace even
        // though the dispatching attempt's own io was a no-op — durable in
        // the dossier (卷宗), not an attempt-scoped stderr line (失败诚实宪法
        // 真因必须落痕).
        const sessionFile = env.principalAuthority.decode(admitted.principal).sessionFile;
        const lines = (await readFile(sessionFile, "utf8")).trim().split("\n").filter(Boolean);
        const diagnosticEntries = lines
          .map((line) => JSON.parse(line) as { customType?: unknown; data?: { diagnostic?: unknown } })
          .filter((entry) => entry.customType === POST_ADMISSION_CLEANUP_DIAGNOSTIC_ENTRY_TYPE);
        assert.equal(diagnosticEntries.length, 1);
        assert.match(
          String(diagnosticEntries[0]?.data?.diagnostic),
          /current-court cleanup failed after accepted settlement/,
        );
      },
      async () => {
        await chmod(runStateFile, 0o644);
      },
    );
  });
});

test("#840 class 2: a pre-turn failure between beforeDispatch and executeTurn leaves the prior invocation host untouched", async () => {
  await withTempHome(async (home) => {
    const { admitted, runDirectory, request } = await buildFixture(home, "run-840-host-write-boundary", {
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
          env: buildEnv({ project: admitted.projectRoot, runDirectory }, home, roleTurnHost, {
            home: "relative-not-absolute-home",
            host: "new-host",
          }),
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
