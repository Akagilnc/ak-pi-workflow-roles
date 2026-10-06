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
 * One physical JSONL line with trailing newline.
 * Fills missing id/timestamp the same way the principal durable writer always did.
 */
export function formatPiSessionJsonlLine(entry: Record<string, unknown>): string {
  const id = typeof entry.id === "string" && entry.id.length > 0
    ? entry.id
    : randomUUID();
  const timestamp = typeof entry.timestamp === "string" && entry.timestamp.length > 0
    ? entry.timestamp
    : new Date().toISOString();
  return `${JSON.stringify({ ...entry, id, timestamp })}\n`;
}
