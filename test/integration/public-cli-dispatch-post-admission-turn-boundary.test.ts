import { worktreeTempPrefix } from "../helpers/worktree-temp.ts";
/**
 * #840 r9 判词 (大理寺 r7 送修 → bounce 收敛), the one external contract left
 * on dispatchPostAdmissionTurn (src/public-cli/post-admission.ts) that needs
 * a direct-dispatch tracer:
 *
 * A pre-turn failure (anywhere before the authoritative host write, or
 * inside that write's own non-atomic steps) never leaves the caller's prior
 * invocation host overwritten. One shortest tracer bullet for this contract;
 * mutation evidence for the specific alternative trigger point (markRunRunning's
 * own internal write ordering) was gathered during development and is not
 * kept as a second permanent case for the same external behavior (probe
 * lifecycle, CLAUDE.md).
 *
 * The companion contract — an accepted settlement surviving a post-settlement
 * cleanup failure, with the true cause durable on two independent channels —
 * used to live here as a direct dispatchPostAdmissionTurn call with a no-op
 * io. A bounce review correctly rejected that shape: courtAttemptId-bearing
 * turns (the only ones where clearCurrentCourt runs) are always dispatched by
 * the real public CLI through runPostAdmissionManualResume, whose io is the
 * caller's own real io — not the auto-resume loop's dummyIo — so a direct
 * internal call proved nothing about what a real caller can observe. That
 * contract now lives at
 * test/integration/public-cli-same-ticket-resume.test.ts as a real `ak-role
 * resume` tracer (`#840 bounce class 1/2`), reusing this suite's own
 * established notary court sequence instead of a dedicated internal-dispatch
 * fixture.
 *
 * The settlement-authority-failure-after-turn-started contract — a failure
 * after the turn started still switches the caller's next real retry to a
 * resume payload — is proven at
 * test/integration/public-cli-auto-resume-dispatch-throw.test.ts, the seam
 * that owns runWithAutoResumeLoop's retry-payload selection.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { ActivationLedgerError } from "../../src/activation-ledger-topology.ts";
import type { RoleTurnHost } from "../../src/host-contracts.ts";
import {
  dispatchPostAdmissionTurn,
  type PostAdmissionAdapters,
} from "../../src/public-cli/post-admission.ts";
import { acquireRunWriterLease } from "../../src/public-cli/run-lifecycle.ts";
import type { TerminalResult } from "../../src/public-cli/terminal.ts";
import { buildEnv, buildFixture } from "../helpers/dispatch-post-admission-fixture.ts";
import { withTempRoot } from "../helpers/primary-aware-cleanup.ts";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempRoot("ak-840-dispatch-boundary-", fn);
}

function captureIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, io: { stdout: (t: string) => stdout.push(t), stderr: (t: string) => stderr.push(t) } };
}

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
