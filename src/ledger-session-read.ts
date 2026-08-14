/**
 * Canonical ledger session JSONL read primitives (shared owner).
 * Consumers (ticket-trajectory, taishi, …) must import here — no second parse kernel.
 */
import { readFile } from "node:fs/promises";

export type LedgerSessionRow = Record<string, unknown>;

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
        throw new Error(
          `malformed JSONL record in ${path} at line ${index + 1}: ${error.message}`,
        );
      }
      // unfinished fragment at EOF — keep prior complete rows
      break;
    }
    // Syntactically complete line: must be a session object. Silent omission
    // would under-count ledger evidence (failure honesty).
    if (!isRecord(row)) {
      const kind = row === null ? "null" : Array.isArray(row) ? "array" : typeof row;
      throw new Error(
        `complete non-object JSONL record in ${path} at line ${index + 1}: expected object, got ${kind}`,
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

export type SessionToolInterval = {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  /**
   * String `command` argument when the toolCall carried one (bash observation
   * material for action boards). Omitted when absent or non-string.
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
        const command =
          args !== undefined && typeof args.command === "string"
            ? args.command
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
