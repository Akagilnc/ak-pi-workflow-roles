/**
 * #1199 ticket-level progress: current.jsonl + receipts/ + sessions/ pointers.
 * Write at seal (createSubmissionLedgerHost → projectClosure), never by
 * post-turn history guessing. Per-leg dossiers stay until #1202.
 *
 * Unbound legs stage inside the run directory (owner 41f7c164): progress +
 * receipts copy onto the ticket, then bind appends into ticket current.jsonl.
 * Round authority is progress lines only — no receipt-filename counting,
 * occupancy placeholders, or claim-retry loops. Reviewer dual-lens series
 * count independently (`<n>.<lens>`).
 *
 * Relocate copies then publishes ticket current before removing sources
 * (Node/POSIX: leave staged originals recoverable until destination lands).
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { resolveHostDossierLandingPath } from "./host-session-record.ts";
import type { HostContext } from "./host-contracts.ts";
import { runDirectoryFromHostContext } from "./host-contracts.ts";
import {
  acceptedFacts,
  isTerminatingToolName,
  type AcceptedDetails,
} from "./package-contracts/terminating-tools.ts";
import { packagedRoleOutputTool } from "./packaged-role-registry.ts";
import {
  formatRunLeaf,
  isUnboundRunDirectory,
  sessionDirectoryOf,
  sessionFileOf,
  subjectDirectoryOfRun,
} from "./role-run-placement.ts";
import { readPageSync } from "./run-dossier.ts";
import { parseSitianRecordText } from "./sitian-reader.ts";
import { isRecord } from "./unknown-value.ts";

const CURRENT_FILENAME = "current.jsonl" as const;
const RECEIPTS_DIRNAME = "receipts" as const;
const SESSIONS_DIRNAME = "sessions" as const;
const LEG_PROGRESS_FILENAME = "ticket-progress.jsonl" as const;
const LEG_RECEIPTS_DIRNAME = "ticket-receipts" as const;

/** One accepted-receipt progress row on the ticket (or unbound leg) subject. */
export type TicketProgressLine = {
  readonly at: string;
  readonly seat: string;
  /** Seat-local round; reviewer dual-lens uses `<n>.<lens>`. */
  readonly round: string;
  /** This-round summons instruction bytes; empty string when none. */
  readonly instruction: string;
  /** `git rev-parse HEAD` at seal from the seat worktree; empty on failure. */
  readonly head: string;
  /** Structured status when present on the receipt — omitted when absent. */
  readonly status?: string;
  /** Seat-authored short summary when present on the receipt. */
  readonly summary?: string;
  /** Path relative to the subject directory. */
  readonly receipt: string;
  /** Path relative to the subject directory. */
  readonly session: string;
};

/**
 * Append-only progress JSONL — same posture as run-dossier row files:
 * sole Sitian decoder keeps reachable rows; malformed lines leave diagnostics
 * on stderr and do not abort seal/relocate.
 */
function parseProgressText(text: string, pathForDiagnostic: string): TicketProgressLine[] {
  if (text.trim() === "") return [];
  const { records, diagnostics } = parseSitianRecordText(text);
  for (const diagnostic of diagnostics) {
    process.stderr.write(
      `[ticket-progress] ${pathForDiagnostic} has malformed row(s); keeps reachable rows and retains the diagnostic: line ${diagnostic.line}: ${diagnostic.error}\n`,
    );
  }
  const lines: TicketProgressLine[] = [];
  for (const record of records) {
    const parsed: unknown = record;
    if (!isRecord(parsed)) continue;
    if (typeof parsed.seat !== "string" || typeof parsed.round !== "string") continue;
    lines.push(parsed as unknown as TicketProgressLine);
  }
  return lines;
}

function readProgressFile(path: string): TicketProgressLine[] {
  if (!existsSync(path)) return [];
  return parseProgressText(readFileSync(path, "utf8"), path);
}

/**
 * Read progress rows under a subject.
 * Ticket: append-only `current.jsonl`.
 * Unbound: each leg's `runs/<leaf>/ticket-progress.jsonl` (no shared file).
 */
export function readTicketProgressLines(subjectDirectory: string): TicketProgressLine[] {
  if (basename(subjectDirectory) === "unbound") {
    const runsDir = join(subjectDirectory, "runs");
    if (!existsSync(runsDir)) return [];
    const out: TicketProgressLine[] = [];
    for (const name of readdirSync(runsDir).sort()) {
      out.push(...readProgressFile(join(runsDir, name, LEG_PROGRESS_FILENAME)));
    }
    return out;
  }
  return readProgressFile(join(subjectDirectory, CURRENT_FILENAME));
}

function roundBaseNumber(round: string): number {
  const base = round.includes(".") ? round.slice(0, round.indexOf(".")) : round;
  const n = Number(base);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function roundLens(round: string): string | undefined {
  return round.includes(".") ? round.slice(round.indexOf(".") + 1) : undefined;
}

function nextRoundFromLines(
  lines: readonly TicketProgressLine[],
  seat: string,
  lens?: string,
): string {
  const want = lens === undefined || lens.trim() === "" ? undefined : lens;
  let max = 0;
  for (const line of lines) {
    if (line.seat !== seat) continue;
    if (roundLens(line.round) !== want) continue;
    max = Math.max(max, roundBaseNumber(line.round));
  }
  const base = max + 1;
  return want === undefined ? String(base) : `${base}.${want}`;
}

function receiptFileName(seat: string, round: string): string {
  return `${seat}#${round}.json`;
}

/**
 * Copy structured status/summary from the seat receipt.
 * Status leaves reuse acceptedFacts (terminating-tools authority) via the seat's
 * current output tool — legacy judgeStatus/countersignStatus keys are unreachable
 * at this seal seam (tool is the live registry name, not ak_judge_output).
 * summary is seat-authored prose on the receipt and is not part of AcceptedFacts.
 * Missing fields stay absent — never invent "" or "accepted".
 *
 * Not receiptStatusFromRegistry: that scans every registry key for navigator
 * projection when the seat is unknown; here the seal already knows the seat.
 */
function statusAndSummaryFromPayload(seat: string, payload: unknown): {
  readonly status?: string;
  readonly summary?: string;
} {
  if (!isRecord(payload)) return {};
  const toolName = packagedRoleOutputTool(seat);
  const status = toolName !== undefined && isTerminatingToolName(toolName)
    ? acceptedFacts(toolName, payload as AcceptedDetails).status
    : undefined;
  const summary = typeof payload.summary === "string" ? payload.summary : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined ? {} : { summary }),
  };
}

export type WorktreeHeadCapture = {
  readonly head: string;
  readonly fault?: string;
};

/** Worktree HEAD at seal. On failure head is empty and fault carries the true cause. */
export function captureWorktreeHead(projectRoot: string): WorktreeHeadCapture {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result.error != null) {
      const err = result.error;
      const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
      return { head: "", fault: `git rev-parse HEAD spawn failed cwd=${projectRoot}: ${detail}` };
    }
    if (result.status !== 0) {
      const detail = [result.stderr, result.stdout]
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter((part) => part !== "")
        .join(" | ");
      const status = result.status === null ? "null" : String(result.status);
      const signal = result.signal == null ? "" : ` signal=${result.signal}`;
      return {
        head: "",
        fault: detail === ""
          ? `git rev-parse HEAD failed (status=${status}${signal}) cwd=${projectRoot}`
          : `git rev-parse HEAD failed (status=${status}${signal}) cwd=${projectRoot}: ${detail}`,
      };
    }
    return { head: (result.stdout ?? "").trim() };
  } catch (error) {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    return { head: "", fault: `git rev-parse HEAD threw cwd=${projectRoot}: ${message}` };
  }
}

function progressSessionAbsolute(runDirectory: string, context: HostContext): string {
  const host = typeof context.host === "string" ? context.host.trim() : "";
  const sessionDirectory = sessionDirectoryOf(runDirectory);
  // External hosts: ADR 0086 copy landing (codex.jsonl / grok-build / …), not the
  // principal wire file. Responsibility unchanged (#1199 R3 disposition).
  if (host !== "" && host !== "pi" && host !== "hermes") {
    return resolveHostDossierLandingPath({ host, sessionDirectory });
  }
  // Pi/hermes: prefer the issued durable coordinate on the live handle.
  const issued = context.sessionManager.getSessionFile?.();
  if (typeof issued === "string" && issued.trim() !== "") {
    return issued;
  }
  return sessionFileOf(runDirectory);
}

function lensFromRunDirectory(runDirectory: string, role: string): string | undefined {
  if (role !== "reviewer") return undefined;
  const lens = readPageSync(runDirectory, "admitted")?.lens;
  return lens === "completeness" || lens === "correctness" ? lens : undefined;
}

/**
 * Seal-time landing from createSubmissionLedgerHost (before projectClosure).
 * Missing run directory → no-op (ledger still sealed).
 */
export function landTicketProgressForSealedSubmission(input: {
  readonly context: HostContext;
  readonly role: string;
  readonly accepted: unknown;
  readonly sealHead: WorktreeHeadCapture;
  readonly lens?: string;
}): TicketProgressLine | undefined {
  const runDirectory = runDirectoryFromHostContext(input.context);
  if (runDirectory === undefined) return undefined;

  const subjectDirectory = subjectDirectoryOfRun(runDirectory);
  if (subjectDirectory === undefined) return undefined;

  const lens = (
    input.lens === "completeness" || input.lens === "correctness"
      ? input.lens
      : lensFromRunDirectory(runDirectory, input.role)
  );

  const leaf = basename(runDirectory);
  const unbound = basename(subjectDirectory) === "unbound";
  const progressPath = unbound
    ? join(runDirectory, LEG_PROGRESS_FILENAME)
    : join(subjectDirectory, CURRENT_FILENAME);
  const existing = unbound
    ? readProgressFile(progressPath)
    : readTicketProgressLines(subjectDirectory);
  const round = nextRoundFromLines(existing, input.role, lens);
  const relativePath = unbound
    ? `runs/${leaf}/${LEG_RECEIPTS_DIRNAME}/${receiptFileName(input.role, round)}`
    : `${RECEIPTS_DIRNAME}/${receiptFileName(input.role, round)}`;
  const absolutePath = join(subjectDirectory, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, `${JSON.stringify(input.accepted, null, 2)}\n`, "utf8");

  const sessionFile = progressSessionAbsolute(runDirectory, input.context);
  const sessionRelative = relative(subjectDirectory, sessionFile).split(sep).join("/");
  const { status, summary } = statusAndSummaryFromPayload(input.role, input.accepted);
  const instruction = typeof input.context.summonsInstruction === "string"
    ? input.context.summonsInstruction
    : "";
  const line: TicketProgressLine = {
    at: new Date().toISOString(),
    seat: input.role,
    round,
    instruction,
    head: input.sealHead.head,
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined ? {} : { summary }),
    receipt: relativePath,
    session: sessionRelative,
  };

  mkdirSync(dirname(progressPath), { recursive: true });
  appendFileSync(progressPath, `${JSON.stringify(line)}\n`, "utf8");
  // HEAD capture fault: keep the raw cause on stderr. Do not invent a second
  // dossier custom-frame channel beside post-admission's existing retain path.
  if (input.sealHead.fault !== undefined) {
    process.stderr.write(`${input.sealHead.fault}\n`);
  }
  return line;
}

/**
 * Move this leg's staged progress, receipts, and session directory from unbound
 * onto the ticket. Staging is private to the run — relocate appends into ticket
 * current.jsonl only. head / instruction / status / summary keep seal-time
 * values; rounds re-key into the ticket seat series.
 *
 * Copy → publish ticket current → drop sources. Rollback of destination copies
 * stops at publish (Node/POSIX copy-then-delete: a post-publish source rm
 * failure must not delete already-published destinations — 票面归位 / #1199 R1).
 */
export function relocateTicketProgressForLeg(input: {
  readonly oldRunDirectory: string;
  readonly newRunDirectory: string;
  readonly seat: string;
  readonly runId: string;
}): void {
  const oldSubject = subjectDirectoryOfRun(input.oldRunDirectory);
  const newSubject = subjectDirectoryOfRun(input.newRunDirectory);
  if (oldSubject === undefined || newSubject === undefined) return;
  if (oldSubject === newSubject) return;
  if (!isUnboundRunDirectory(input.oldRunDirectory)) return;

  const leaf = formatRunLeaf(input.runId, input.seat);
  const oldProgressPath = join(input.oldRunDirectory, LEG_PROGRESS_FILENAME);
  const mine = readProgressFile(oldProgressPath);

  const oldSibling = join(oldSubject, SESSIONS_DIRNAME, leaf);
  const newSibling = join(newSubject, SESSIONS_DIRNAME, leaf);
  const stagedCopies: string[] = [];
  const sourcesToRemove: string[] = [];

  const rollbackStagedCopies = (): void => {
    for (const copy of stagedCopies) {
      rmSync(copy, { recursive: true, force: true });
    }
  };

  try {
    if (existsSync(oldSibling)) {
      mkdirSync(dirname(newSibling), { recursive: true });
      if (existsSync(newSibling)) {
        throw new Error(
          `ticket progress relocate refuses to overwrite session ${newSibling} with ${oldSibling}`,
        );
      }
      // Track before copy: mid-cpSync failure must still roll back the destination
      // so retry is not blocked by existsSync(newSibling).
      stagedCopies.push(newSibling);
      cpSync(oldSibling, newSibling, { recursive: true });
      sourcesToRemove.push(oldSibling);
    }

    const ticketLines = [...readTicketProgressLines(newSubject)];
    const movedLines: TicketProgressLine[] = [];
    for (const line of mine) {
      const lens = roundLens(line.round);
      const round = nextRoundFromLines(ticketLines, line.seat, lens);
      const relativePath = `${RECEIPTS_DIRNAME}/${receiptFileName(line.seat, round)}`;
      const absolutePath = join(newSubject, relativePath);
      const oldReceiptAbs = join(oldSubject, line.receipt);
      if (existsSync(oldReceiptAbs)) {
        mkdirSync(dirname(absolutePath), { recursive: true });
        if (existsSync(absolutePath)) {
          throw new Error(
            `ticket progress relocate refuses to overwrite receipt ${absolutePath} with ${oldReceiptAbs}`,
          );
        }
        stagedCopies.push(absolutePath);
        copyFileSync(oldReceiptAbs, absolutePath);
        sourcesToRemove.push(oldReceiptAbs);
      }
      const moved: TicketProgressLine = {
        ...line,
        round,
        receipt: relativePath,
        session: line.session.replaceAll("\\", "/"),
      };
      movedLines.push(moved);
      ticketLines.push(moved);
    }

    // Publish ticket current before dropping staging / sources.
    if (movedLines.length > 0) {
      const newCurrent = join(newSubject, CURRENT_FILENAME);
      mkdirSync(dirname(newCurrent), { recursive: true });
      appendFileSync(
        newCurrent,
        `${movedLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
        "utf8",
      );
    }
  } catch (error) {
    // Partial copy / failed append: destinations are not yet authoritative.
    // Rollback must not mask the relocate failure — keep both causes.
    try {
      rollbackStagedCopies();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "ticket progress relocate failed and staged-copy rollback failed",
        { cause: error },
      );
    }
    throw error;
  }

  // After publish, destination copies are the originals for published rows.
  // Source cleanup must not roll them back (same root as pre-publish rename loss).
  if (existsSync(oldProgressPath)) {
    rmSync(oldProgressPath, { force: true });
  }
  const oldLegReceipts = join(input.oldRunDirectory, LEG_RECEIPTS_DIRNAME);
  if (existsSync(oldLegReceipts)) {
    rmSync(oldLegReceipts, { recursive: true, force: true });
  }
  for (const source of sourcesToRemove) {
    if (existsSync(source)) {
      rmSync(source, { recursive: true, force: true });
    }
  }
}
