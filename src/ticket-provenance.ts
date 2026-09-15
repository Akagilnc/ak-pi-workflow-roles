/**
 * 起居录 volume helpers — ADR 0075「2026-09-14 修订」/ #901 / #918。
 * 一册＝一个文件：首行册子头，其后裸对话行。每轮按册子头累计区间重投影是唯一机制
 * （#918 甲案：prior ∪ 本轮，遗漏不删除）；无 append 水位、无 SitianRecord 外壳。
 * 目的地解析与读写经司天台唯一入口
 * （ADR 0065 records-owner / record-entry；ADR 0081 入录经司天台）。
 */
import { basename, dirname, join, resolve } from "node:path";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
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
export function dialogueSessionSourceRoots(home?: string): readonly string[] {
  const machineHome =
    typeof home === "string" && home.trim() !== "" ? home : packageMachineHome();
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
    typeof home === "string" && home.trim() !== "" ? home : packageMachineHome();
  const ledgerHome = resolveActivationLedgerHome(machineHome);
  if (!physicallyContainedIn(ledgerHome, absolute)) return false;
  return basename(absolute) === "session.jsonl" && basename(dirname(absolute)) === "session";
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

/** Exact range identity for cumulative header dedupe (idempotent resubmit). */
function rangeDeclarationKey(range: TicketProvenanceRange): string {
  return JSON.stringify({
    from: range.from,
    to: range.to,
  });
}

/**
 * #918 甲案：prior ranges ∪ 本轮 ranges。按 path 合并；先保 prior 序，再追加新 path。
 * path identity 与 I/O 接缝同用 lexical `resolve(path)`，故 `p` 与 `p/./` 合为一条；
 * 保留首见 path 字面与累计 ranges。遗漏不代表删除。
 * 交卷 sessions 仍是「本轮边界」输入；本函数是机械合并，不改角色交什么。
 */
function mergeSessionBounds(
  prior: readonly TicketProvenanceSession[] | undefined,
  incoming: readonly TicketProvenanceSession[],
): readonly TicketProvenanceSession[] {
  if (prior === undefined || prior.length === 0) return incoming;
  if (incoming.length === 0) return prior;

  const merged: { path: string; ranges: TicketProvenanceRange[] }[] = prior.map(
    (session) => ({
      path: session.path,
      ranges: session.ranges.map((range) => ({
        from: { ...range.from },
        to: { ...range.to },
      })),
    }),
  );
  const indexByIdentity = new Map<string, number>();
  for (let index = 0; index < merged.length; index += 1) {
    indexByIdentity.set(resolve(merged[index]!.path), index);
  }

  for (const session of incoming) {
    const identity = resolve(session.path);
    const existingIndex = indexByIdentity.get(identity);
    if (existingIndex === undefined) {
      indexByIdentity.set(identity, merged.length);
      merged.push({
        path: session.path,
        ranges: session.ranges.map((range) => ({
          from: { ...range.from },
          to: { ...range.to },
        })),
      });
      continue;
    }
    const target = merged[existingIndex]!;
    const seen = new Set(target.ranges.map(rangeDeclarationKey));
    for (const range of session.ranges) {
      const key = rangeDeclarationKey(range);
      if (seen.has(key)) continue;
      seen.add(key);
      target.ranges.push({
        from: { ...range.from },
        to: { ...range.to },
      });
    }
  }
  return merged;
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
    if (error instanceof TicketProvenanceInputError) throw error;
    // Only absence/path-shape misses are model input errors → reask.
    // EISDIR = authorized-root path that is a directory, not a session file.
    // EIO / EMFILE / EACCES / other runtime faults keep native identity + cause.
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
 * Reproject the unique diary file from cumulative bounds + optional amendments.
 * #918 甲案：prior header ranges ∪ 本轮 sessions 取并集后整卷重投影；遗漏不删除。
 * Header + locating fields may change; dialogue text is taken from the source
 * (or from a typed amendment). The whole file is still the projection (not an
 * append log) — the projection *source* is the cumulative union, not this round alone.
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
  const priorRaw = await readSitianVolumeText(recordInput);
  const priorNonEmpty =
    priorRaw.text !== undefined && priorRaw.text.trim() !== "";

  const amendments = input.amendments ?? [];
  // Empty sessions: pure empty selection preserves non-empty volume. Amendments-only
  // continuation reuses prior header sessions — never wash into accepted no-op.
  let sessions: readonly TicketProvenanceSession[];
  if (input.sessions.length === 0) {
    if (amendments.length > 0) {
      const priorSessions = prior.header?.sessions;
      if (priorSessions === undefined || priorSessions.length === 0) {
        throw new TicketProvenanceInputError(
          "amendments require sessions bounds (none submitted and no prior header sessions)",
        );
      }
      sessions = priorSessions;
    } else if (priorNonEmpty) {
      const now = new Date().toISOString();
      const header: TicketProvenanceHeader =
        prior.header ??
        ({
          repo: resolveBookKeyFromGit(input.cwd),
          ticket: input.ticketNumber,
          createdAt: now,
          updatedAt: now,
          sessions: [],
        } satisfies TicketProvenanceHeader);
      return {
        recordFile: prior.recordFile,
        header,
        lines: prior.lines,
        unparsable: [],
      };
    } else {
      sessions = input.sessions;
    }
  } else {
    // Non-empty 本轮边界 ∪ prior：遗漏永不删除（#918 甲案）。
    sessions = mergeSessionBounds(prior.header?.sessions, input.sessions);
  }

  const amendmentsByKey = new Map<string, TicketProvenanceAmendment>();
  for (const amendment of amendments) {
    amendmentsByKey.set(amendmentKey(amendment.s, amendment.line), amendment);
  }

  const lines: TicketProvenanceLine[] = [];
  const unparsable: UnparsableSessionLine[] = [];
  // First-seen native id across the whole reproject (rewritten session copies).
  const seenIds = new Set<string>();
  for (let s = 0; s < sessions.length; s += 1) {
    const projected = await projectSessionRanges({
      s,
      session: sessions[s]!,
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
    sessions,
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
