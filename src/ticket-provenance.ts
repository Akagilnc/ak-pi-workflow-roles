/**
 * 起居录 volume helpers — ADR 0075 / ADR 0081 / ADR 0086 / #1090.
 * 一册＝一个追加式 records.jsonl。每轮新投影经司天台 appender 追加为不可变提交；
 * 纯追加、不回读历史去重、不折叠。
 */
import { readFile, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import {
  errnoCode,
  packageMachineHome,
  physicallyContainedIn,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";
import {
  readLedgerSessionJsonlLines,
  type LedgerSessionLine,
} from "./ledger-session-read.ts";
import { isSafePositiveTicketNumber } from "./run-ticket-number.ts";
import { adaptSessionDialogue, nativeEventId } from "./session-dialogue.ts";
import {
  appendSitianRecordBlock,
  appendSitianRecord,
  resolveSitianRecordPath,
  type SitianRecordInput,
} from "./sitian-facade.ts";
import {
  TICKET_PROVENANCE_KIND,
  type TicketProvenanceBound,
  type TicketProvenanceLine,
  type TicketProvenanceRange,
  type TicketProvenanceSession,
} from "./ticket-provenance-contracts.ts";

/**
 * Typed input failure for diarist bounds/session path (reask, not infrastructure).
 * Accept hook discriminates with instanceof — never Error.message prefixes.
 */
export class TicketProvenanceInputError extends Error {
  readonly code = "ticket-provenance-input" as const;
  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "TicketProvenanceInputError";
  }
}

/**
 * Host-owned session source roots (ADR 0038 / ADR 0081 cross-host).
 * Narrow directory identities — not whole `.pi` / whole `.ak-roles`.
 */
function dialogueSessionSourceRoots(home?: string): readonly string[] {
  const machineHome =
    typeof home === "string" && home.trim() !== ""
      ? home
      : packageMachineHome();
  return [
    join(machineHome, ".claude", "projects"),
    join(machineHome, ".codex", "sessions"),
    join(machineHome, ".pi", "agent", "sessions"),
  ];
}

/**
 * True when path is a sitian role-run session volume:
 * `<ledger>/books/.../session/session.jsonl` (basename + parent only — no body probe).
 */
function isLedgerRoleSessionFile(absolute: string, home?: string): boolean {
  const machineHome =
    typeof home === "string" && home.trim() !== ""
      ? home
      : packageMachineHome();
  const ledgerHome = resolveActivationLedgerHome(machineHome);
  if (!physicallyContainedIn(ledgerHome, absolute)) return false;
  return (
    basename(absolute) === "session.jsonl" &&
    basename(dirname(absolute)) === "session"
  );
}

/** Real I/O seam gate: only host session stores or sitian role-run session.jsonl. */
function assertDialogueSessionSourcePath(path: string, home?: string): void {
  const absolute = resolve(path);
  for (const root of dialogueSessionSourceRoots(home)) {
    if (physicallyContainedIn(root, absolute)) return;
  }
  if (isLedgerRoleSessionFile(absolute, home)) return;
  throw new TicketProvenanceInputError(
    `session unreadable: ${path} (outside authorized source roots)`,
  );
}

/** Subject string for ticket-keyed volumes — history follows the ticket. */
function ticketProvenanceSubject(ticketNumber: number): string {
  if (!isSafePositiveTicketNumber(ticketNumber)) {
    throw new Error(
      `ticket-provenance subject requires a positive ticket number, got ${String(ticketNumber)}`,
    );
  }
  return String(ticketNumber);
}

/** Topology input only — no destination parameter (ADR 0065 record-entry). */
function ticketProvenanceRecordInput(
  ticketNumber: number | null,
  cwd: string,
  home?: string,
  runDirectory?: string,
): SitianRecordInput {
  return {
    level: "event",
    kind: TICKET_PROVENANCE_KIND,
    ...(ticketNumber === null ? {} : { subject: ticketProvenanceSubject(ticketNumber) }),
    ...(runDirectory === undefined ? {} : { runDirectory }),
    cwd,
    ...(home === undefined ? {} : { home }),
  };
}

export type TicketProvenanceVolumePath = {
  readonly recordFile: string;
  readonly volumeDir: string;
};

/** Resolve volume paths for a ticket without writing. */
export function resolveTicketProvenanceVolume(
  ticketNumber: number,
  cwd: string,
  home?: string,
): TicketProvenanceVolumePath {
  const path = resolveSitianRecordPath(
    ticketProvenanceRecordInput(ticketNumber, cwd, home),
  );
  return { recordFile: path.recordFile, volumeDir: path.sessionDir };
}

type TicketProvenanceRaw = {
  readonly raw: string;
  readonly s: number;
  readonly sourcePosition: number;
  readonly sourceIdentity?: string;
};

/** Assign a run-owned unbound diary as its original block through Sitian. */
export async function rehomeUnboundTicketProvenance(
  runDirectory: string,
  ticketNumber: number,
  cwd: string,
  home: string,
): Promise<void> {
  const source = join(runDirectory, "records.jsonl");
  let content: string;
  try {
    content = await readFile(source, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return;
    throw error;
  }
  appendSitianRecordBlock(ticketProvenanceRecordInput(ticketNumber, cwd, home), content);
  await unlink(source);
}

/**
 * Resolve a bound endpoint against this round's session lines.
 * id → first physical line carrying that native id; line → that 1-based line.
 * Either missing from the volume → undefined (caller reasks).
 */
function resolveBoundIndex(
  bound: TicketProvenanceBound,
  sessionLines: readonly LedgerSessionLine[],
): number | undefined {
  if (typeof bound.id === "string" && bound.id !== "") {
    for (let index = 0; index < sessionLines.length; index += 1) {
      const row = sessionLines[index]!.row;
      if (row === undefined) continue;
      if (nativeEventId(row) === bound.id) return index;
    }
    return undefined;
  }
  if (typeof bound.line === "number") {
    for (let index = 0; index < sessionLines.length; index += 1) {
      if (sessionLines[index]!.line === bound.line) return index;
    }
    return undefined;
  }
  return undefined;
}

/**
 * Give every logical source row a replay-invariant ordinal. Native ids identify
 * replayed rows directly; idless rows use their ordinal after the preceding
 * native id. Neither key inspects dialogue text or physical line numbers.
 */
function stableSourceFacts(
  sessionLines: readonly LedgerSessionLine[],
): readonly { readonly position: number; readonly identity: string }[] {
  const positionByIdentity = new Map<string, number>();
  const facts: { position: number; identity: string }[] = [];
  let precedingId = "<start>";
  let idlessOffset = 0;
  for (const entry of sessionLines) {
    const id = entry.row === undefined ? undefined : nativeEventId(entry.row);
    if (id !== undefined) {
      precedingId = id;
      idlessOffset = 0;
    } else {
      idlessOffset += 1;
    }
    const identity = id === undefined
      ? `after\u0000${precedingId}\u0000${idlessOffset}`
      : `id\u0000${id}`;
    let position = positionByIdentity.get(identity);
    if (position === undefined) {
      position = positionByIdentity.size;
      positionByIdentity.set(identity, position);
    }
    facts.push({ position, identity });
  }
  return facts;
}

/**
 * Resolve submitted ranges against the session, then sort by source position and
 * merge overlaps so each physical row is visited once (#901 source order).
 */
function normalizeResolvedRanges(
  ranges: readonly TicketProvenanceRange[],
  sessionLines: readonly LedgerSessionLine[],
  sessionPath: string,
): readonly { readonly fromIndex: number; readonly toIndex: number }[] {
  const resolved: { fromIndex: number; toIndex: number }[] = [];
  for (const range of ranges) {
    const fromIndex = resolveBoundIndex(range.from, sessionLines);
    const toIndex = resolveBoundIndex(range.to, sessionLines);
    if (fromIndex === undefined || toIndex === undefined) {
      throw new TicketProvenanceInputError(
        `bound endpoint not found in ${sessionPath} (from=${JSON.stringify(range.from)} to=${JSON.stringify(range.to)})`,
      );
    }
    if (fromIndex > toIndex) {
      throw new TicketProvenanceInputError(
        `bound range inverted in ${sessionPath} (from index ${fromIndex} > to index ${toIndex})`,
      );
    }
    resolved.push({ fromIndex, toIndex });
  }
  resolved.sort(
    (left, right) =>
      left.fromIndex - right.fromIndex || left.toIndex - right.toIndex,
  );
  const merged: { fromIndex: number; toIndex: number }[] = [];
  for (const range of resolved) {
    const last = merged[merged.length - 1];
    if (last !== undefined && range.fromIndex <= last.toIndex + 1) {
      last.toIndex = Math.max(last.toIndex, range.toIndex);
      continue;
    }
    merged.push({ fromIndex: range.fromIndex, toIndex: range.toIndex });
  }
  return merged;
}

/**
 * Project one session's ranges into diary lines.
 * Unusable bounds throw with a stable message the accept hook turns into reask.
 */
async function projectSessionRanges(input: {
  readonly s: number;
  readonly session: TicketProvenanceSession;
  readonly home?: string;
}): Promise<{
  readonly entries: (TicketProvenanceLine | TicketProvenanceRaw)[];
}> {
  assertDialogueSessionSourcePath(input.session.path, input.home);
  let sessionLines: LedgerSessionLine[];
  try {
    sessionLines = await readLedgerSessionJsonlLines(input.session.path);
  } catch (error) {
    if (error instanceof TicketProvenanceInputError) throw error;
    const code = errnoCode(error);
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      const detail = error instanceof Error ? error.message : String(error);
      throw new TicketProvenanceInputError(
        `session unreadable: ${input.session.path} (${detail})`,
        { cause: error },
      );
    }
    throw error;
  }

  const rows = sessionLines.map((entry) => entry.row);
  const dialogue = adaptSessionDialogue(rows);
  const sourceFacts = stableSourceFacts(sessionLines);
  const entries: (TicketProvenanceLine | TicketProvenanceRaw)[] = [];
  const ranges = normalizeResolvedRanges(
    input.session.ranges,
    sessionLines,
    input.session.path,
  );
  for (const range of ranges) {
    for (let index = range.fromIndex; index <= range.toIndex; index += 1) {
      const { position: sourcePosition, identity: sourceIdentity } = sourceFacts[index]!;
      const entry = sessionLines[index]!;
      if (entry.row === undefined) {
        entries.push({ raw: entry.raw, s: input.s, sourcePosition, sourceIdentity });
        continue;
      }
      for (const event of dialogue[index] ?? []) {
        entries.push({
          speaker: event.speaker,
          s: input.s,
          sourcePosition,
          ...(event.id === undefined ? { sourceIdentity } : { id: event.id }),
          text: event.text,
        });
      }
    }
  }
  return { entries };
}

/**
 * Project every submitted boundary before appending any ticket's record.
 * #1090: 纯追加——不回读已成录历史查重、不折叠、不刷新；同一区间再次提交也留下新的追加记录。
 * 证不出的 body 原字节原样留卷。
 */
export async function reprojectTicketProvenanceBatch(input: {
  readonly cwd: string;
  readonly home?: string;
  readonly runDirectory?: string;
  readonly tickets: readonly {
    readonly ticketNumber: number | null;
    readonly sessions: readonly TicketProvenanceSession[];
  }[];
}): Promise<void> {
  const projections = [];
  for (const ticket of input.tickets) {
    const recordInput = ticketProvenanceRecordInput(
      ticket.ticketNumber, input.cwd, input.home, input.runDirectory,
    );
    const entries: (TicketProvenanceLine | TicketProvenanceRaw)[] = [];
    for (let s = 0; s < ticket.sessions.length; s += 1) {
      const projected = await projectSessionRanges({
        s,
        session: ticket.sessions[s]!,
        ...(input.home === undefined ? {} : { home: input.home }),
      });
      entries.push(...projected.entries);
    }
    projections.push({ ticket, recordInput, entries });
  }

  for (const { ticket, recordInput, entries } of projections) {
    if (ticket.sessions.length === 0) continue;
    appendSitianRecord({
      ...recordInput,
      payload: {
        type: "ticket-provenance-append",
        sessions: ticket.sessions,
        lines: entries,
      },
    });
  }
}
