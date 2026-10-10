/**
 * #1199 ticket-level progress: current.jsonl + receipts/ + sessions/ pointers.
 * Write at seal (createSubmissionLedgerHost → projectClosure), never by
 * post-turn history guessing. Per-leg dossiers stay until #1202.
 *
 * Unbound legs stage inside the run directory (owner 41f7c164): progress +
 * receipts ride the existing rename, then bind appends into the ticket
 * current.jsonl. Round authority is progress lines only — no receipt-filename
 * counting, occupancy placeholders, or claim-retry loops. Reviewer dual-lens
 * series count independently (`<n>.<lens>`).
 *
 * Relocate publishes ticket current before removing this leg's staging
 * (Node/POSIX: leave the only source until the destination write succeeds).
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { resolveHostDossierLandingPath } from "./host-session-record.ts";
import type { HostContext } from "./host-contracts.ts";
import { runDirectoryFromHostContext } from "./host-contracts.ts";
import { packagedRoleMetadata } from "./packaged-role-registry.ts";
import {
  formatRunLeaf,
  isUnboundRunDirectory,
  sessionDirectoryOf,
  sessionFileOf,
  subjectDirectoryOfRun,
} from "./role-run-placement.ts";
import { readPageSync } from "./run-dossier.ts";
import { isRecord } from "./unknown-value.ts";

const CURRENT_FILENAME = "current.jsonl" as const;
const RECEIPTS_DIRNAME = "receipts" as const;
const SESSIONS_DIRNAME = "sessions" as const;
const LEG_PROGRESS_FILENAME = "ticket-progress.jsonl" as const;
const LEG_RECEIPTS_DIRNAME = "ticket-receipts" as const;
const ROUND_INSTRUCTION_FILENAME = "round-instruction.txt" as const;

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

/** Persist this-turn instruction bytes for the seal-time progress row. */
export function rememberRoundInstruction(runDirectory: string, instruction: string): void {
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(join(runDirectory, ROUND_INSTRUCTION_FILENAME), instruction, "utf8");
}

function readRoundInstruction(runDirectory: string): string {
  const path = join(runDirectory, ROUND_INSTRUCTION_FILENAME);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function parseProgressText(text: string): TicketProgressLine[] {
  if (text.trim() === "") return [];
  const lines: TicketProgressLine[] = [];
  for (const raw of text.split("\n")) {
    if (raw.trim() === "") continue;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) continue;
    if (typeof parsed.seat !== "string" || typeof parsed.round !== "string") continue;
    lines.push(parsed as TicketProgressLine);
  }
  return lines;
}

function readProgressFile(path: string): TicketProgressLine[] {
  if (!existsSync(path)) return [];
  return parseProgressText(readFileSync(path, "utf8"));
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
 * Missing fields stay absent — never invent "" or "accepted".
 */
function statusAndSummaryFromPayload(seat: string, payload: unknown): {
  readonly status?: string;
  readonly summary?: string;
} {
  if (!isRecord(payload)) return {};
  let status: string | undefined;
  const meta = packagedRoleMetadata(seat);
  const seatKey = meta !== undefined && "receiptStatusKey" in meta
    ? meta.receiptStatusKey
    : undefined;
  if (typeof seatKey === "string" && typeof payload[seatKey] === "string") {
    status = payload[seatKey];
  } else if (typeof payload.status === "string") {
    status = payload.status;
  }
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
  // Admission landing (ticket/unbound sessions/), not a lagging live handle.
  if (host !== "" && host !== "pi" && host !== "hermes") {
    return resolveHostDossierLandingPath({ host, sessionDirectory });
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
  const line: TicketProgressLine = {
    at: new Date().toISOString(),
    seat: input.role,
    round,
    instruction: readRoundInstruction(runDirectory),
    head: input.sealHead.head,
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined ? {} : { summary }),
    receipt: relativePath,
    session: sessionRelative,
  };

  mkdirSync(dirname(progressPath), { recursive: true });
  appendFileSync(progressPath, `${JSON.stringify(line)}\n`, "utf8");
  if (input.sealHead.fault !== undefined) {
    // Same durable cleanup channel as post-admission (#840): session custom
    // entry beside the run. Fall back to stderr when the session leaf is absent.
    const sessionFile = sessionFileOf(runDirectory);
    try {
      mkdirSync(dirname(sessionFile), { recursive: true });
      const recordedAt = new Date().toISOString();
      appendFileSync(
        sessionFile,
        `${JSON.stringify({
          type: "custom",
          customType: "ak_post_admission_cleanup_diagnostic",
          data: { diagnostic: input.sealHead.fault, recordedAt },
          id: `ticket-progress-head-${recordedAt}`,
          parentId: null,
          timestamp: recordedAt,
        })}\n`,
        "utf8",
      );
    } catch {
      process.stderr.write(`[ticket-progress] ${input.sealHead.fault}\n`);
    }
  }
  return line;
}

/**
 * Move this leg's staged progress, receipts, and session directory from unbound
 * onto the ticket. Staging is private to the run — relocate appends into ticket
 * current.jsonl only. head / instruction / status / summary keep seal-time
 * values; rounds re-key into the ticket seat series.
 *
 * Target current must land before this leg's staging is removed — otherwise a
 * failed append destroys the only progress rows (票面归位 / quality-law mutation).
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
  if (existsSync(oldSibling)) {
    mkdirSync(dirname(newSibling), { recursive: true });
    if (existsSync(newSibling)) {
      throw new Error(
        `ticket progress relocate refuses to overwrite session ${newSibling} with ${oldSibling}`,
      );
    }
    renameSync(oldSibling, newSibling);
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
      renameSync(oldReceiptAbs, absolutePath);
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

  // Publish ticket current first; only then drop this leg's staging.
  if (movedLines.length > 0) {
    const newCurrent = join(newSubject, CURRENT_FILENAME);
    mkdirSync(dirname(newCurrent), { recursive: true });
    appendFileSync(
      newCurrent,
      `${movedLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8",
    );
  }

  if (existsSync(oldProgressPath)) {
    rmSync(oldProgressPath, { force: true });
  }
  const oldLegReceipts = join(input.oldRunDirectory, LEG_RECEIPTS_DIRNAME);
  if (existsSync(oldLegReceipts)) {
    rmSync(oldLegReceipts, { recursive: true, force: true });
  }
}
