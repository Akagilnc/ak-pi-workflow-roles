/**
 * 起居录 volume helpers — ADR 0075「2026-09-14 修订」/ #901 / #918。
 * 一册＝一个追加式 records.jsonl。每轮新投影经司天台 appender 追加为不可变提交；
 * 读取时折叠全部提交得到累计 sessions 与对话视图。既有首行册子头＋裸对话行的
 * snapshot 继续可读，但后续不为升级回写旧卷。
 */
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  ensureRealDirectoryTree,
  errnoCode,
  packageMachineHome,
  physicalPathIdentity,
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
  appendSitianRecord,
  resolveSitianRecordPath,
  type SitianRecordInput,
} from "./sitian-facade.ts";
import {
  TICKET_PROVENANCE_KIND,
  projectTicketProvenanceHeader,
  projectTicketProvenanceLine,
  projectTicketProvenanceSessions,
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

type TicketProvenanceCommit = {
  readonly timestamp: string;
  readonly sessions: readonly TicketProvenanceSession[];
  readonly lines: readonly (TicketProvenanceLine | TicketProvenanceRaw | string)[];
};

function projectTicketProvenanceRaw(value: unknown): TicketProvenanceRaw | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.raw !== "string" || !Number.isInteger(raw.s) || (raw.s as number) < 0 ||
      !Number.isInteger(raw.sourcePosition) || (raw.sourcePosition as number) < 0) {
    return undefined;
  }
  const sourceIdentity = typeof raw.sourceIdentity === "string" && raw.sourceIdentity !== ""
    ? raw.sourceIdentity
    : undefined;
  return {
    raw: raw.raw,
    s: raw.s as number,
    sourcePosition: raw.sourcePosition as number,
    ...(sourceIdentity === undefined ? {} : { sourceIdentity }),
  };
}

function projectTicketProvenanceCommit(value: unknown): TicketProvenanceCommit | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== TICKET_PROVENANCE_KIND || typeof record.timestamp !== "string") {
    return undefined;
  }
  const payload = record.payload;
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const body = payload as Record<string, unknown>;
  if (body.type !== "ticket-provenance-append") return undefined;
  const sessions = projectTicketProvenanceSessions(body.sessions);
  if (sessions === undefined || !Array.isArray(body.lines)) return undefined;
  const lines: (TicketProvenanceLine | TicketProvenanceRaw | string)[] = [];
  for (const raw of body.lines) {
    if (typeof raw === "string") { lines.push(raw); continue; }
    const line = projectTicketProvenanceLine(raw);
    if (line !== undefined) { lines.push(line); continue; }
    const preserved = projectTicketProvenanceRaw(raw);
    if (preserved === undefined) return undefined;
    lines.push(preserved);
  }
  return { timestamp: record.timestamp, sessions, lines };
}

export type ReadTicketProvenanceResult = {
  readonly header: TicketProvenanceHeader | undefined;
  readonly lines: readonly TicketProvenanceLine[];
  /**
   * Body rows that could not be projected (bad JSON or unusable shape).
   * Kept byte-stable across lawful rewrites — 证不出的原样留存 (#918 / G8).
   */
  readonly unprojectedRaw: readonly string[];
  readonly recordFile: string;
  /** Internal cumulative coverage truth, keyed by normalized session index. */
  readonly sourceIdentities: ReadonlyMap<number, ReadonlySet<string>>;
  /** Upgrade fallback for records written before sourceIdentity existed. */
  readonly legacySourcePositions: ReadonlyMap<number, ReadonlySet<number>>;
};

/** Read the unique diary file (empty/absent → no header, no lines). */
export async function readTicketProvenance(
  ticketNumber: number,
  cwd: string,
  home?: string,
): Promise<ReadTicketProvenanceResult> {
  const { recordFile } = resolveTicketProvenanceVolume(ticketNumber, cwd, home);
  let text: string;
  try {
    text = await readFile(recordFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        header: undefined,
        lines: [],
        unprojectedRaw: [],
        recordFile,
        sourceIdentities: new Map(),
        legacySourcePositions: new Map(),
      };
    }
    throw error;
  }
  const physical = text.split("\n");
  let header: TicketProvenanceHeader | undefined;
  const lines: TicketProvenanceLine[] = [];
  const unprojectedRaw: string[] = [];
  const sourceIdentities = new Map<number, Set<string>>();
  const legacySourcePositions = new Map<number, Set<number>>();
  const rememberIdentity = (s: number, identity: string): boolean => {
    const seen = sourceIdentities.get(s) ?? new Set<string>();
    const fresh = !seen.has(identity);
    seen.add(identity);
    sourceIdentities.set(s, seen);
    return fresh;
  };
  const rememberLegacyPosition = (s: number, position: number): void => {
    const seen = legacySourcePositions.get(s) ?? new Set<number>();
    seen.add(position);
    legacySourcePositions.set(s, seen);
  };
  let sawFirst = false;
  for (let index = 0; index < physical.length; index += 1) {
    const raw = physical[index]!;
    if (!raw.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Stock / damaged rows stay unprojected — keep raw bytes on rewrite.
      unprojectedRaw.push(raw);
      continue;
    }
    if (!sawFirst) {
      sawFirst = true;
      header = projectTicketProvenanceHeader(parsed);
      // Legacy snapshot: first line header followed by bare dialogue rows.
      if (header !== undefined) continue;
    }
    const line = projectTicketProvenanceLine(parsed);
    if (line !== undefined) {
      lines.push(line);
      continue;
    }
    const commit = projectTicketProvenanceCommit(parsed);
    if (commit !== undefined) {
      const merged = mergeSessionBounds(header?.sessions, commit.sessions);
      const remapped: TicketProvenanceLine[] = [];
      for (const entry of commit.lines) {
        if (typeof entry === "string") { unprojectedRaw.push(entry); continue; }
        const s = merged.incomingIndexes[entry.s] ?? entry.s;
        if ("raw" in entry) {
          if (entry.sourceIdentity !== undefined) {
            if (rememberIdentity(s, entry.sourceIdentity)) unprojectedRaw.push(entry.raw);
          } else {
            rememberLegacyPosition(s, entry.sourcePosition);
            unprojectedRaw.push(entry.raw);
          }
          continue;
        }
        remapped.push({ ...entry, s });
        if (entry.id === undefined) {
          if (entry.sourceIdentity !== undefined) rememberIdentity(s, entry.sourceIdentity);
          else if (entry.sourcePosition !== undefined) rememberLegacyPosition(s, entry.sourcePosition);
        }
      }
      const now = commit.timestamp;
      header = {
        repo: header?.repo ?? resolveBookKeyFromGit(cwd),
        ticket: ticketNumber,
        createdAt: header?.createdAt ?? now,
        updatedAt: now,
        sessions: merged.sessions,
      };
      const carried = lines.map((entry) => ({
        ...entry,
        s: merged.priorIndexes[entry.s] ?? entry.s,
      }));
      lines.splice(0, lines.length, ...mergeFreshIntoCarried(carried, remapped));
      continue;
    }
    // Unknown stock / damaged rows remain readable and are never upgraded in place.
    unprojectedRaw.push(raw);
  }
  for (const line of lines) {
    if (line.id !== undefined) continue;
    if (line.sourceIdentity !== undefined) rememberIdentity(line.s, line.sourceIdentity);
    else if (line.sourcePosition !== undefined) rememberLegacyPosition(line.s, line.sourcePosition);
  }
  return {
    header,
    lines,
    unprojectedRaw,
    recordFile,
    sourceIdentities,
    legacySourcePositions,
  };
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
  const input = ticketProvenanceRecordInput(ticketNumber, cwd, home);
  const path = resolveSitianRecordPath(input);
  ensureRealDirectoryTree(path.ledgerHome, path.sessionDir);
  appendFileSync(path.recordFile, "", "utf8");
  return { recordFile: path.recordFile, volumeDir: path.sessionDir };
}

export type ReprojectTicketProvenanceResult = {
  readonly recordFile: string;
  readonly header: TicketProvenanceHeader;
  readonly lines: readonly TicketProvenanceLine[];
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

/** Exact range identity for cumulative header dedupe (idempotent resubmit). */
function dialogueIdentity(s: number, id: string): string {
  return `${s}\u0000${id}`;
}

function rangeDeclarationKey(range: TicketProvenanceRange): string {
  return JSON.stringify({
    from: range.from,
    to: range.to,
  });
}

/**
 * #918 甲案：prior ranges ∪ 本轮 ranges。按 path 合并；先保 prior 序，再追加新 path。
 * path identity 与 I/O 接缝同用 `physicalPathIdentity`（symlink-stable），故
 * `p` / `p/./` / 经 symlink 祖先的别名合为一条；保留首见 path 字面与累计 ranges。
 * 即使 prior 缺失 / sessions=[]，incoming 自身也必须按 identity 归并——首轮同一
 * 物理卷不得铸出多个 s（#918 C5）。遗漏不代表删除。
 */
function mergeSessionBounds(
  prior: readonly TicketProvenanceSession[] | undefined,
  incoming: readonly TicketProvenanceSession[],
): {
  readonly sessions: readonly TicketProvenanceSession[];
  readonly priorIndexes: readonly number[];
  readonly incomingIndexes: readonly number[];
} {
  const merged: { path: string; ranges: TicketProvenanceRange[] }[] = [];
  const indexByIdentity = new Map<string, number>();

  const absorb = (sessions: readonly TicketProvenanceSession[]): number[] => {
    const indexes: number[] = [];
    for (const session of sessions) {
      const identity = physicalPathIdentity(session.path);
      let targetIndex = indexByIdentity.get(identity);
      if (targetIndex === undefined) {
        targetIndex = merged.length;
        indexByIdentity.set(identity, targetIndex);
        merged.push({ path: session.path, ranges: [] });
      }
      indexes.push(targetIndex);
      const target = merged[targetIndex]!;
      const seen = new Set(target.ranges.map(rangeDeclarationKey));
      for (const range of session.ranges) {
        const key = rangeDeclarationKey(range);
        if (seen.has(key)) continue;
        seen.add(key);
        target.ranges.push({ from: { ...range.from }, to: { ...range.to } });
      }
    }
    return indexes;
  };

  const priorIndexes = absorb(prior ?? []);
  const incomingIndexes = absorb(incoming);
  return { sessions: merged, priorIndexes, incomingIndexes };
}

/**
 * #918 第一节：已投影行即卷宗。只对 prior 未声明的 range（按 path identity + 精确
 * from/to）读源；已声明的投影原样结转，不重读历史源。
 */
function undeclaredSessionRanges(
  prior: readonly TicketProvenanceSession[] | undefined,
  merged: readonly TicketProvenanceSession[],
): readonly {
  readonly s: number;
  readonly session: TicketProvenanceSession;
}[] {
  const priorKeys = new Map<string, Set<string>>();
  for (const session of prior ?? []) {
    const identity = physicalPathIdentity(session.path);
    let keys = priorKeys.get(identity);
    if (keys === undefined) {
      keys = new Set();
      priorKeys.set(identity, keys);
    }
    for (const range of session.ranges) keys.add(rangeDeclarationKey(range));
  }
  const out: {
    s: number;
    session: TicketProvenanceSession;
  }[] = [];
  for (let s = 0; s < merged.length; s += 1) {
    const session = merged[s]!;
    const identity = physicalPathIdentity(session.path);
    const declared = priorKeys.get(identity) ?? new Set();
    const fresh = session.ranges.filter(
      (range) => !declared.has(rangeDeclarationKey(range)),
    );
    if (fresh.length === 0) continue;
    out.push({
      s,
      session: {
        path: session.path,
        ranges: fresh.map((range) => ({
          from: { ...range.from },
          to: { ...range.to },
        })),
      },
    });
  }
  return out;
}

/**
 * Merge newly projected rows into the carried archive.
 * Native id remains the typed first-seen identity; exact range resubmission is a no-op.
 */
function mergeFreshIntoCarried(
  carried: readonly TicketProvenanceLine[],
  fresh: readonly TicketProvenanceLine[],
): TicketProvenanceLine[] {
  const seenSources = new Map<string, TicketProvenanceLine>();
  const bySession = new Map<number, TicketProvenanceLine[]>();
  const absorb = (lines: readonly TicketProvenanceLine[]): void => {
    for (const line of lines) {
      const sourceIdentity = line.id === undefined
        ? line.sourceIdentity
        : `id\u0000${line.id}`;
      const identity = sourceIdentity === undefined
        ? undefined
        : `${line.s}\u0000${sourceIdentity}`;
      const seen = identity === undefined ? undefined : seenSources.get(identity);
      if (seen !== undefined) {
        if (line.sourcePosition !== undefined) {
          Object.assign(seen, { sourcePosition: line.sourcePosition });
        }
        continue;
      }
      const bucket = bySession.get(line.s) ?? [];
      bucket.push({ ...line });
      if (identity !== undefined) seenSources.set(identity, bucket.at(-1)!);
      bySession.set(line.s, bucket);
    }
  };
  absorb(carried);
  absorb(fresh);
  return [...bySession.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, lines]) => lines
      .map((line, archiveIndex) => ({ line, archiveIndex }))
      .sort((left, right) => {
        const leftPosition = left.line.sourcePosition;
        const rightPosition = right.line.sourcePosition;
        if (leftPosition === undefined && rightPosition === undefined) {
          return left.archiveIndex - right.archiveIndex;
        }
        if (leftPosition === undefined) return 1;
        if (rightPosition === undefined) return -1;
        return leftPosition - rightPosition || left.archiveIndex - right.archiveIndex;
      })
      .map(({ line }) => line));
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
  readonly seenIds: Set<string>;
  readonly coveredSourceIdentities: ReadonlySet<string>;
  readonly legacyCoveredSourcePositions: ReadonlySet<number>;
  readonly home?: string;
}): Promise<{
  readonly lines: TicketProvenanceLine[];
  readonly raw: TicketProvenanceRaw[];
  readonly sourcePositionByIdentity: ReadonlyMap<string, number>;
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
  const sourceFacts = stableSourceFacts(sessionLines);
  const sourcePositionByIdentity = new Map<string, number>();
  for (const fact of sourceFacts) {
    sourcePositionByIdentity.set(fact.identity, fact.position);
  }
  const seenIds = input.seenIds;
  const lines: TicketProvenanceLine[] = [];
  const raw: TicketProvenanceRaw[] = [];
  const ranges = normalizeResolvedRanges(
    input.session.ranges,
    sessionLines,
    input.session.path,
  );
  for (const range of ranges) {
    for (let index = range.fromIndex; index <= range.toIndex; index += 1) {
      const { position: sourcePosition, identity: sourceIdentity } = sourceFacts[index]!;
      if (input.coveredSourceIdentities.has(sourceIdentity) ||
          input.legacyCoveredSourcePositions.has(sourcePosition)) continue;
      const entry = sessionLines[index]!;
      if (entry.row === undefined) {
        raw.push({ raw: entry.raw, s: input.s, sourcePosition, sourceIdentity });
        continue;
      }
      for (const event of dialogue[index] ?? []) {
        if (event.id !== undefined) {
          const identity = dialogueIdentity(input.s, event.id);
          if (seenIds.has(identity)) continue;
          seenIds.add(identity);
        }
        lines.push({
          speaker: event.speaker,
          s: input.s,
          sourcePosition,
          ...(event.id === undefined ? { sourceIdentity } : { id: event.id }),
          text: event.text,
        });
      }
    }
  }
  return { lines, raw, sourcePositionByIdentity };
}

/**
 * Reproject the unique diary from cumulative bounds.
 * #918：已投影行即卷宗；本轮只读 prior 未声明的 range（或新 session 区间）。
 * 精确重复提交＝幂等 no-op，不因历史源不可读而失败；空 sessions 保持 no-op。
 * 证不出的 body 原字节经 unprojectedRaw 原样留存。
 * Persistence appends one immutable commit through the Sitian appender seam.
 */
export async function reprojectTicketProvenance(input: {
  readonly ticketNumber: number;
  readonly cwd: string;
  readonly home?: string;
  readonly sessions: readonly TicketProvenanceSession[];
}): Promise<ReprojectTicketProvenanceResult> {
  const prior = await readTicketProvenance(input.ticketNumber, input.cwd, input.home);
  if (input.sessions.length === 0) {
    const now = new Date().toISOString();
    return {
      recordFile: prior.recordFile,
      header: prior.header ?? {
        repo: resolveBookKeyFromGit(input.cwd),
        ticket: input.ticketNumber,
        createdAt: now,
        updatedAt: now,
        sessions: [],
      },
      lines: prior.lines,
    };
  }

  const merged = mergeSessionBounds(prior.header?.sessions, input.sessions);
  const deltas = undeclaredSessionRanges(prior.header?.sessions, merged.sessions);
  if (deltas.length === 0) {
    const now = new Date().toISOString();
    return {
      recordFile: prior.recordFile,
      header: prior.header ?? {
        repo: resolveBookKeyFromGit(input.cwd),
        ticket: input.ticketNumber,
        createdAt: now,
        updatedAt: now,
        sessions: merged.sessions,
      },
      lines: prior.lines,
    };
  }

  const seenIds = new Set(
    prior.lines.flatMap((line) =>
      line.id === undefined ? [] : [dialogueIdentity(line.s, line.id)]
    ),
  );
  const fresh: TicketProvenanceLine[] = [];
  const raw: TicketProvenanceRaw[] = [];
  for (const delta of deltas) {
    const projected = await projectSessionRanges({
      s: delta.s,
      session: delta.session,
      seenIds,
      coveredSourceIdentities: prior.sourceIdentities.get(delta.s) ?? new Set(),
      legacyCoveredSourcePositions: prior.legacySourcePositions.get(delta.s) ?? new Set(),
      ...(input.home === undefined ? {} : { home: input.home }),
    });
    fresh.push(...prior.lines.flatMap((line) => {
      if (line.s !== delta.s) return [];
      const sourceIdentity = line.id === undefined
        ? line.sourceIdentity
        : `id\u0000${line.id}`;
      if (sourceIdentity === undefined) return [];
      const sourcePosition = projected.sourcePositionByIdentity.get(sourceIdentity);
      return sourcePosition === undefined ? [] : [{ ...line, sourcePosition }];
    }));
    fresh.push(...projected.lines);
    raw.push(...projected.raw);
  }
  const lines = mergeFreshIntoCarried(prior.lines, fresh);
  const now = new Date().toISOString();
  const header: TicketProvenanceHeader = {
    repo: prior.header?.repo ?? resolveBookKeyFromGit(input.cwd),
    ticket: input.ticketNumber,
    createdAt: prior.header?.createdAt ?? now,
    updatedAt: now,
    sessions: merged.sessions,
  };
  // One immutable projection commit. Its deterministic identity makes retries of
  // the same logical increment converge, while unrelated concurrent increments
  // append independently and are folded by readTicketProvenance.
  const identityMaterial = JSON.stringify({
    ticket: input.ticketNumber,
    deltas: deltas.map(({ s, session }) => ({
      s,
      path: physicalPathIdentity(session.path),
      ranges: session.ranges,
    })),
    lines: [...fresh, ...raw],
  });
  const identity = `ticket-provenance:${createHash("sha256").update(identityMaterial).digest("hex")}`;
  const pointer = appendSitianRecord({
    ...ticketProvenanceRecordInput(input.ticketNumber, input.cwd, input.home),
    identity,
    payload: {
      type: "ticket-provenance-append",
      sessions: merged.sessions,
      lines: [...fresh, ...raw],
    },
  });
  const folded = await readTicketProvenance(input.ticketNumber, input.cwd, input.home);
  return {
    recordFile: pointer.recordFile,
    header: folded.header ?? header,
    lines: folded.lines,
  };
}
