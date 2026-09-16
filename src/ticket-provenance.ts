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

type TicketProvenanceCommit = {
  readonly timestamp: string;
  readonly sessions: readonly TicketProvenanceSession[];
  readonly lines: readonly (TicketProvenanceLine | string)[];
};

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
  const lines: (TicketProvenanceLine | string)[] = [];
  for (const raw of body.lines) {
    if (typeof raw === "string") { lines.push(raw); continue; }
    const line = projectTicketProvenanceLine(raw);
    if (line === undefined) return undefined;
    lines.push(line);
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
      return { header: undefined, lines: [], unprojectedRaw: [], recordFile };
    }
    throw error;
  }
  const physical = text.split("\n");
  let header: TicketProvenanceHeader | undefined;
  const lines: TicketProvenanceLine[] = [];
  const unprojectedRaw: string[] = [];
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
        remapped.push({ ...entry, s: merged.incomingIndexes[entry.s] ?? entry.s });
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
  return { header, lines, unprojectedRaw, recordFile };
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
  readonly priorRanges: readonly TicketProvenanceRange[];
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
  const priorRanges = new Map<string, readonly TicketProvenanceRange[]>();
  for (const session of prior ?? []) {
    priorRanges.set(physicalPathIdentity(session.path), session.ranges);
  }
  const out: {
    s: number;
    session: TicketProvenanceSession;
    priorRanges: readonly TicketProvenanceRange[];
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
      priorRanges: priorRanges.get(identity) ?? [],
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
  const seenIds = new Set<string>();
  const bySession = new Map<number, TicketProvenanceLine[]>();
  const absorb = (lines: readonly TicketProvenanceLine[]): void => {
    for (const line of lines) {
      if (line.id !== undefined) {
        const identity = dialogueIdentity(line.s, line.id);
        if (seenIds.has(identity)) continue;
        seenIds.add(identity);
      }
      const bucket = bySession.get(line.s) ?? [];
      bucket.push(line);
      bySession.set(line.s, bucket);
    }
  };
  absorb(carried);
  absorb(fresh);
  return [...bySession.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, lines]) => lines);
}

/**
 * Resolve submitted ranges against the session, then sort by source position and
 * merge overlaps so each physical row is visited once (#901 source order).
 */
function normalizeResolvedRanges(
  ranges: readonly TicketProvenanceRange[],
  sessionLines: readonly LedgerSessionLine[],
  sessionPath: string,
  skipMissing = false,
): readonly { readonly fromIndex: number; readonly toIndex: number }[] {
  const resolved: { fromIndex: number; toIndex: number }[] = [];
  for (const range of ranges) {
    const fromIndex = resolveBoundIndex(range.from, sessionLines);
    const toIndex = resolveBoundIndex(range.to, sessionLines);
    if (fromIndex === undefined || toIndex === undefined) {
      if (skipMissing) continue;
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
  readonly priorRanges?: readonly TicketProvenanceRange[];
  readonly home?: string;
}): Promise<{
  readonly lines: TicketProvenanceLine[];
  readonly raw: string[];
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
  const raw: string[] = [];
  const ranges = normalizeResolvedRanges(
    input.session.ranges,
    sessionLines,
    input.session.path,
  );
  const covered = normalizeResolvedRanges(
    input.priorRanges ?? [],
    sessionLines,
    input.session.path,
    true,
  );
  const uncovered = ranges.flatMap((range) => {
    let fragments = [range];
    for (const prior of covered) {
      fragments = fragments.flatMap((fragment) => {
        if (prior.toIndex < fragment.fromIndex || prior.fromIndex > fragment.toIndex) {
          return [fragment];
        }
        const remainder: { fromIndex: number; toIndex: number }[] = [];
        if (fragment.fromIndex < prior.fromIndex) {
          remainder.push({ fromIndex: fragment.fromIndex, toIndex: prior.fromIndex - 1 });
        }
        if (fragment.toIndex > prior.toIndex) {
          remainder.push({ fromIndex: prior.toIndex + 1, toIndex: fragment.toIndex });
        }
        return remainder;
      });
    }
    return fragments;
  });

  for (const range of uncovered) {
    for (let index = range.fromIndex; index <= range.toIndex; index += 1) {
      const entry = sessionLines[index]!;
      if (entry.row === undefined) {
        raw.push(entry.raw);
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
          ...(event.id === undefined ? {} : { id: event.id }),
          text: event.text,
        });
      }
    }
  }
  return { lines, raw };
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
  const raw: string[] = [];
  for (const delta of deltas) {
    const projected = await projectSessionRanges({
      s: delta.s,
      session: delta.session,
      seenIds,
      priorRanges: delta.priorRanges,
      ...(input.home === undefined ? {} : { home: input.home }),
    });
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
