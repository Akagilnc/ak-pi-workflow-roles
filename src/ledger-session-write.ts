/**
 * Sole owner of pi session JSONL v3 write shapes (header + durable line).
 * Main principal (role-envelope) and side-branch nests (package record host)
 * both serialize through here — one write rule, separate call-site lifecycles.
 */
import { randomUUID } from "node:crypto";

export const PI_SESSION_JSONL_VERSION = 3 as const;

export type PiSessionHeader = {
  readonly type: "session";
  readonly version: typeof PI_SESSION_JSONL_VERSION;
  readonly id: string;
  readonly timestamp: string;
  readonly cwd: string;
  readonly parentSession?: string;
};

/** Session header object (no IO). Call sites own path, flag, and failure policy. */
export function buildPiSessionHeader(options: {
  readonly id: string;
  readonly cwd: string;
  readonly timestamp?: string;
  readonly parentSession?: string;
}): PiSessionHeader {
  const header: PiSessionHeader = {
    type: "session",
    version: PI_SESSION_JSONL_VERSION,
    id: options.id,
    timestamp: options.timestamp ?? new Date().toISOString(),
    cwd: options.cwd,
  };
  return options.parentSession === undefined
    ? header
    : { ...header, parentSession: options.parentSession };
}

/**
 * Sole owner of id/timestamp fill for pi session entries.
 * Memory paths keep the returned object (and nested data refs) as-is;
 * durable writers stringify only at the write seam.
 */
export function completePiSessionEntryFields(
  entry: Record<string, unknown>,
): Record<string, unknown> {
  const id = typeof entry.id === "string" && entry.id.length > 0
    ? entry.id
    : randomUUID();
  const timestamp = typeof entry.timestamp === "string" && entry.timestamp.length > 0
    ? entry.timestamp
    : new Date().toISOString();
  return { ...entry, id, timestamp };
}

/** One physical JSONL line with trailing newline (disk write only). */
export function formatPiSessionJsonlLine(entry: Record<string, unknown>): string {
  return `${JSON.stringify(completePiSessionEntryFields(entry))}\n`;
}
