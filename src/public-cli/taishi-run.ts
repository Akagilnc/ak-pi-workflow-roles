/**
 * Public taishi adapter (#336/#337): argv → issue or sweep input → runTaishi.
 * Deterministic analysis seat — no Pi runner, no admission lease.
 * Reuses existing CLI failure envelope (CliUsageError + structural reject).
 * Index read reuses readTaishiLibraryIndexPage / findTaishiLibraryIndexRow.
 * #337 sweep: exactly one typed JSON attachment → TaishiSweepModeInput → #329 kernel.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import {
  physicalPathIdentity,
  resolveActivationLedgerHome,
} from "../activation-ledger-topology.ts";
import { exactUtf8 } from "../exact-utf8.ts";
import {
  findTaishiLibraryIndexRow,
  readTaishiLibraryIndexPage,
} from "../taishi-index.ts";
import {
  runTaishi,
  type TaishiIssueModeInput,
  type TaishiMergedPullRequest,
  type TaishiSweepModeInput,
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strict TaishiSweepModeInput contract from attachment JSON (#337).
 * Fields 1:1 with library type — no add/remove/rename; extra keys reject.
 */
export function parseTaishiSweepModeInputFromJsonValue(
  value: unknown,
): TaishiSweepModeInput {
  if (!isPlainObject(value)) {
    throw new CliUsageError(
      "taishi sweep attachment must be a JSON object matching TaishiSweepModeInput",
    );
  }

  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== "mergedPullRequests" || keys[1] !== "mode") {
    throw new CliUsageError(
      "taishi sweep attachment fields must be exactly mode and mergedPullRequests",
    );
  }

  if (value.mode !== "sweep") {
    throw new CliUsageError(
      `taishi sweep attachment mode must be \"sweep\", got ${String(value.mode)}`,
    );
  }

  if (!Array.isArray(value.mergedPullRequests)) {
    throw new CliUsageError(
      "taishi sweep attachment mergedPullRequests must be an array",
    );
  }

  const mergedPullRequests: TaishiMergedPullRequest[] = [];
  for (let i = 0; i < value.mergedPullRequests.length; i += 1) {
    const entry = value.mergedPullRequests[i];
    if (!isPlainObject(entry)) {
      throw new CliUsageError(
        `taishi sweep mergedPullRequests[${i}] must be an object`,
      );
    }
    const entryKeys = Object.keys(entry).sort();
    const allowed =
      (entryKeys.length === 1 && entryKeys[0] === "projectRoot")
      || (
        entryKeys.length === 2
        && entryKeys[0] === "changedLines"
        && entryKeys[1] === "projectRoot"
      );
    if (!allowed) {
      throw new CliUsageError(
        `taishi sweep mergedPullRequests[${i}] fields must be projectRoot and optional changedLines only`,
      );
    }
    if (typeof entry.projectRoot !== "string" || entry.projectRoot.trim() === "") {
      throw new CliUsageError(
        `taishi sweep mergedPullRequests[${i}].projectRoot must be a nonempty string`,
      );
    }
    if (entryKeys.includes("changedLines")) {
      if (typeof entry.changedLines !== "number" || !Number.isFinite(entry.changedLines)) {
        throw new CliUsageError(
          `taishi sweep mergedPullRequests[${i}].changedLines must be a finite number`,
        );
      }
      mergedPullRequests.push({
        projectRoot: entry.projectRoot,
        changedLines: entry.changedLines,
      });
    } else {
      mergedPullRequests.push({ projectRoot: entry.projectRoot });
    }
  }

  return { mode: "sweep", mergedPullRequests };
}

/**
 * Load sweep typed input from exactly one public CLI attachment path.
 * Rejects: wrong cardinality, unreadable path, non-UTF-8, JSON fail, field contract.
 * Zero ledger writes — read-only path resolve + parse.
 */
export async function buildTaishiSweepModeInputFromAttachmentPaths(
  attachmentPaths: readonly string[],
): Promise<TaishiSweepModeInput> {
  if (attachmentPaths.length !== 1) {
    throw new CliUsageError(
      "taishi sweep requires exactly one --attach typed JSON attachment",
    );
  }

  const sourcePath = attachmentPaths[0]!;
  const absolute = isAbsolute(sourcePath) ? sourcePath : resolve(sourcePath);

  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch (error) {
    throw new CliUsageError(
      `taishi sweep attachment is not a readable regular file: ${sourcePath}`,
      { cause: error },
    );
  }

  let text: string;
  try {
    text = exactUtf8(bytes, "taishi sweep attachment");
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliUsageError(detail, { cause: error });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CliUsageError(
      "taishi sweep attachment is not valid JSON",
      { cause: error },
    );
  }

  return parseTaishiSweepModeInputFromJsonValue(parsed);
}

/**
 * Public taishi run path — parse → resolve → runTaishi → typed receipt on stdout.
 * Issue mode (#336) and sweep mode (#337) share this adapter and envelope.
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

    if (parsed.sweepMode) {
      const input = await buildTaishiSweepModeInputFromAttachmentPaths(
        parsed.attachmentPaths,
      );
      const result = await runTaishi(input);
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0 };
    }

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
