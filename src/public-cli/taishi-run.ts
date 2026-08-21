/**
 * Public taishi adapter (#336/#337/#338/#399): argv → typed query → runTaishi family.
 * Deterministic analysis seat — no Pi runner, no admission lease.
 * Reuses existing CLI failure envelope (CliUsageError + structural reject +
 * ControlledFailure).
 * #399: --ticket N computes live from the ledger book — no library-index bootstrap.
 * #337 sweep: exactly one typed JSON attachment → TaishiSweepModeInput → #329 kernel.
 * #338: three query faces; sync compute-if-missing; whole-compute failure →
 * ControlledFailure terminal (code/projectRoot/issueNumber/real cause).
 * "Unobtrusive" binds #337 merge auto-trigger only, not this user-initiated query.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Value } from "typebox/value";

import {
  errnoCode,
  resolveActivationLedgerHome,
} from "../activation-ledger-topology.ts";
import { exactUtf8 } from "../exact-utf8.ts";
import {
  readOrComputeTaishiIssuePage,
  runTaishi,
  taishiSweepModeInputSchema,
  TaishiIssueComputeError,
  type TaishiIssueModeInput,
  type TaishiSweepModeInput,
} from "../taishi-entry.ts";
import { CliUsageError } from "./cli-errors.ts";
import type { CliIo } from "./cli-io.ts";
import type {
  ParseTaishiArgvResult,
  ParseTaishiIssueArgv,
} from "./invocation.ts";
import { presentControlledFailure, presentStructuralRejection } from "./settlement.ts";

export type TaishiRunEnv = {
  readonly home: string;
};

/**
 * Build the sole library issue-mode input from public argv faces (#399).
 * - ticket N → issueNumber = ticketNumber = N; live book compute (no library-index bootstrap).
 * - project-root P → book pointer (git common-dir) / path-narrow face for the scan.
 * - both → project-root selects the book; ticket filters inside it.
 * - bare ticket → cwd is the book pointer (must be a git tree for book resolve).
 * Bare both-missing is owned by parseTaishiArgv — no second reject here.
 */
export async function buildTaishiIssueModeInputFromPublicArgv(
  parsed: ParseTaishiIssueArgv,
  _ledgerHome: string,
): Promise<TaishiIssueModeInput> {
  const ticket = parsed.ticket;
  const directRoot = parsed.projectRoot;

  if (ticket === undefined) {
    return {
      mode: "issue",
      projectRoot: directRoot!,
    };
  }

  // ticket N = issueNumber (no conversion); C4 typed ticket face.
  // Live from the book — index is not a prerequisite (defect 3 dead-loop removed).
  const projectRoot = directRoot ?? process.cwd();
  return {
    mode: "issue",
    projectRoot,
    ticketNumber: ticket,
    issueNumber: ticket,
  };
}

/**
 * Attachment JSON → library TaishiSweepModeInput via the sole schema (#337).
 * No parallel hand shape; rejects missing/extra/wrong-type fields only.
 */
export function parseTaishiSweepModeInputFromJsonValue(
  value: unknown,
): TaishiSweepModeInput {
  if (!Value.Check(taishiSweepModeInputSchema, value)) {
    throw new CliUsageError(
      "taishi sweep attachment must match TaishiSweepModeInput",
    );
  }
  return value;
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
 * Public taishi run path — parse → resolve → query → typed receipt on stdout.
 * Issue (#336/#338 compute-if-missing), sweep (#337), cohort/model-groups (#338).
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

    if (parsed.query === "sweep") {
      const input = await buildTaishiSweepModeInputFromAttachmentPaths(
        parsed.attachmentPaths,
      );
      const result = await runTaishi(input);
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0 };
    }

    if (parsed.query === "cohort") {
      const result = await runTaishi({
        mode: "cohort",
        groups: parsed.groups,
      });
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0 };
    }

    if (parsed.query === "model-groups") {
      const result = await runTaishi({
        mode: "model-groups",
        projectRoots: parsed.projectRoots,
      });
      io.stdout(`${JSON.stringify(result, null, 2)}\n`);
      return { exitCode: 0 };
    }

    // issue query — compute-if-missing (#338); sole kernel on miss.
    const input = await buildTaishiIssueModeInputFromPublicArgv(parsed, ledgerHome);
    const result = await readOrComputeTaishiIssuePage(input);
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return { exitCode: 0 };
  } catch (error) {
    if (error instanceof CliUsageError) {
      presentStructuralRejection(error, io);
      return { exitCode: 2 };
    }
    if (error instanceof TaishiIssueComputeError) {
      // Existing ControlledFailure: details carry code/projectRoot/issueNumber;
      // identity.code carries distinguishable real cause (errno). No parallel schema.
      const code = errnoCode(error.cause);
      presentControlledFailure({
        cause: "output",
        diagnostic: error.message,
        ...(code === undefined ? {} : { identity: { code } }),
        details: {
          code: error.code,
          projectRoot: error.projectRoot,
          ...(error.issueNumber === undefined ? {} : { issueNumber: error.issueNumber }),
        },
      }, io);
      return { exitCode: 1 };
    }
    throw error;
  }
}
