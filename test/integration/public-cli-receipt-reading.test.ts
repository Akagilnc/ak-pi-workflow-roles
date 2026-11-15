/**
 * #1289 — how a receipt's conclusion word and seat are read after submission.
 *
 * Driven from the public entry (runAkRole). Each seat's turn seals its scripted
 * receipt through the production submission ledger; the gate, the settlement
 * and the ticket progress rows then read those receipts.
 */
import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { packagedExternalHostNames } from "../../src/host-descriptions.ts";
import { runAkRole } from "../../src/public-cli/cli.ts";
import { readTicketProgressLines } from "../../src/ticket-progress.ts";
import { withTempRoot } from "../helpers/environment-fixtures.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import { sealingCourtHost } from "../helpers/submission-ledger-fixture.ts";

const TICKET = 1289;
type Receipt = Record<string, unknown>;

/**
 * One court on a fresh home. Every seat seals its next scripted receipt (the
 * last one repeats); an unscripted seat converges. Returns the public entry,
 * the per-seat turn counts and the ticket's progress rows with their receipts.
 */
async function withCourt(
  script: Readonly<Record<string, readonly Receipt[]>>,
  scenario: (court: {
    readonly calls: Readonly<Partial<Record<string, number>>>;
    /** Open a Secretariat run from the public entry. */
    open(): ReturnType<typeof runAkRole>;
    resume(runId: string): ReturnType<typeof runAkRole>;
    rows(): Promise<readonly { seat: string; status?: string; summary?: string; receipt: unknown }[]>;
  }) => Promise<void>,
): Promise<void> {
  await withTempRoot("ak-1289-", async (home) => {
    const quiet = { stdout() {}, stderr() {} };
    const seats = ["secretariat", "countersign", "notary", "diarist"].flatMap((seat) => [seat, "test/caller-seat:high"]);
    await runAkRole(["config", "set", ...seats], { packageRoot, home, io: quiet });
    await runAkRole(["config", "set-auto-resume-limit", "1"], { packageRoot, home, io: quiet });
    const project = join(home, "project");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    const { calls, host } = sealingCourtHost((role, call) => {
      const scripted = script[role];
      return scripted?.[Math.min(call, scripted.length) - 1]
        ?? (role === "diarist"
          ? { status: "completed", ticketNumber: TICKET, sessions: [] }
          : { status: "converged", ticketNumber: TICKET });
    });
    const env = {
      packageRoot,
      home,
      cwd: project,
      credentials: { "openai-codex": true as const, xai: true as const },
      roleTurnHost: host,
      hostAdapters: packagedExternalHostNames()
        .concat("pi")
        .map((name) => ({ name, create: () => ({ ok: true as const, host }) })),
    };
    const subject = join(home, ".ak-roles", "books", resolveBookKeyFromGit(project), String(TICKET));
    const run = async (argv: string[]) => {
      const capture = captureIo();
      const result = await runAkRole(argv, { ...env, io: capture.io });
      assert.equal(result.exitCode, 0, capture.stderr.join(""));
      return result;
    };
    await scenario({
      calls,
      open: () => run(["secretariat", "--host", "grok-build", "--project", project, "go"]),
      resume: (runId) => run(["resume", runId]),
      rows: async () => Promise.all(
        readTicketProgressLines(subject)
          .filter((line) => line.seat !== "diarist")
          .map(async ({ seat, status, summary, receipt }) => ({
            seat,
            ...(status === undefined ? {} : { status }),
            ...(summary === undefined ? {} : { summary }),
            receipt: JSON.parse(await readFile(join(subject, receipt), "utf8")) as unknown,
          })),
      ),
    });
  });
}

test("#1289: a Secretariat session opened before the rename still reads by its old key", async () => {
  const escalated = { secretariatStatus: "escalate", ticketNumber: TICKET };
  const signed = { secretariatStatus: "converged", ticketNumber: TICKET };
  const countersigned = { status: "converged", summary: "给事中署", ticketNumber: TICKET };
  const sealed = { status: "converged", summary: "符宝郎署", ticketNumber: TICKET };
  await withCourt(
    { secretariat: [escalated, signed], countersign: [countersigned], notary: [sealed] },
    async (court) => {
      const opened = await court.open();
      assert.equal(opened.terminal?.roleOutcome.kind, "accepted");
      assert.equal(opened.terminal?.roleOutcome.role, "secretariat");
      assert.deepEqual({ ...court.calls }, { diarist: 1, secretariat: 1 }, "escalate does not enter the 给事中 gate");

      const resumed = await court.resume(opened.terminal!.runId!);
      assert.equal(resumed.terminal?.roleOutcome.kind, "accepted");
      assert.equal(resumed.terminal?.roleOutcome.role, "secretariat");
      assert.equal(court.calls.secretariat, 2, "the old-key receipt is read, not asked again");
      assert.equal(court.calls.countersign, 1);
      assert.equal(court.calls.notary, 1);
      // 给事中 and 符宝郎 share one output tool; each conclusion lands on its own seat.
      assert.deepEqual(await court.rows(), [
        { seat: "secretariat", status: "escalate", receipt: escalated },
        { seat: "secretariat", status: "converged", receipt: signed },
        { seat: "countersign", status: "converged", summary: "给事中署", receipt: countersigned },
        { seat: "notary", status: "converged", summary: "符宝郎署", receipt: sealed },
      ]);
    },
  );
});

for (const [name, receipt] of [
  ["with neither key", { ticketNumber: TICKET, note: "无结论字" }],
  ["whose word is outside converged/escalate", { status: "continue", ticketNumber: TICKET }],
] as const) {
  test(`#1289: a Secretariat receipt ${name} goes back to the Secretariat and stays on the ledger`, async () => {
    await withCourt({ secretariat: [receipt] }, async (court) => {
      // Not aborted: the call ends with the Secretariat's own volume, direction unsettled.
      const result = await court.open();
      assert.equal(result.terminal?.roleOutcome.kind, "accepted");
      assert.equal(result.terminal?.roleOutcome.role, "secretariat");
      assert.equal(result.terminal?.roleOutcome.decisiveFacts?.directionUnsettled, true);
      // One reask under the configured limit of 1; the 给事中 gate is never entered.
      assert.deepEqual({ ...court.calls }, { diarist: 1, secretariat: 2 });
      assert.deepEqual((await court.rows()).map((row) => [row.seat, row.receipt]), [
        ["secretariat", receipt],
        ["secretariat", receipt],
      ]);
    });
  });
}
