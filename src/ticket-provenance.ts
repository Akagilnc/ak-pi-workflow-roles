/**
 * 起居录 volume helpers — ADR 0075「2026-09-14 修订」/ #901。
 * 一册＝一个文件：首行册子头，其后裸对话行。每轮按当前区间重投影是唯一机制；
 * 无 append 水位、无 SitianRecord 外壳。目的地解析与读写经司天台唯一入口
 * （ADR 0065 records-owner / record-entry；ADR 0081 入录经司天台）。
 */
import { join, resolve } from "node:path";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
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
  ensureSitianVolume,
  readSitianVolumeText,
  resolveSitianVolume,
  rewriteSitianVolume,
  type SitianRecordInput,
} from "./sitian-facade.ts";
import {
  TICKET_PROVENANCE_KIND,
  projectTicketProvenanceHeader,
  projectTicketProvenanceLine,
  type TicketProvenanceAmendment,
  type TicketProvenanceBound,
  type TicketProvenanceHeader,
  type TicketProvenanceLine,
  type TicketProvenanceRange,
  type TicketProvenanceSession,
} from "./ticket-provenance-contracts.ts";

/**
 * Authorized dialogue session source roots (ADR 0038 / ADR 0081 cross-host).
 * Derived from the operator machine home + sitian topology — not Claude-only,
 * not free-text path allowlists.
 */
export function dialogueSessionSourceRoots(home?: string): readonly string[] {
  const machineHome =
    typeof home === "string" && home.trim() !== "" ? home : packageMachineHome();
  return [
    join(machineHome, ".claude", "projects"),
    join(machineHome, ".codex", "sessions"),
    join(machineHome, ".pi"),
    resolveActivationLedgerHome(machineHome),
  ];
}

/** Real I/O seam gate: model-selected path must sit under a live host/sitian root. */
function assertDialogueSessionSourcePath(path: string, home?: string): void {
  const absolute = resolve(path);
  for (const root of dialogueSessionSourceRoots(home)) {
    if (physicallyContainedIn(root, absolute)) return;
  }
  throw new Error(
    `session unreadable: ${path} (outside authorized source roots)`,
  );
}

/** Subject string for ticket-keyed volumes — history follows the ticket. */
export function ticketProvenanceSubject(ticketNumber: number): string {
  if (!isSafePositiveTicketNumber(ticketNumber)) {
    throw new Error(
      `ticket-provenance subject requires a positive ticket number, got ${String(ticketNumber)}`,
    );
  }
  return String(ticketNumber);
}

/** Topology input only — no destination parameter (ADR 0065 record-entry). */
function ticketProvenanceRecordInput(
  ticketNumber: number,
  cwd: string,
  home?: string,
): SitianRecordInput {
  return {
    level: "event",
    kind: TICKET_PROVENANCE_KIND,
    subject: ticketProvenanceSubject(ticketNumber),
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
  return resolveSitianVolume(ticketProvenanceRecordInput(ticketNumber, cwd, home));
}

export type ReadTicketProvenanceResult = {
  readonly header: TicketProvenanceHeader | undefined;
  readonly lines: readonly TicketProvenanceLine[];
  readonly recordFile: string;
};

/** Read the unique diary file (empty/absent → no header, no lines). */
export async function readTicketProvenance(
  ticketNumber: number,
  cwd: string,
  home?: string,
): Promise<ReadTicketProvenanceResult> {
  const { recordFile, text } = await readSitianVolumeText(
    ticketProvenanceRecordInput(ticketNumber, cwd, home),
  );
  if (text === undefined) {
    return { header: undefined, lines: [], recordFile };
  }
  const physical = text.split("\n");
  let header: TicketProvenanceHeader | undefined;
  const lines: TicketProvenanceLine[] = [];
  let sawFirst = false;
  for (let index = 0; index < physical.length; index += 1) {
    const raw = physical[index]!;
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Stock / damaged rows stay unprojected — no backfill, no guess.
      continue;
    }
    if (!sawFirst) {
      sawFirst = true;
      header = projectTicketProvenanceHeader(parsed);
      // First line that is not a header is treated as a body line (stock shapes).
      if (header !== undefined) continue;
    }
    const line = projectTicketProvenanceLine(parsed);
    if (line !== undefined) lines.push(line);
  }
  return { header, lines, recordFile };
}

/**
 * Ensure the per-ticket directory + volume file exist (ADR 0075 ticket-provenance-file).
 * Empty file is lawful (bound court with no dialogue yet). Does not forge entries.
 */
export function ensureTicketProvenanceVolume(
  ticketNumber: number,
  cwd: string,
  home?: string,
): TicketProvenanceVolumePath {
  return ensureSitianVolume(ticketProvenanceRecordInput(ticketNumber, cwd, home));
}

/** One session line the mechanical projector could not enter. */
export type UnparsableSessionLine = {
  readonly s: number;
  readonly line: number;
  readonly raw: string;
};

export type ReprojectTicketProvenanceResult = {
  readonly recordFile: string;
  readonly header: TicketProvenanceHeader;
  readonly lines: readonly TicketProvenanceLine[];
  /** Still-open gaps after applying the submitted amendment set. */
  readonly unparsable: readonly UnparsableSessionLine[];
};

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

function amendmentKey(s: number, line: number): string {
  return `${s}:${line}`;
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
      throw new Error(
        `bound endpoint not found in ${sessionPath} (from=${JSON.stringify(range.from)} to=${JSON.stringify(range.to)})`,
      );
    }
    if (fromIndex > toIndex) {
      throw new Error(
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
  readonly amendmentsByKey: ReadonlyMap<string, TicketProvenanceAmendment>;
  readonly seenIds: Set<string>;
  readonly home?: string;
}): Promise<{
  readonly lines: TicketProvenanceLine[];
  readonly unparsable: UnparsableSessionLine[];
}> {
  assertDialogueSessionSourcePath(input.session.path, input.home);
  let sessionLines: LedgerSessionLine[];
  try {
    sessionLines = await readLedgerSessionJsonlLines(input.session.path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`session unreadable: ${input.session.path} (${detail})`);
  }

  const rows = sessionLines.map((entry) => entry.row);
  const dialogue = adaptSessionDialogue(rows);
  const seenIds = input.seenIds;
  const lines: TicketProvenanceLine[] = [];
  const unparsable: UnparsableSessionLine[] = [];
  const ranges = normalizeResolvedRanges(
    input.session.ranges,
    sessionLines,
    input.session.path,
  );

  for (const range of ranges) {
    for (let index = range.fromIndex; index <= range.toIndex; index += 1) {
      const entry = sessionLines[index]!;
      if (entry.row === undefined) {
        const key = amendmentKey(input.s, entry.line);
        const amendment = input.amendmentsByKey.get(key);
        if (amendment !== undefined) {
          lines.push({
            speaker: amendment.speaker,
            s: input.s,
            line: entry.line,
            text: amendment.text,
          });
        } else {
          unparsable.push({ s: input.s, line: entry.line, raw: entry.raw });
        }
        continue;
      }
      for (const event of dialogue[index] ?? []) {
        if (event.id !== undefined) {
          if (seenIds.has(event.id)) continue;
          seenIds.add(event.id);
        }
        lines.push({
          speaker: event.speaker,
          s: input.s,
          line: entry.line,
          ...(event.id === undefined ? {} : { id: event.id }),
          text: event.text,
        });
      }
    }
  }
  return { lines, unparsable };
}

/**
 * Reproject the unique diary file from the submitted bounds + optional amendments.
 * Header + locating fields may change; dialogue text is taken from the source
 * (or from a typed amendment). Does not append; the whole file is the projection.
 * Persistence goes through the Sitian volume seam (rewriteSitianVolume).
 */
export async function reprojectTicketProvenance(input: {
  readonly ticketNumber: number;
  readonly cwd: string;
  readonly home?: string;
  readonly sessions: readonly TicketProvenanceSession[];
  readonly amendments?: readonly TicketProvenanceAmendment[];
}): Promise<ReprojectTicketProvenanceResult> {
  const recordInput = ticketProvenanceRecordInput(
    input.ticketNumber,
    input.cwd,
    input.home,
  );
  const prior = await readTicketProvenance(input.ticketNumber, input.cwd, input.home);

  // Empty selection on an existing volume = no new dialogue this turn: keep the
  // authoritative file untouched (do not publish a header-only wipe).
  if (input.sessions.length === 0 && prior.header !== undefined) {
    return {
      recordFile: prior.recordFile,
      header: prior.header,
      lines: prior.lines,
      unparsable: [],
    };
  }

  const amendmentsByKey = new Map<string, TicketProvenanceAmendment>();
  for (const amendment of input.amendments ?? []) {
    amendmentsByKey.set(amendmentKey(amendment.s, amendment.line), amendment);
  }

  const lines: TicketProvenanceLine[] = [];
  const unparsable: UnparsableSessionLine[] = [];
  // First-seen native id across the whole reproject (rewritten session copies).
  const seenIds = new Set<string>();
  for (let s = 0; s < input.sessions.length; s += 1) {
    const projected = await projectSessionRanges({
      s,
      session: input.sessions[s]!,
      amendmentsByKey,
      seenIds,
      ...(input.home === undefined ? {} : { home: input.home }),
    });
    lines.push(...projected.lines);
    unparsable.push(...projected.unparsable);
  }

  const now = new Date().toISOString();
  const header: TicketProvenanceHeader = {
    repo: resolveBookKeyFromGit(input.cwd),
    ticket: input.ticketNumber,
    createdAt: prior.header?.createdAt ?? now,
    updatedAt: now,
    sessions: input.sessions,
  };

  // Still-open gaps → reask without publishing a partial/rejected projection.
  if (unparsable.length > 0) {
    return {
      recordFile: prior.recordFile,
      header,
      lines,
      unparsable,
    };
  }

  const body = `${[JSON.stringify(header), ...lines.map((line) => JSON.stringify(line))].join("\n")}\n`;
  const volume = await rewriteSitianVolume({ ...recordInput, body });

  return {
    recordFile: volume.recordFile,
    header,
    lines,
    unparsable,
  };
}
