/**
 * #1199 ticket-level progress: current.jsonl + receipts/ + sessions/ pointers.
 * Write at seal (createSubmissionLedgerHost → projectClosure), never by
 * post-turn history guessing. Per-leg dossiers stay until #1202.
 *
 * Unbound legs stage inside the run directory (owner 41f7c164 / provenance
 * seam): progress + receipts ride the existing rename, then bind appends into
 * the ticket current.jsonl. Round authority is progress lines only — no
 * receipt-filename counting, occupancy placeholders, or claim-retry loops.
 * Reviewer dual-lens series count independently (`<n>.<lens>`).
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

export const TICKET_CURRENT_FILENAME = "current.jsonl" as const;
export const TICKET_RECEIPTS_DIRNAME = "receipts" as const;
export const TICKET_SESSIONS_DIRNAME = "sessions" as const;
/** Unbound staging inside the run directory (moves with rename). */
export const RUN_TICKET_PROGRESS_FILENAME = "ticket-progress.jsonl" as const;
export const RUN_TICKET_RECEIPTS_DIRNAME = "ticket-receipts" as const;
/** This-turn summons / 催交 bytes retained by the input seam for seal. */
export const RUN_ROUND_INSTRUCTION_FILENAME = "round-instruction.txt" as const;

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

export function ticketCurrentPath(subjectDirectory: string): string {
  return join(subjectDirectory, TICKET_CURRENT_FILENAME);
}

export function runLegProgressPath(runDirectory: string): string {
  return join(runDirectory, RUN_TICKET_PROGRESS_FILENAME);
}

export function runRoundInstructionPath(runDirectory: string): string {
  return join(runDirectory, RUN_ROUND_INSTRUCTION_FILENAME);
}

/** Persist this-turn instruction bytes for the seal-time progress row. */
export function rememberRoundInstruction(runDirectory: string, instruction: string): void {
  mkdirSync(runDirectory, { recursive: true });
  writeFileSync(runRoundInstructionPath(runDirectory), instruction, "utf8");
}

export function readRoundInstruction(runDirectory: string): string {
  const path = runRoundInstructionPath(runDirectory);
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}

function isUnboundSubject(subjectDirectory: string): boolean {
  return basename(subjectDirectory) === "unbound";
}

/** Receipt leaf name: `<seat>#<round>.json`. */
export function ticketReceiptFileName(seat: string, round: string): string {
  return `${seat}#${round}.json`;
}

export function ticketReceiptRelativePath(seat: string, round: string): string {
  return `${TICKET_RECEIPTS_DIRNAME}/${ticketReceiptFileName(seat, round)}`;
}

/** Unbound staging receipt path relative to the subject (run leaf under runs/). */
export function unboundLegReceiptRelativePath(
  leaf: string,
  seat: string,
  round: string,
): string {
  return `runs/${leaf}/${RUN_TICKET_RECEIPTS_DIRNAME}/${ticketReceiptFileName(seat, round)}`;
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
  if (isUnboundSubject(subjectDirectory)) {
    const runsDir = join(subjectDirectory, "runs");
    if (!existsSync(runsDir)) return [];
    const out: TicketProgressLine[] = [];
    for (const name of readdirSync(runsDir).sort()) {
      out.push(...readProgressFile(runLegProgressPath(join(runsDir, name))));
    }
    return out;
  }
  return readProgressFile(ticketCurrentPath(subjectDirectory));
}

function roundBaseNumber(round: string): number {
  const base = round.includes(".") ? round.slice(0, round.indexOf(".")) : round;
  const n = Number(base);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function roundLens(round: string): string | undefined {
  return round.includes(".") ? round.slice(round.indexOf(".") + 1) : undefined;
}

function formatRound(base: number, lens?: string): string {
  return lens === undefined || lens.trim() === "" ? String(base) : `${base}.${lens}`;
}

/**
 * Next seat-local round from progress lines only.
 * Dual-lens series are independent: completeness does not advance correctness.
 */
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
  return formatRound(max + 1, want);
}

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

function writeReceipt(absolutePath: string, payload: unknown): void {
  ensureParentDir(absolutePath);
  writeFileSync(absolutePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

export type WorktreeHeadCapture = {
  readonly head: string;
  readonly fault?: string;
};

/**
 * Worktree HEAD at seal.
 * On failure head is empty and fault carries the true cause.
 */
export function captureWorktreeHead(projectRoot: string): WorktreeHeadCapture {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    });
    if (result.error !== undefined && result.error !== null) {
      const err = result.error;
      const detail = err instanceof Error
        ? (err.stack ?? err.message)
        : String(err);
      return {
        head: "",
        fault: `git rev-parse HEAD spawn failed cwd=${projectRoot}: ${detail}`,
      };
    }
    if (result.status !== 0) {
      const detail = [result.stderr, result.stdout]
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter((part) => part !== "")
        .join(" | ");
      const status = result.status === null ? "null" : String(result.status);
      const signal = result.signal === null || result.signal === undefined
        ? ""
        : ` signal=${result.signal}`;
      return {
        head: "",
        fault: detail === ""
          ? `git rev-parse HEAD failed (status=${status}${signal}) cwd=${projectRoot}`
          : `git rev-parse HEAD failed (status=${status}${signal}) cwd=${projectRoot}: ${detail}`,
      };
    }
    return { head: (result.stdout ?? "").trim() };
  } catch (error) {
    const message = error instanceof Error
      ? (error.stack ?? error.message)
      : String(error);
    return {
      head: "",
      fault: `git rev-parse HEAD threw cwd=${projectRoot}: ${message}`,
    };
  }
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
  if (typeof seatKey === "string") {
    const value = payload[seatKey];
    if (typeof value === "string") status = value;
  }
  if (status === undefined && typeof payload.status === "string") {
    status = payload.status;
  }
  const summary = typeof payload.summary === "string" ? payload.summary : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined ? {} : { summary }),
  };
}

function progressSessionAbsolute(
  runDirectory: string,
  context: HostContext,
): string {
  const host = typeof context.host === "string" ? context.host.trim() : "";
  const sessionDirectory = sessionDirectoryOf(runDirectory);
  // Determined landing from public admission (ticket/unbound sessions/), not a
  // lagging live handle that may still point at a legacy run/session path.
  if (host !== "" && host !== "pi" && host !== "hermes") {
    return resolveHostDossierLandingPath({ host, sessionDirectory });
  }
  return sessionFileOf(runDirectory);
}

function lensFromRunDirectory(runDirectory: string, role: string): string | undefined {
  if (role !== "reviewer") return undefined;
  const admitted = readPageSync(runDirectory, "admitted");
  const lens = admitted?.lens;
  return lens === "completeness" || lens === "correctness" ? lens : undefined;
}

/**
 * Append one progress row at seal (projectClosure).
 * Unbound → run-directory staging. Ticket → shared current.jsonl.
 * Never invents a receipt when there is no sealed payload.
 */
export function appendTicketProgressAtSeal(input: {
  readonly runDirectory: string;
  readonly seat: string;
  readonly projectRoot: string;
  readonly sessionFile: string;
  readonly receiptPayload: unknown;
  readonly instruction: string;
  readonly lens?: string;
  readonly sealedWorktreeHead: string;
  readonly sealedWorktreeHeadFault?: string;
  readonly noteFault?: (diagnostic: string) => void;
}): TicketProgressLine | undefined {
  const subjectDirectory = subjectDirectoryOfRun(input.runDirectory);
  if (subjectDirectory === undefined) return undefined;

  const leaf = basename(input.runDirectory);
  const unbound = isUnboundSubject(subjectDirectory);
  const progressPath = unbound
    ? runLegProgressPath(input.runDirectory)
    : ticketCurrentPath(subjectDirectory);
  const existing = unbound
    ? readProgressFile(progressPath)
    : readTicketProgressLines(subjectDirectory);
  // Ticket seat series: count ticket lines only. Unbound: this leg's staging only.
  const round = nextRoundFromLines(existing, input.seat, input.lens);
  const relativePath = unbound
    ? unboundLegReceiptRelativePath(leaf, input.seat, round)
    : ticketReceiptRelativePath(input.seat, round);
  const absolutePath = join(subjectDirectory, relativePath);
  writeReceipt(absolutePath, input.receiptPayload);

  const sessionRelative = relative(subjectDirectory, input.sessionFile).split(sep).join("/");
  const { status, summary } = statusAndSummaryFromPayload(input.seat, input.receiptPayload);
  const line: TicketProgressLine = {
    at: new Date().toISOString(),
    seat: input.seat,
    round,
    instruction: input.instruction,
    head: input.sealedWorktreeHead,
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined ? {} : { summary }),
    receipt: relativePath,
    session: sessionRelative,
  };

  ensureParentDir(progressPath);
  appendFileSync(progressPath, `${JSON.stringify(line)}\n`, "utf8");
  if (input.sealedWorktreeHeadFault !== undefined) {
    if (input.noteFault !== undefined) {
      input.noteFault(input.sealedWorktreeHeadFault);
    } else {
      process.stderr.write(`[ticket-progress] ${input.sealedWorktreeHeadFault}\n`);
    }
  }
  return line;
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

  const lens = (
    input.lens === "completeness" || input.lens === "correctness"
      ? input.lens
      : lensFromRunDirectory(runDirectory, input.role)
  );

  return appendTicketProgressAtSeal({
    runDirectory,
    seat: input.role,
    projectRoot: input.context.cwd,
    sessionFile: progressSessionAbsolute(runDirectory, input.context),
    receiptPayload: input.accepted,
    instruction: readRoundInstruction(runDirectory),
    ...(lens === undefined ? {} : { lens }),
    sealedWorktreeHead: input.sealHead.head,
    ...(input.sealHead.fault === undefined ? {} : { sealedWorktreeHeadFault: input.sealHead.fault }),
  });
}

/**
 * Move this leg's staged progress, receipts, and session directory from unbound
 * onto the ticket. Staging is private to the run — relocate appends into ticket
 * current.jsonl only (no shared unbound rewrite). head / instruction / status /
 * summary keep seal-time values; rounds re-key into the ticket seat series.
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
  const oldProgressPath = runLegProgressPath(input.oldRunDirectory);
  const mine = readProgressFile(oldProgressPath);

  const oldSibling = join(oldSubject, TICKET_SESSIONS_DIRNAME, leaf);
  const newSibling = join(newSubject, TICKET_SESSIONS_DIRNAME, leaf);
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
    const relativePath = ticketReceiptRelativePath(line.seat, round);
    const absolutePath = join(newSubject, relativePath);
    const oldReceiptAbs = join(oldSubject, line.receipt);
    if (existsSync(oldReceiptAbs)) {
      ensureParentDir(absolutePath);
      renameSync(oldReceiptAbs, absolutePath);
    }
    const sessionRelative = line.session.replaceAll("\\", "/");
    const moved: TicketProgressLine = {
      ...line,
      round,
      receipt: relativePath,
      session: sessionRelative,
    };
    movedLines.push(moved);
    ticketLines.push(moved);
  }

  if (existsSync(oldProgressPath)) {
    rmSync(oldProgressPath, { force: true });
  }
  const oldLegReceipts = join(input.oldRunDirectory, RUN_TICKET_RECEIPTS_DIRNAME);
  if (existsSync(oldLegReceipts)) {
    rmSync(oldLegReceipts, { recursive: true, force: true });
  }

  if (movedLines.length === 0) return;
  const newCurrent = ticketCurrentPath(newSubject);
  ensureParentDir(newCurrent);
  appendFileSync(
    newCurrent,
    `${movedLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
}
