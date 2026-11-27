/**
 * #1199 ticket-level progress: current.jsonl + leg-local receipts/session.
 * Write at seal (createSubmissionLedgerHost → projectClosure), never by
 * post-turn history guessing. Per-leg dossiers stay until #1202.
 *
 * Originals stay in the leg directory (owner 14b58f6c / a8d2e72d):
 * `runs/<leg>/receipts/<n>.json`, `runs/<leg>/session/<原件>`.
 * Unbound legs stage rows in their own ledger (round empty); bind renames the
 * whole leg, then this module fills rounds and appends ticket current.jsonl.
 * Round authority is progress lines only — no receipt-filename counting,
 * occupancy placeholders, or claim-retry loops. Reviewer dual-lens series
 * count independently (`<n>.<lens>`).
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";

import { resolveHostDossierLandingPath } from "./host-session-record.ts";
import type { HostContext } from "./host-contracts.ts";
import { runDirectoryFromHostContext } from "./host-contracts.ts";
import { packagedGateStageLabel, receiptStatus } from "./packaged-role-registry.ts";
import {
  isUnboundRunDirectory,
  sessionDirectoryOf,
  sessionFileOf,
  subjectDirectoryOfRun,
} from "./role-run-placement.ts";
import { pageFromRows, readStateControlRowsSync } from "./run-dossier.ts";
import { PROGRESS_RECORD_KIND } from "./run-dossier-files.ts";
import { runIdFromRunDirectory } from "./run-terminal-artifacts.ts";
import { sitianReport } from "./sitian-facade.ts";
import { parseSitianRecordText } from "./sitian-reader.ts";
import { errnoCode, errorText, isRecord } from "./unknown-value.ts";

const CURRENT_FILENAME = "current.jsonl" as const;
const RECEIPTS_DIRNAME = "receipts" as const;

/** One accepted-receipt progress row on the ticket (or unbound leg) subject. */
export type TicketProgressLine = {
  readonly at: string;
  readonly seat: string;
  /** Seat-local round; reviewer dual-lens uses `<n>.<lens>`. Empty while unbound. */
  readonly round: string;
  /**
   * #1200 `<seat>#<round>` this row reviews or fixes. Officer rows copy the value
   * pinned at admission; fixer rows copy the receipt's own `for`. Absent otherwise.
   */
  readonly for?: string;
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
 * Append-only progress JSONL through the sole Sitian decoder: reachable rows
 * plus one diagnostic per malformed line.
 */
function decodeProgressFile(path: string): {
  readonly lines: TicketProgressLine[];
  readonly malformed: readonly string[];
} {
  if (!existsSync(path)) return { lines: [], malformed: [] };
  const text = readFileSync(path, "utf8");
  if (text.trim() === "") return { lines: [], malformed: [] };
  const { records, diagnostics } = parseSitianRecordText(text);
  const lines: TicketProgressLine[] = [];
  for (const record of records) {
    const parsed: unknown = record;
    if (!isRecord(parsed)) continue;
    if (typeof parsed.seat !== "string" || typeof parsed.round !== "string") continue;
    lines.push(parsed as unknown as TicketProgressLine);
  }
  return {
    lines,
    malformed: diagnostics.map((diagnostic) => `line ${diagnostic.line}: ${diagnostic.error}`),
  };
}

/**
 * Same posture as run-dossier row files: malformed lines leave diagnostics on
 * stderr and do not abort seal/relocate.
 */
function readProgressFile(path: string): TicketProgressLine[] {
  const { lines, malformed } = decodeProgressFile(path);
  for (const diagnostic of malformed) {
    process.stderr.write(
      `[ticket-progress] ${path} has malformed row(s); keeps reachable rows and retains the diagnostic: ${diagnostic}\n`,
    );
  }
  return lines;
}

/** Progress rows of a ticket: its append-only `current.jsonl`. */
export function readTicketProgressLines(ticketDirectory: string): TicketProgressLine[] {
  return readProgressFile(join(ticketDirectory, CURRENT_FILENAME));
}

function roundBaseNumber(round: string): number {
  if (round.trim() === "") return 0;
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

function receiptReference(runDirectory: string, file: string): string {
  return `runs/${basename(runDirectory)}/${RECEIPTS_DIRNAME}/${file}`;
}

/** Includes originals whose writer stopped before recording even a candidate. */
export function legReceiptReferences(runDirectory: string): string[] {
  const dir = join(runDirectory, RECEIPTS_DIRNAME);
  try {
    return readdirSync(dir).filter(name => /^[1-9]\d*\.json$/.test(name)).map(name => receiptReference(runDirectory, name));
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
}

export function writeArrivingReceipt(runDirectory: string, original: unknown): string {
  const directory = join(runDirectory, RECEIPTS_DIRNAME);
  mkdirSync(directory, { recursive: true });
  const text = `${JSON.stringify(original, null, 2)}\n`;
  const last = legReceiptReferences(runDirectory).reduce((max, receipt) => {
    const n = BigInt(basename(receipt, ".json"));
    return n > max ? n : max;
  }, 0n);
  for (let n = last + 1n; ; n++) {
    const file = `${n}.json`;
    try {
      writeFileSync(join(directory, file), text, { flag: "wx" });
      return receiptReference(runDirectory, file);
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
  }
}

/**
 * Copy structured status/summary from the seat receipt.
 * summary is seat-authored prose on the receipt.
 * Missing fields stay absent — never invent "" or "accepted".
 */
export function statusAndSummaryFromPayload(payload: unknown): {
  readonly status?: string;
  readonly summary?: string;
} {
  if (!isRecord(payload)) return {};
  const received = receiptStatus(payload);
  const status = typeof received === "string" ? received : undefined;
  const summary = typeof payload.summary === "string" ? payload.summary : undefined;
  return {
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined ? {} : { summary }),
  };
}

/**
 * #1200「审 谁#轮」at officer admission: the row of the receipt under review,
 * found by its name. A receipt with no row (unbound, or never accepted) has no
 * round. A progress file that cannot be read or has malformed rows has none
 * either and returns the cause for the caller to retain — the officer still runs.
 */
export function readAuditedRound(auditedRunDirectory: string, receiptName: string): {
  readonly for?: string;
  readonly fault?: string;
} {
  try {
    const subjectDirectory = subjectDirectoryOfRun(auditedRunDirectory);
    if (subjectDirectory === undefined) return {};
    const path = join(subjectDirectory, CURRENT_FILENAME);
    const { lines, malformed } = decodeProgressFile(path);
    if (malformed.length > 0) {
      throw new Error(`${path} has malformed row(s): ${malformed.join("; ")}`);
    }
    const ref = receiptReference(auditedRunDirectory, receiptName);
    const row = lines.filter(line => line.receipt === ref).at(-1);
    return row === undefined ? {} : { for: `${row.seat}#${row.round}` };
  } catch (error) {
    return { fault: `audited round unavailable for ${auditedRunDirectory}: ${errorText(error)}` };
  }
}

/**
 * The row's `for`: gate officers copy the admission pin; the fixer's receipt
 * reports its own (copied when it is a string, never checked). No other seat has one.
 */
function forOfSealedRow(auditedRound: string | undefined, seat: string, payload: unknown): string | undefined {
  const reported = packagedGateStageLabel(seat) !== undefined
    ? auditedRound
    : seat === "fixer" && isRecord(payload) ? payload.for : undefined;
  return typeof reported === "string" ? reported : undefined;
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

/** The sealing tool call a progress row belongs to, as the submission ledger names it. */
export type ProgressRowCall = {
  readonly attemptId: string;
  readonly toolCallId: string;
};

/**
 * #1201: the row just written rides the leg's submission ledger to the process
 * that prints the terminal — settlement reads round and receipt beside the
 * sealed payload, and never picks rows out of current.jsonl after the turn.
 * A seal names its tool call; a publish (round filled at bind) names the receipt.
 * An unbound leg's row (round empty) carries the whole line: this is its staging
 * until bind publishes it.
 */
function carryProgressRow(
  runDirectory: string,
  line: TicketProgressLine,
  call?: ProgressRowCall,
): void {
  const runId = runIdFromRunDirectory(runDirectory);
  // The row is an unbound leg's only staging: a leg it cannot be written for fails loudly.
  if (runId === undefined) throw new Error(`progress row needs a run leaf <runId>@<role>: ${runDirectory}`);
  sitianReport({
    level: "event",
    kind: PROGRESS_RECORD_KIND,
    subject: { runId, ...(call === undefined ? {} : { attemptId: call.attemptId }) },
    payload: {
      type: PROGRESS_RECORD_KIND,
      ...(call === undefined ? {} : { toolCallId: call.toolCallId }),
      receipt: line.receipt,
      round: line.round,
      ...(line.round === "" ? { line } : {}),
    },
    source: "ticket-progress",
    sessionParent: sessionFileOf(runDirectory),
  });
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

function lensFromRunDirectory(
  runDirectory: string,
  role: string,
  rows: readonly Record<string, unknown>[],
): string | undefined {
  if (role !== "reviewer") return undefined;
  const lens = pageFromRows(rows, "admitted", runDirectory)?.lens;
  return lens === "completeness" || lens === "correctness" ? lens : undefined;
}

/**
 * Seal-time landing from createSubmissionLedgerHost (before projectClosure).
 * Missing run directory → no-op (ledger still sealed).
 */
export function landTicketProgressForSealedSubmission(input: {
  readonly context: HostContext;
  readonly fields: ReturnType<typeof statusAndSummaryFromPayload>;
  readonly receipt: string;
  readonly role: string;
  readonly accepted: unknown;
  readonly sealHead: WorktreeHeadCapture;
  readonly lens?: string;
  readonly call: ProgressRowCall;
}): TicketProgressLine | undefined {
  const runDirectory = runDirectoryFromHostContext(input.context);
  if (runDirectory === undefined) return undefined;
  return landTicketProgress({
    runDirectory,
    receipt: input.receipt,
    role: input.role,
    accepted: input.accepted,
    fields: input.fields,
    sealHead: input.sealHead,
    call: input.call,
    ...(input.lens === undefined ? {} : { lens: input.lens }),
    sessionFile: progressSessionAbsolute(runDirectory, input.context),
    auditedRound: input.context.auditedRound,
    instruction: typeof input.context.summonsInstruction === "string"
      ? input.context.summonsInstruction
      : "",
  });
}

/**
 * Original receipt plus progress line for one sealed submission.
 * `sessionFile` is absent for a run that never had a host session (the
 * navigator lookup, #1192): the line then names no session.
 */
export function landTicketProgress(input: {
  readonly fields: ReturnType<typeof statusAndSummaryFromPayload>;
  readonly runDirectory: string;
  readonly receipt: string;
  readonly role: string;
  readonly accepted: unknown;
  readonly sealHead: WorktreeHeadCapture;
  readonly lens?: string;
  readonly sessionFile: string | undefined;
  readonly auditedRound?: string | undefined;
  readonly instruction: string;
  readonly call: ProgressRowCall;
}): TicketProgressLine | undefined {
  const { runDirectory } = input;

  const subjectDirectory = subjectDirectoryOfRun(runDirectory);
  if (subjectDirectory === undefined) return undefined;

  const unbound = basename(subjectDirectory) === "unbound";
  // Unbound: round stays empty until whole-leg bind publishes into ticket current,
  // so the leg's ledger is not read here.
  let round = "";
  if (!unbound) {
    // A filed leg's ledger is read once for both the lens and the staged rows.
    const rows = readStateControlRowsSync(runDirectory);
    const lens = input.lens === "completeness" || input.lens === "correctness"
      ? input.lens
      : lensFromRunDirectory(runDirectory, input.role, rows);
    // #1199 R1: bound leg with staged rows left must publish before this seal
    // takes the next ticket round — optional ticketNumber must not be required.
    relocateTicketProgressForLeg({ runDirectory }, undefined, rows);
    round = nextRoundFromLines(readTicketProgressLines(subjectDirectory), input.role, lens);
  }

  const sessionRelative = input.sessionFile === undefined
    ? ""
    : relative(subjectDirectory, input.sessionFile).split(sep).join("/");
  const { status, summary } = input.fields;
  const reviewed = forOfSealedRow(input.auditedRound, input.role, input.accepted);
  const instruction = input.instruction;
  const line: TicketProgressLine = {
    at: new Date().toISOString(),
    seat: input.role,
    round,
    ...(reviewed === undefined ? {} : { for: reviewed }),
    instruction,
    head: input.sealHead.head,
    ...(status === undefined ? {} : { status }),
    ...(summary === undefined ? {} : { summary }),
    receipt: input.receipt,
    session: sessionRelative,
  };

  if (!unbound) appendFileSync(join(subjectDirectory, CURRENT_FILENAME), `${JSON.stringify(line)}\n`, "utf8");
  carryProgressRow(runDirectory, line, input.call);
  // HEAD capture fault: keep the raw cause on stderr. Do not invent a second
  // dossier custom-frame channel beside post-admission's existing retain path.
  if (input.sealHead.fault !== undefined) {
    process.stderr.write(`${input.sealHead.fault}\n`);
  }
  return line;
}

/**
 * After whole-leg rename (or retry when already under the ticket): fill rounds
 * on the rows staged in the leg's ledger and append ticket `current.jsonl`. A
 * staged row is one whose receipt has no later row with its round filled.
 * Receipt / session / head / instruction keep seal-time values and relative
 * paths — no copy, delete-source, or rewrite of relative pointers.
 *
 * Unbound staging leaves `round` empty; publish takes the leg's sealed lens from
 * the admitted page (`lensFromRunDirectory`), never from receipt prose. A caller
 * that holds the leg's ledger rows with nothing written since passes them.
 */
export function relocateTicketProgressForLeg(input: {
  readonly runDirectory: string;
}, publishedRounds?: Map<string, string>, heldRows?: readonly Record<string, unknown>[]): void {
  if (isUnboundRunDirectory(input.runDirectory)) return;

  const subjectDirectory = subjectDirectoryOfRun(input.runDirectory);
  if (subjectDirectory === undefined) return;

  const rows = heldRows ?? readStateControlRowsSync(input.runDirectory);
  const staged = new Map<string, TicketProgressLine>();
  for (const { kind, payload } of rows) {
    if (kind !== PROGRESS_RECORD_KIND || !isRecord(payload) || typeof payload.receipt !== "string") continue;
    if (payload.round === "" && isRecord(payload.line)) staged.set(payload.receipt, payload.line as TicketProgressLine);
    else staged.delete(payload.receipt);
  }
  if (staged.size === 0) return;
  const mine = [...staged.values()];

  const ticketLines = readTicketProgressLines(subjectDirectory);
  const priorCount = ticketLines.length;
  // Receipt path is the seal identity. Append-then-carry partial success must
  // not reassign rounds or re-append the same originals on re-entry (#1199 F2).
  const published = new Map(ticketLines.map(line => [line.receipt, line]));
  const pending = mine.filter(line => !published.has(line.receipt));
  if (pending.length > 0) {
    // Current unbound staging publishes empty rounds; lens comes only from this
    // leg's admitted page, taken once: a leg has one seat. No legacy staged-round
    // mirror-suffix branch.
    const lens = lensFromRunDirectory(input.runDirectory, pending[0]!.seat, rows);
    for (const line of pending) {
      const moved = { ...line, round: nextRoundFromLines(ticketLines, line.seat, lens) };
      published.set(line.receipt, moved);
      ticketLines.push(moved);
    }
    const newCurrent = join(subjectDirectory, CURRENT_FILENAME);
    mkdirSync(dirname(newCurrent), { recursive: true });
    appendFileSync(newCurrent, `${ticketLines.slice(priorCount).map(line => JSON.stringify(line)).join("\n")}\n`, "utf8");
  }
  // The ticket row is committed even if later cleanup or rendering fails.
  const filed = mine.map(({ receipt }) => published.get(receipt)!);
  if (publishedRounds) for (const line of filed) publishedRounds.set(join(subjectDirectory, line.receipt), line.round);
  // The round-filled row retires the staging one, only after its ticket row
  // (also on retry) is durable. Replaying it never creates a new round.
  for (const line of filed) carryProgressRow(input.runDirectory, line);
}
