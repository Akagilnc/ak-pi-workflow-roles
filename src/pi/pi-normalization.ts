/**
 * Pi adapter session normalization translation point (#520 r8 / #513).
 * Normalizes Pi native frames at attempt settlement to minimal canonical records.
 * Promotes and owns session parsing primitives previously in ledger-session-read.ts.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  sitianReport,
  type RecordPointer,
  type SitianSubject,
  type SitianUsage,
} from "../sitian-facade.ts";

export type SessionRow = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** First and last record timestamps in encounter order. */
export function extractSessionTimestampSpan(
  rows: readonly SessionRow[],
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
 * Sources:
 * - `model_change.modelId`
 * - assistant `message.model`
 */
export function extractSessionModelSequence(
  rows: readonly SessionRow[],
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
  readonly endedAt?: string | undefined;
  readonly command?: string | undefined;
  readonly isError?: boolean | undefined;
};

/**
 * Pair toolCall frames → toolResult frames by toolCallId.
 */
export function extractSessionToolIntervals(
  rows: readonly SessionRow[],
): SessionToolInterval[] {
  type Open = {
    toolCallId: string;
    toolName: string;
    startedAt: string;
    endedAt?: string | undefined;
    command?: string | undefined;
    isError?: boolean | undefined;
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
        if (typeof part.id !== "string" || part.id.length === 0) continue;
        if (typeof part.name !== "string" || part.name.length === 0) continue;
        const timestamp = callTimestamp ?? new Date().toISOString();
        if (openById.has(part.id)) continue;

        const args = isRecord(part.arguments) ? part.arguments : undefined;
        const command =
          part.name === "bash" &&
          args !== undefined &&
          typeof args.command === "string"
            ? bashCommandFirstLine(args.command)
            : undefined;

        const interval: Open = {
          toolCallId: part.id,
          toolName: part.name,
          startedAt: timestamp,
          ...(command !== undefined ? { command } : {}),
        };
        order.push(interval);
        openById.set(part.id, interval);
      }
    }

    if (message?.role === "toolResult") {
      if (typeof message.toolCallId !== "string" || message.toolCallId.length === 0) {
        continue;
      }
      const resultTimestamp =
        typeof message.timestamp === "string" && message.timestamp
          ? message.timestamp
          : rowTimestamp ?? new Date().toISOString();

      const open = openById.get(message.toolCallId);
      if (open === undefined) {
        const toolName =
          typeof message.toolName === "string" && message.toolName.length > 0
            ? message.toolName
            : "unknown";
        order.push({
          toolCallId: message.toolCallId,
          toolName,
          startedAt: resultTimestamp,
          endedAt: resultTimestamp,
          ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}),
        });
        continue;
      }
      open.endedAt = resultTimestamp;
      if (typeof message.isError === "boolean") {
        open.isError = message.isError;
      }
    }
  }

  return order.map((interval) => ({
    toolCallId: interval.toolCallId,
    toolName: interval.toolName,
    startedAt: interval.startedAt,
    ...(interval.endedAt !== undefined ? { endedAt: interval.endedAt } : {}),
    ...(interval.command !== undefined ? { command: interval.command } : {}),
    ...(interval.isError !== undefined ? { isError: interval.isError } : {}),
  }));
}

export type NormalizePiSessionAttemptOptions = {
  readonly sessionFile: string;
  readonly cwd?: string | undefined;
  readonly subject?: SitianSubject | undefined;
};

/**
 * Normalizes one Pi session attempt into canonical Sitian records.
 * Carries raw pointers back to original frames without copying full transcripts (#513).
 * Deterministically derives canonical identities (${sessionId}:${frameId}) for idempotent persistence.
 */
export async function normalizePiSessionAttempt(
  options: NormalizePiSessionAttemptOptions,
): Promise<readonly RecordPointer[]> {
  const text = await readFile(options.sessionFile, "utf8");
  const lines = text.split("\n");
  const pointers: RecordPointer[] = [];

  const validRows: SessionRow[] = [];
  let sessionId = basename(options.sessionFile, ".jsonl");
  let aggregatedUsage: SitianUsage | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);
      if (!isRecord(parsed)) {
        throw new Error("non-object session frame");
      }
      validRows.push(parsed);

      if (parsed.type === "session" && typeof parsed.id === "string" && parsed.id.length > 0) {
        sessionId = parsed.id;
      }

      const message = isRecord(parsed.message) ? parsed.message : undefined;
      if (message?.role === "assistant" && isRecord(message.usage)) {
        const u = message.usage;
        aggregatedUsage = {
          promptTokens: (aggregatedUsage?.promptTokens ?? 0) + (typeof u.promptTokens === "number" ? u.promptTokens : 0),
          completionTokens: (aggregatedUsage?.completionTokens ?? 0) + (typeof u.completionTokens === "number" ? u.completionTokens : 0),
          totalTokens: (aggregatedUsage?.totalTokens ?? 0) + (typeof u.totalTokens === "number" ? u.totalTokens : 0),
        };
      }
    } catch (error) {
      // Normalization failure: record typed failure and keep traversing
      const ptr = sitianReport({
        level: "event",
        kind: "normalization-failure",
        cwd: options.cwd,
        subject: options.subject,
        identity: `${sessionId}:bad-line-${index + 1}`,
        raw: { sessionFile: options.sessionFile, entryId: index + 1 },
        payload: {
          line: index + 1,
          rawText: line,
          error: error instanceof Error ? error.message : String(error),
        },
        source: "pi-normalization",
      });
      pointers.push(ptr);
    }
  }

  const models = extractSessionModelSequence(validRows);
  const span = extractSessionTimestampSpan(validRows);
  const toolIntervals = extractSessionToolIntervals(validRows);

  // Normalize paired tool intervals into canonical tool-call event records
  for (const interval of toolIntervals) {
    const ptr = sitianReport({
      level: "event",
      kind: "tool-call",
      cwd: options.cwd,
      subject: options.subject,
      identity: `${sessionId}:${interval.toolCallId}`,
      raw: { sessionFile: options.sessionFile, entryId: interval.toolCallId },
      payload: interval,
      timestamp: interval.startedAt,
      source: "pi-normalization",
    });
    pointers.push(ptr);
  }

  // Normalize attempt summary into run-summary record
  const summaryTimestamp = span.endedAt ?? span.startedAt ?? new Date().toISOString();
  const summaryPtr = sitianReport({
    level: "run-summary",
    kind: "attempt-summary",
    cwd: options.cwd,
    subject: options.subject,
    identity: `${sessionId}:summary`,
    raw: { sessionFile: options.sessionFile, entryId: "summary" },
    payload: {
      startedAt: span.startedAt,
      endedAt: span.endedAt,
      models,
      toolIntervals,
    },
    ...(aggregatedUsage !== undefined ? { usage: aggregatedUsage } : {}),
    timestamp: summaryTimestamp,
    source: "pi-normalization",
  });
  pointers.push(summaryPtr);

  return pointers;
}
