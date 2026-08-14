/**
 * Public taishi adapter (#336): argv → TaishiIssueModeInput → runTaishi.
 * Deterministic analysis seat — no Pi runner, no admission lease.
 * Reuses existing CLI failure envelope (CliUsageError + structural reject).
 * Index read reuses readTaishiLibraryIndexPage / findTaishiLibraryIndexRow.
 */
import {
  physicalPathIdentity,
  resolveActivationLedgerHome,
} from "../activation-ledger-topology.ts";
import {
  findTaishiLibraryIndexRow,
  readTaishiLibraryIndexPage,
} from "../taishi-index.ts";
import {
  runTaishi,
  type TaishiIssueModeInput,
} from "../taishi-entry.ts";
import { CliUsageError } from "./cli-errors.ts";
import type { CliIo } from "./cli-io.ts";
import type { ParseTaishiArgvResult } from "./invocation.ts";
import { presentStructuralRejection } from "./settlement.ts";

export type TaishiRunEnv = {
  readonly home: string;
};

/**
 * Build the sole library issue-mode input from public argv faces.
 * - ticket N → issueNumber = ticketNumber = N; projectRoot from index (or project-root fallback).
 * - project-root P → direct mechanical key.
 * - both + index hit → index projectRoot wins; when direct root differs, retain it as
 *   conflictingProjectRoot so runTaishi records the C4 dual-param conflict fact on the page.
 * - both + index miss → project-root fallback.
 * Bare both-missing is owned by parseTaishiArgv — no second reject here.
 */
export async function buildTaishiIssueModeInputFromPublicArgv(
  parsed: ParseTaishiArgvResult,
  ledgerHome: string,
): Promise<TaishiIssueModeInput> {
  const ticket = parsed.ticket;
  const directRoot = parsed.projectRoot;

  if (ticket === undefined) {
    return {
      mode: "issue",
      projectRoot: directRoot!,
    };
  }

  // ticket N = issueNumber (no conversion); also the C4 typed ticket face.
  const index = await readTaishiLibraryIndexPage(ledgerHome);
  const row = findTaishiLibraryIndexRow(index, ticket);

  let projectRoot: string;
  if (row !== undefined) {
    // Ticket-resolved index projectRoot wins over any concurrent --project-root.
    projectRoot = row.projectRoot;
  } else if (directRoot !== undefined) {
    // Index miss with project-root fallback (ticket faces still set for C4).
    projectRoot = directRoot;
  } else {
    throw new CliUsageError(
      `taishi library index has no row for ticket ${ticket}`,
    );
  }

  // Dual-param conflict: index root won, but caller also supplied a distinct --project-root.
  // Carry the losing root so the metrics page records the call-face conflict fact.
  const dualParamConflict =
    row !== undefined
    && directRoot !== undefined
    && physicalPathIdentity(directRoot) !== physicalPathIdentity(projectRoot);

  return {
    mode: "issue",
    projectRoot,
    ticketNumber: ticket,
    issueNumber: ticket,
    ...(dualParamConflict ? { conflictingProjectRoot: directRoot } : {}),
  };
}

/**
 * Public taishi run path — parse → resolve → runTaishi → typed receipt on stdout.
 */
export async function runPublicTaishi(
  argv: readonly string[],
  _env: TaishiRunEnv,
  io: CliIo,
  parseTaishiArgv: (args: readonly string[]) => ParseTaishiArgvResult,
): Promise<{ exitCode: number }> {
  try {
    const parsed = parseTaishiArgv(argv);
    // Machine home is package-owned (ADR 0048) — same primitive runTaishi uses.
    const ledgerHome = resolveActivationLedgerHome();
    const input = await buildTaishiIssueModeInputFromPublicArgv(parsed, ledgerHome);
    const result = await runTaishi(input);
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    throw error;
  }
}
