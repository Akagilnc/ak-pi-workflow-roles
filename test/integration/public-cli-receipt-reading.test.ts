/**
 * #1289 — how a receipt's conclusion word and seat are read after submission.
 *
 * Driven from the public entry (runAkRole). The Secretariat, 给事中 and 符宝郎
 * submit through the production envelope, so the package's own submission
 * ledger decides which seat each receipt belongs to; the gate, the settlement
 * and the ticket progress rows then read those receipts.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import type { RoleTurnHost } from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { readTicketProgressLines } from "../../src/ticket-progress.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { roleTurnHostFromStructuredOutputRounds, withNestedTrueUnboundDiarist } from "../helpers/role-turn-host-fixture.ts";
import { withSecretariatCourt } from "../helpers/seat-court-fixture.ts";

const TICKET = 1289;

/**
 * Every seat's turn submits the next receipt through the production envelope,
 * in turn order. The preliminary diarist is not under test and files no diary.
 */
function courtHost(submissions: readonly unknown[]): RoleTurnHost {
  return withNestedTrueUnboundDiarist(roleTurnHostFromStructuredOutputRounds({
    packageRoot,
    principalAuthority: piDurablePrincipalAuthority,
    submissions,
  }));
}

/** The ticket's progress rows, each with the receipt it points at (diarist rows left out). */
async function courtRows(court: { readonly home: string; readonly project: string }) {
  const subject = join(court.home, ".ak-roles", "books", resolveBookKeyFromGit(court.project), String(TICKET));
  return Promise.all(
    readTicketProgressLines(subject)
      .filter((line) => line.seat !== "diarist")
      .map(async ({ seat, status, summary, receipt }) => ({
        seat,
        ...(status === undefined ? {} : { status }),
        ...(summary === undefined ? {} : { summary }),
        receipt: JSON.parse(await readFile(join(subject, receipt), "utf8")) as unknown,
      })),
  );
}

test("#1289: a Secretariat session opened before the rename still reads by its old key, and the shared tool's receipts land on their own seats", async () => {
  const escalated = { secretariatStatus: "escalate", ticketNumber: TICKET };
  const signed = { secretariatStatus: "converged", ticketNumber: TICKET };
  const countersigned = { status: "converged", summary: "给事中署", ticketNumber: TICKET };
  const sealed = { status: "converged", summary: "符宝郎署", ticketNumber: TICKET };
  await withSecretariatCourt(1, courtHost([escalated, signed, countersigned, sealed]), async (court) => {
    const opened = await court.open();
    assert.equal(opened.exitCode, 0);
    assert.equal(opened.terminal?.roleOutcome.kind, "accepted");
    assert.equal(opened.terminal?.roleOutcome.role, "secretariat");
    // Escalate does not enter the 给事中 gate.
    assert.deepEqual(await courtRows(court), [{ seat: "secretariat", status: "escalate", receipt: escalated }]);

    const resumed = await court.resume(TICKET, "secretariat");
    assert.equal(resumed.exitCode, 0);
    assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
    assert.equal(resumed.terminal?.roleOutcome.role, "secretariat");
    // The old-key receipt is read, not asked again. 给事中 and 符宝郎 submit on one
    // shared output tool; each conclusion lands on its own seat.
    assert.deepEqual(await courtRows(court), [
      { seat: "secretariat", status: "escalate", receipt: escalated },
      { seat: "secretariat", status: "converged", receipt: signed },
      { seat: "countersign", status: "converged", summary: "给事中署", receipt: countersigned },
      { seat: "notary", status: "converged", summary: "符宝郎署", receipt: sealed },
    ]);
  });
});

for (const [name, receipt] of [
  ["with neither key", { ticketNumber: TICKET, note: "无结论字" }],
  ["whose word is outside converged/escalate", { status: "continue", ticketNumber: TICKET }],
] as const) {
  test(`#1289: a Secretariat receipt ${name} goes back to the Secretariat and stays on the ledger`, async () => {
    // One reask under the limit of 1. Entering the 给事中 gate would run out of receipts and fail the call.
    await withSecretariatCourt(1, courtHost([receipt, receipt]), async (court) => {
      // Not aborted: the call ends with the Secretariat's own volume, direction unsettled.
      const result = await court.open();
      assert.equal(result.exitCode, 0);
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.equal(result.terminal?.roleOutcome.role, "secretariat");
      assert.equal(result.terminal?.roleOutcome.decisiveFacts?.directionUnsettled, true);
      assert.deepEqual((await courtRows(court)).map((row) => [row.seat, row.receipt]), [
        ["secretariat", receipt],
        ["secretariat", receipt],
      ]);
    });
  });
}
