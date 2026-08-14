/**
 * Public taishi adapter (#336): argv → TaishiIssueModeInput → runTaishi.
 * Deterministic analysis seat — no Pi runner, no admission lease.
 * Reuses existing CLI failure envelope (CliUsageError + structural reject).
 * Index read reuses readTaishiLibraryIndexPage / findTaishiLibraryIndexRow.
 */
import { resolveActivationLedgerHome } from "../activation-ledger-topology.ts";
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
 * - both → projectRoot prefers direct P; ticket faces still set so C4 typed wins on scan.
 */
export async function buildTaishiIssueModeInputFromPublicArgv(
  parsed: ParseTaishiArgvResult,
  ledgerHome: string,
): Promise<TaishiIssueModeInput> {
  const ticket = parsed.ticket;
  const directRoot = parsed.projectRoot;

  if (ticket === undefined && directRoot === undefined) {
    // parseTaishiArgv already rejects this; defend the seam.
    throw new CliUsageError(
      "usage: ak-role taishi (--ticket <N> | --project-root <P>)",
    );
  }

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
  if (directRoot !== undefined) {
    // Direct supply is the projectRoot field; ticket faces enable C4 on conflict.
    projectRoot = directRoot;
  } else if (row !== undefined) {
    projectRoot = row.projectRoot;
  } else {
    throw new CliUsageError(
      `taishi library index has no row for ticket ${ticket}`,
    );
  }

  return {
    mode: "issue",
    projectRoot,
    ticketNumber: ticket,
    issueNumber: ticket,
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
