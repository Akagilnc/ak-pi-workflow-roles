/**
 * #1199 ticket-level progress: current.jsonl + leg-local receipts/session.
 * Write at seal (createSubmissionLedgerHost → projectClosure), never by
 * post-turn history guessing. Per-leg dossiers stay until #1202.
 *
 * Originals stay in the leg directory (owner 14b58f6c / a8d2e72d):
 * `runs/<leg>/receipts/<n>.json`, `runs/<leg>/session/<原件>`.
 * Unbound legs stage rows in `progress.jsonl` (round empty); bind renames the
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
const LEG_PROGRESS_FILENAME = "progress.jsonl" as const;

/** One accepted-receipt progress row on the ticket (or unbound leg) subject. */
export type TicketProgressLine = {
  readonly at: string;
  readonly seat: string;
  /** Seat-local round; reviewer dual-lens uses `<n>.<lens>`. Empty while unbound. */
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
 * Unbound: each leg's `runs/<leaf>/progress.jsonl` (no shared file).
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

/** Leg-local receipt ordinal: `receipts/<n>.json` (not seat#round). */
function nextLegReceiptIndex(runDirectory: string): number {
  const dir = join(runDirectory, RECEIPTS_DIRNAME);
  if (!existsSync(dir)) return 1;
  let max = 0;
  for (const name of readdirSync(dir)) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match === null) continue;
    const n = Number(match[1]);
    if (Number.isSafeInteger(n) && n > max) max = n;
  }
  return max + 1;
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
  // Unbound: round stays empty until whole-leg bind publishes into ticket current.
  const round = unbound ? "" : nextRoundFromLines(existing, input.role, lens);
  const receiptIndex = nextLegReceiptIndex(runDirectory);
  const relativePath = `runs/${leaf}/${RECEIPTS_DIRNAME}/${receiptIndex}.json`;
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
 * After whole-leg rename (or retry when already under the ticket): fill rounds
 * on staged `progress.jsonl`, append ticket `current.jsonl`, then drop staging.
 * Receipt / session / head / instruction keep seal-time values and relative
 * paths — no copy, delete-source, or rollback of originals.
 */
export function relocateTicketProgressForLeg(input: {
  readonly runDirectory: string;
  readonly seat: string;
  readonly runId: string;
}): void {
  void input.seat;
  void input.runId;
  if (isUnboundRunDirectory(input.runDirectory)) return;

  const subjectDirectory = subjectDirectoryOfRun(input.runDirectory);
  if (subjectDirectory === undefined) return;
  if (basename(subjectDirectory) === "unbound") return;

  const stagedPath = join(input.runDirectory, LEG_PROGRESS_FILENAME);
  const mine = readProgressFile(stagedPath);
  if (mine.length === 0) {
    if (existsSync(stagedPath)) {
      rmSync(stagedPath, { force: true });
    }
    return;
  }

  const ticketLines = [...readTicketProgressLines(subjectDirectory)];
  const movedLines: TicketProgressLine[] = [];
  for (const line of mine) {
    const lens = roundLens(line.round);
    const round = nextRoundFromLines(ticketLines, line.seat, lens);
    const moved: TicketProgressLine = {
      ...line,
      round,
      receipt: line.receipt.replaceAll("\\", "/"),
      session: line.session.replaceAll("\\", "/"),
    };
    movedLines.push(moved);
    ticketLines.push(moved);
  }

  const newCurrent = join(subjectDirectory, CURRENT_FILENAME);
  mkdirSync(dirname(newCurrent), { recursive: true });
  appendFileSync(
    newCurrent,
    `${movedLines.map((line) => JSON.stringify(line)).join("\n")}\n`,
    "utf8",
  );
  // Append succeeded — drop staging. Failure above leaves progress.jsonl in place.
  rmSync(stagedPath, { force: true });
}
