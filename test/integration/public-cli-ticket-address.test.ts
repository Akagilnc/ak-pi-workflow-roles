/**
 * #1201 through-line: public `ak-role` + fake host.
 * The public address is ticket + seat (+ round): `resume <ticket> <seat>` and
 * `--source-run <ticket>:<seat>#<round>`; the terminal names ticket, seat,
 * round and receipt and carries no run id.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, rename } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { test } from "vitest";

import { resolveBookKeyFromGit } from "../../src/activation-ledger-git.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "../../src/package-contracts/judge-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "../../src/notary-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import { runAkRole, type CliResult } from "../../src/public-cli/cli.ts";
import { runDirectoryOfSessionFile } from "../../src/role-run-placement.ts";
import { readTicketProgressLines } from "../../src/ticket-progress.ts";
import { withHermeticHome, withOutsideTempRoot } from "../helpers/environment-fixtures.ts";
import { captureIo, seedGitProject } from "../helpers/failure-settlement-kit.ts";
import { seedPublicSeat } from "../helpers/passing-review-host.ts";
import { packageRoot } from "../helpers/pi-test-harness.ts";
import {
  argvFlagValue,
  roleTurnHostFromLegacyPiRunner,
  scriptedTerminatingToolSession,
} from "../helpers/role-turn-host-fixture.ts";

const TICKET = 1201;
const SEAT_MODEL = "test/caller-seat:high";

/** One host turn as the seat saw it. `leg` is the leg directory name the session lives in. */
type Turn = {
  readonly role: string;
  readonly leg: string;
  readonly sessionFile: string;
  readonly args: readonly string[];
};

/** What a scripted turn does: submit these details, or end with no receipt. */
type Script = (turn: Turn) => Record<string, unknown> | undefined;

/** Self-escalation: a judge receipt that is accepted without entering the audit gates. */
const ruling = (extra: Record<string, unknown> = {}) => ({ status: "escalate", ticketNumber: TICKET, ...extra });

async function withTicketProject(
  body: (ctx: {
    readonly home: string;
    readonly project: string;
    readonly ticketDirectory: string;
    readonly turns: Turn[];
    /** What the calls wrote to stdout and stderr. */
    readonly captured: ReturnType<typeof captureIo>;
    call(argv: readonly string[], script?: Script, env?: { cwd?: string; boundTicketNumber?: number }): Promise<CliResult>;
  }) => Promise<void>,
): Promise<void> {
  await withHermeticHome({ prefix: "ak-1201-address-" }, async ({ home }) => {
    const project = join(home, "work");
    await mkdir(project, { recursive: true });
    seedGitProject(project);
    for (const seat of ["judge", "notary", "fixer", "diarist"]) await seedPublicSeat(home, seat);
    const turns: Turn[] = [];
    const captured = captureIo();
    const ticketDirectory = join(home, ".ak-roles", "books", resolveBookKeyFromGit(project), String(TICKET));
    let seals = 0;
    await body({
      home,
      project,
      ticketDirectory,
      turns,
      captured,
      call: (argv, script = () => undefined, env = {}) => runAkRole(argv, {
        packageRoot,
        home,
        cwd: env.cwd ?? project,
        io: captured.io,
        credentials: { "openai-codex": true, xai: true },
        principalAuthority: piDurablePrincipalAuthority,
        ...(env.boundTicketNumber === undefined ? {} : { boundTicketNumber: env.boundTicketNumber }),
        roleTurnHost: roleTurnHostFromLegacyPiRunner({
          packageRoot,
          principalAuthority: piDurablePrincipalAuthority,
          piRunner: async (args, options) => {
            const turn: Turn = {
              role: argvFlagValue(args, "--ak-role")!,
              leg: basename(runDirectoryOfSessionFile(argvFlagValue(args, "--session")!)),
              sessionFile: argvFlagValue(args, "--session")!,
              args: [...args],
            };
            turns.push(turn);
            const details = script(turn);
            if (details === undefined) return { code: 0, stderr: "", timedOut: false, args: [...args] };
            seals += 1;
            return scriptedTerminatingToolSession({
              role: turn.role as "judge" | "notary",
              toolName: turn.role === "notary" ? NOTARY_OUTPUT_TOOL_NAME : JUDGE_OUTPUT_TOOL_NAME,
              details,
              toolCallId: `call-${seals}`,
              sessionWriteMode: existsSync(turn.sessionFile) ? "append" : "replace",
            })(args, options);
          },
        }),
      }),
    });
  });
}

function seatRows(ticketDirectory: string, seat: string) {
  return readTicketProgressLines(ticketDirectory).filter((row) => row.seat === seat);
}

async function legCount(home: string): Promise<number> {
  const book = join(home, ".ak-roles", "books");
  let count = 0;
  for (const bookKey of await readdir(book)) {
    for (const subject of await readdir(join(book, bookKey))) {
      const runs = join(book, bookKey, subject, "runs");
      if (existsSync(runs)) count += (await readdir(runs)).length;
    }
  }
  return count;
}

test("#1201 resume <ticket> <seat> continues the seat's session; the terminal names ticket, round and receipt", async () => {
  await withTicketProject(async ({ ticketDirectory, turns, call }) => {
    const first = await call(["judge", "--model", SEAT_MODEL, "review"], () => ruling({ note: "one" }));
    assert.equal(first.exitCode, 0);
    const firstRow = seatRows(ticketDirectory, "judge").at(-1)!;
    assert.equal(firstRow.round, "1");
    assert.equal(first.terminal?.ticket, TICKET);
    assert.equal(first.terminal?.roleOutcome.role, "judge");
    assert.deepEqual(
      first.terminal?.receipts?.map((filed) => ({ round: filed.round, receipt: relative(ticketDirectory, filed.receipt) })),
      [{ round: "1", receipt: firstRow.receipt }],
    );
    assert.equal(existsSync(first.terminal!.receipts![0]!.receipt), true);
    for (const identity of ["runId", "attemptId"]) {
      assert.equal(Object.hasOwn(first.terminal!, identity), false, `terminal must not carry ${identity}`);
    }

    // Bare number: the same leg; its next accepted receipt is the next round.
    const second = await call(["resume", String(TICKET), "judge"], () => ruling({ note: "two" }));
    assert.equal(second.exitCode, 0);
    assert.equal(turns.at(-1)?.leg, turns[0]?.leg);
    assert.deepEqual(seatRows(ticketDirectory, "judge").map((row) => row.round), ["1", "2"]);
    // Each submission the terminal presents reports its own round and receipt.
    assert.deepEqual(
      second.terminal?.receipts?.map((filed) => [filed.round, relative(ticketDirectory, filed.receipt)]),
      seatRows(ticketDirectory, "judge").map((row) => [row.round, row.receipt]),
    );

    // A quoted `#N` is the same ticket.
    const before = turns.length;
    const quoted = await call(["resume", `#${TICKET}`, "judge"]);
    assert.equal(quoted.terminal?.roleOutcome.role, "judge");
    assert.equal(turns.length, before + 1);
    assert.equal(turns.at(-1)?.leg, turns[0]?.leg);

    // A leg that files nothing in its call: ticket and seat, no round, no receipt, no run id.
    const empty = await call(["new", "judge", "--model", SEAT_MODEL, "nothing"], undefined, { boundTicketNumber: TICKET });
    assert.equal(empty.terminal?.roleOutcome.kind, "no_receipt");
    assert.equal(empty.terminal?.ticket, TICKET);
    assert.equal(empty.terminal?.receipts, undefined);
    assert.equal(Object.hasOwn(empty.terminal!, "runId"), false);
  });
});

test("#1201 default is the seat's most recently active leg under the ticket; <seat>#<round> names another", async () => {
  await withTicketProject(async ({ home, project, ticketDirectory, turns, call }) => {
    await call(["judge", "--model", SEAT_MODEL, "leg A"], () => ruling());
    const legA = turns.at(-1)!.leg;
    // Leg B is filed under the ticket and ends its first turn without a receipt.
    await call(["new", "judge", "--model", SEAT_MODEL, "leg B"], undefined, { boundTicketNumber: TICKET });
    const legB = turns.at(-1)!.leg;
    assert.notEqual(legB, legA);
    assert.deepEqual(seatRows(ticketDirectory, "judge").map((row) => row.round), ["1"]);

    // The later leg has no row yet and is still the default. The last turn was
    // already on that leg: the call has to start one more.
    let turnsBefore = turns.length;
    await call(["resume", String(TICKET), "judge"]);
    assert.equal(turns.length, turnsBefore + 1);
    assert.equal(turns.at(-1)?.leg, legB);

    // A round names the leg that filed it, though it is not the most recent.
    await call(["resume", String(TICKET), "judge#1"]);
    assert.equal(turns.at(-1)?.leg, legA);

    // The earlier leg was active last, so it is now the default.
    turnsBefore = turns.length;
    await call(["resume", String(TICKET), "judge"]);
    assert.equal(turns.length, turnsBefore + 1);
    assert.equal(turns.at(-1)?.leg, legA);

    // A newer leg that reported no ticket is not in the address and is left alone.
    await call(["new", "judge", "--model", SEAT_MODEL, "leg C"]);
    const legC = turns.at(-1)!;
    assert.equal(relative(ticketDirectory, legC.sessionFile).startsWith(".."), true);
    const legCTurns = turns.filter((turn) => turn.leg === legC.leg).length;
    await call(["resume", String(TICKET), "judge"]);
    assert.equal(turns.at(-1)?.leg, legA);
    assert.equal(turns.filter((turn) => turn.leg === legC.leg).length, legCTurns);
    assert.equal(existsSync(runDirectoryOfSessionFile(legC.sessionFile)), true);

    // A worktree of the same repository addresses the same book.
    const worktree = join(home, "work-tree");
    execFileSync("git", ["worktree", "add", "-q", worktree], { cwd: project });
    turnsBefore = turns.length;
    await call(["resume", String(TICKET), "judge"], undefined, { cwd: worktree });
    assert.equal(turns.length, turnsBefore + 1);
    assert.equal(turns.at(-1)?.leg, legA);
  });
});

test("#1201 an address that names no leg fails loudly and starts nothing", async () => {
  await withTicketProject(async ({ home, ticketDirectory, turns, captured, call }) => {
    await call(["judge", "--model", SEAT_MODEL, "leg A"], () => ruling());
    // The only fixer leg reported no ticket.
    await call(["new", "fixer", "--model", SEAT_MODEL, "unfiled"]);
    const runId = turns[0]!.leg.split("@")[0]!;
    const turnsBefore = turns.length;
    const legsBefore = await legCount(home);
    await withOutsideTempRoot("ak-1201-outside-", async (outside) => {
      const result = await call(["resume", String(TICKET), "judge"], undefined, { cwd: outside });
      assert.notEqual(result.exitCode, 0, "outside a repository");
    });
    for (const argv of [
      ["resume", "99999", "judge"],
      ["resume", String(TICKET), "notary"],
      ["resume", String(TICKET), "fixer"],
      ["resume", String(TICKET), "judge#9"],
      ["resume", String(TICKET), "nobody"],
      ["resume", String(TICKET), "--model", SEAT_MODEL, "judge"],
      ["resume", runId],
      ["resume", runId, "judge"],
      ["resume"],
    ]) {
      const result = await call(argv);
      assert.notEqual(result.exitCode, 0, argv.join(" "));
      assert.equal(result.terminal, undefined, argv.join(" "));
    }
    // The address names a leg, but the leg can no longer be read: the failure
    // points at the leg by its directory, never by a bare run id.
    const legA = turns[0]!.leg;
    await rename(join(ticketDirectory, "runs", legA, "state.jsonl"), join(ticketDirectory, "runs", legA, "state.gone"));
    for (const argv of [["resume", String(TICKET), "judge"], ["resume", String(TICKET), "judge#1"]]) {
      captured.stdout.length = 0;
      captured.stderr.length = 0;
      const result = await call(argv);
      assert.notEqual(result.exitCode, 0, argv.join(" "));
      assert.equal(result.terminal, undefined, argv.join(" "));
      const printed = [...captured.stdout, ...captured.stderr].join("");
      assert.equal(printed.replaceAll(legA, "").includes(runId), false, argv.join(" "));
    }
    assert.equal(turns.length, turnsBefore);
    assert.equal(await legCount(home), legsBefore);
  });
});

test("#1201 --source-run <ticket>:<seat>#<round> binds the officer to the leg that filed that round", async () => {
  await withTicketProject(async ({ home, ticketDirectory, turns, call }) => {
    await call(["judge", "--model", SEAT_MODEL, "leg A"], () => ruling());
    const legA = join(ticketDirectory, "runs", turns.at(-1)!.leg);

    const boundTo = async (locator: string): Promise<string | undefined> => {
      const result = await call(
        ["new", "notary", "--model", SEAT_MODEL, "--source-run", locator],
        () => ({ status: "converged" }),
      );
      assert.equal(result.exitCode, 0, locator);
      const turn = turns.at(-1)!;
      assert.equal(turn.role, "notary");
      return argvFlagValue(turn.args, "--ak-notary-source-run");
    };
    assert.equal(await boundTo(`${TICKET}:judge#1`), legA);
    assert.equal(await boundTo(`${TICKET}:judge#1`), legA);
    // Rounds count per seat, so round numbers collide across seats: the notary's
    // round 2 is on the ticket before the judge's. The address is seat and round together.
    await call(["new", "judge", "--model", SEAT_MODEL, "leg B"], () => ruling());
    const legB = join(ticketDirectory, "runs", turns.at(-1)!.leg);
    assert.deepEqual(
      readTicketProgressLines(ticketDirectory).map((row) => `${row.seat}#${row.round}`),
      ["judge#1", "notary#1", "notary#2", "judge#2"],
    );
    assert.equal(await boundTo(`${TICKET}:judge#2`), legB);
    // The same locator serves resume: the judge's round, not the notary's.
    await call(["resume", String(TICKET), "judge#2"]);
    assert.equal(turns.at(-1)?.role, "judge");
    assert.equal(join(ticketDirectory, "runs", turns.at(-1)!.leg), legB);

    const turnsBefore = turns.length;
    const legsBefore = await legCount(home);
    for (const locator of [`${TICKET}:judge#9`, basename(legA)]) {
      const result = await call(["new", "notary", "--model", SEAT_MODEL, "--source-run", locator]);
      assert.notEqual(result.exitCode, 0, locator);
    }
    assert.equal(turns.length, turnsBefore);
    assert.equal(await legCount(home), legsBefore);
  });
});
