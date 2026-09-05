/**
 * Canonical ledger session JSONL read primitives (shared owner).
 * Consumers (ticket-trajectory, analyst, …) must import here — no second parse kernel.
 */
import { readFile } from "node:fs/promises";

export type LedgerSessionRow = Record<string, unknown>;

/**
 * Loud JSONL failure that still retains rows parsed before the bad line.
 * Callers that only need the throw keep catching Error; owners that must
 * surface partial typed facts (e.g. first-frame timestamp) read prefixRows.
 */
export class LedgerSessionJsonlError extends Error {
  readonly path: string;
  readonly line: number;
  readonly prefixRows: readonly LedgerSessionRow[];

  constructor(
    message: string,
    init: {
      readonly path: string;
      readonly line: number;
      readonly prefixRows: readonly LedgerSessionRow[];
    },
  ) {
    super(message);
    this.name = "LedgerSessionJsonlError";
    this.path = init.path;
    this.line = init.line;
    this.prefixRows = init.prefixRows;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read session JSONL with honest live-tail semantics:
 * a malformed line is tolerated only when it is an unfinished final
 * fragment at EOF (no record terminator after it). Any malformed line
 * completed by a line terminator must fail loudly with file and 1-based
 * line context — even when no non-empty record follows — never silently
 * under-count.
 *
 * Loud failures throw LedgerSessionJsonlError carrying prefixRows so the
 * single parse kernel can still expose facts obtained before the bad line.
 */
export async function readLedgerSessionJsonl(path: string): Promise<LedgerSessionRow[]> {
  const text = await readFile(path, "utf8");
  // split keeps a trailing empty segment iff text ends with "\n", so
  // index < lines.length - 1 means this segment was terminated.
  const lines = text.split("\n");
  const rows: LedgerSessionRow[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      const completedByTerminator = index < lines.length - 1;
      if (completedByTerminator) {
        throw new LedgerSessionJsonlError(
          `malformed JSONL record in ${path} at line ${index + 1}: ${error.message}`,
          { path, line: index + 1, prefixRows: rows },
        );
      }
      // unfinished fragment at EOF — keep prior complete rows
      break;
    }
    // Syntactically complete line: must be a session object. Silent omission
    // would under-count ledger evidence (failure honesty).
    if (!isRecord(row)) {
      const kind = row === null ? "null" : Array.isArray(row) ? "array" : typeof row;
      throw new LedgerSessionJsonlError(
        `complete non-object JSONL record in ${path} at line ${index + 1}: expected object, got ${kind}`,
        { path, line: index + 1, prefixRows: rows },
      );
    }
    rows.push(row);
  }
  return rows;
}

/** First and last record timestamps in encounter order. */
export function extractSessionTimestampSpan(
  rows: readonly LedgerSessionRow[],
): { startedAt?: string; endedAt?: string } {
  let startedAt: string | undefined;
  let endedAt: string | undefined;
  for (const row of rows) {
    if (typeof row.timestamp !== "string" || !row.timestamp) continue;
    if (startedAt === undefined) startedAt = row.timestamp;
    endedAt = row.timestamp;
  }
  return {
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
  };
}

/**
 * Ordered-unique model ids from session frames (first-seen order).
 * Sources (same faces ticket-trajectory already reads — single parse kernel):
 * - `model_change.modelId`
 * - assistant `message.model`
 * Blank / non-string values are skipped. Does not invent a default model.
 */
export function extractSessionModelSequence(
  rows: readonly LedgerSessionRow[],
): string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  const push = (raw: string): void => {
    const model = raw.trim();
    if (model === "" || seen.has(model)) return;
    seen.add(model);
    ordered.push(model);
  };
  for (const row of rows) {
    if (row.type === "model_change" && typeof row.modelId === "string") {
      push(row.modelId);
    }
    const message = isRecord(row.message) ? row.message : undefined;
    if (message?.role === "assistant" && typeof message.model === "string") {
      push(message.model);
    }
  }
  return ordered;
}

/** First line of a bash `command` argument (sole owner of this summary). */
export function bashCommandFirstLine(command: string): string {
  const match = /^[^\r\n]*/.exec(command);
  return match?.[0] ?? "";
}

export type SessionToolInterval = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  /**
   * Bash-only first-line command summary from `arguments.command`.
   * Omitted for non-bash tools and when the argument is absent/non-string.
   * Full multi-line bodies are never retained on this typed fact face.
   */
  readonly command?: string;
};

/**
 * Pair toolCall frames → toolResult frames by toolCallId.
 * Throws when a tool-bearing frame is structurally unreadable for association
 * (toolCall missing string id, toolResult missing string toolCallId).
 * Unpaired open calls remain without endedAt — that is incomplete, not unreadable.
 */
export function extractSessionToolIntervals(
  rows: readonly LedgerSessionRow[],
): SessionToolInterval[] {
  type Open = {
    toolCallId: string;
    toolName: string;
    startedAt: string;
    endedAt?: string;
    command?: string;
  };
  const order: Open[] = [];
  const openById = new Map<string, Open>();

  for (const row of rows) {
    const rowTimestamp = typeof row.timestamp === "string" ? row.timestamp : undefined;
    const message = isRecord(row.message) ? row.message : undefined;

    if (message?.role === "assistant" && Array.isArray(message.content)) {
      const callTimestamp =
        typeof message.timestamp === "string" && message.timestamp
          ? message.timestamp
          : rowTimestamp;
      for (const part of message.content) {
        if (!isRecord(part) || part.type !== "toolCall") continue;
        if (typeof part.id !== "string" || part.id.length === 0) {
          throw new Error("toolCall frame missing string id");
        }
        if (typeof part.name !== "string" || part.name.length === 0) {
          throw new Error(`toolCall ${part.id} missing string name`);
        }
        if (callTimestamp === undefined || callTimestamp.length === 0) {
          throw new Error(`toolCall ${part.id} missing timestamp`);
        }
        if (openById.has(part.id)) {
          throw new Error(`duplicate toolCall id ${part.id}`);
        }
        const args = isRecord(part.arguments) ? part.arguments : undefined;
        // Ticket surface: only bash first-line summary is authorized here.
        const command =
          part.name === "bash" &&
          args !== undefined &&
          typeof args.command === "string"
            ? bashCommandFirstLine(args.command)
            : undefined;
        const interval: Open = {
          toolCallId: part.id,
          toolName: part.name,
          startedAt: callTimestamp,
          ...(command !== undefined ? { command } : {}),
        };
        order.push(interval);
        openById.set(part.id, interval);
      }
    }

    if (message?.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) {
        throw new Error("toolResult frame missing string toolCallId");
      }
      const resultTimestamp =
        typeof message.timestamp === "string" && message.timestamp
          ? message.timestamp
          : rowTimestamp;
      if (resultTimestamp === undefined || resultTimestamp.length === 0) {
        throw new Error(`toolResult ${message.toolCallId} missing timestamp`);
      }
      const open = openById.get(message.toolCallId);
      if (open === undefined) {
        // Result without a prior call is still associable as a closed interval
        // once a name is known; keep structural readability without inventing a call.
        const toolName =
          typeof message.toolName === "string" && message.toolName.length > 0
            ? message.toolName
            : "unknown";
        order.push({
          toolCallId: message.toolCallId,
          toolName,
          startedAt: resultTimestamp,
          endedAt: resultTimestamp,
        });
        continue;
      }
      if (open.endedAt !== undefined) {
        throw new Error(`duplicate toolResult for toolCallId ${message.toolCallId}`);
      }
      open.endedAt = resultTimestamp;
    }
  }

  return order.map((interval) => {
    const base = {
      toolCallId: interval.toolCallId,
      toolName: interval.toolName,
      startedAt: interval.startedAt,
      ...(interval.command !== undefined ? { command: interval.command } : {}),
    };
    return interval.endedAt === undefined
      ? base
      : { ...base, endedAt: interval.endedAt };
  });
}

/**
 * One binding-owned interval inside a continuous volume (#636):
 * from the nearest preceding binding at-or-before `anchorIndex` through the
 * row before the next binding (or EOF). Gate/settlement/analyst share this
 * slice — do not fork a second interval scan.
 *
 * `closed` is true iff a later binding ended the interval before EOF of the
 * provided rows. On a damaged prefix parse, closed intervals are fully owned
 * by their run; open intervals (through prefix EOF) may have lost rows to the
 * bad line and stay honest-missing for full span/tools.
 */
export type BindingInterval = {
  readonly rows: readonly LedgerSessionRow[];
  readonly closed: boolean;
};

export function intervalRowsAroundAnchor(
  rows: readonly LedgerSessionRow[],
  anchorIndex: number,
  isBindingRow: (row: LedgerSessionRow) => boolean,
): BindingInterval {
  let start = 0;
  for (let i = anchorIndex; i >= 0; i -= 1) {
    if (isBindingRow(rows[i]!)) {
      start = i;
      break;
    }
  }
  let end = rows.length;
  for (let i = Math.max(anchorIndex, start) + 1; i < rows.length; i += 1) {
    if (isBindingRow(rows[i]!)) {
      end = i;
      break;
    }
  }
  return { rows: rows.slice(start, end), closed: end < rows.length };
}

/**
 * Interval owned by the first binding row that satisfies `matches`.
 * `undefined` when the volume carries no matching binding — callers must not
 * silently treat the whole continuous volume as that owner.
 */
export function intervalRowsForMatchingBinding(
  rows: readonly LedgerSessionRow[],
  isBindingRow: (row: LedgerSessionRow) => boolean,
  matches: (row: LedgerSessionRow) => boolean,
): BindingInterval | undefined {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!;
    if (!isBindingRow(row) || !matches(row)) continue;
    return intervalRowsAroundAnchor(rows, i, isBindingRow);
  }
  return undefined;
}
