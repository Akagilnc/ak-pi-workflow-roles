/**
 * Typed ticket face contract (#176 option A).
 *
 * Machine field lives in YAML frontmatter only:
 *   ---
 *   ticketNumber: <positive integer>
 *   ---
 *
 * Admission reads frozen attachment bytes for this field alone.
 * No filename, path, or free-text inference. Absent / invalid / conflicting
 * values are unbound (undefined) — never a reject gate.
 *
 * Buffer bodies use strict UTF-8 (decode failure → unbound). Opening and
 * closing fences must each be an exclusive line of exactly `---`.
 */

import { exactUtf8 } from "./exact-utf8.ts";

/** Positive integer GitHub/issue identity carried on a typed ticket face. */
export type TicketIdentity = number;

/**
 * Parse one attachment body for the typed frontmatter ticketNumber field.
 * Returns undefined when the contract is absent or not well-formed.
 */
export function parseTicketNumberFrontmatter(
  bytes: Buffer | string,
): TicketIdentity | undefined {
  let text: string;
  if (typeof bytes === "string") {
    text = bytes;
  } else {
    try {
      text = exactUtf8(bytes, "ticket face");
    } catch {
      return undefined;
    }
  }

  // Opening fence must be an exclusive first line of exactly `---`.
  let cursor: number;
  if (text.startsWith("---\n")) {
    cursor = 4;
  } else if (text.startsWith("---\r\n")) {
    cursor = 5;
  } else {
    return undefined;
  }

  // Closing fence must likewise be an exclusive line of exactly `---`.
  const fmLines: string[] = [];
  let closed = false;
  while (cursor < text.length) {
    const nl = text.indexOf("\n", cursor);
    const lineEnd = nl === -1 ? text.length : nl;
    let line = text.slice(cursor, lineEnd);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line === "---") {
      closed = true;
      break;
    }
    fmLines.push(line);
    if (nl === -1) break;
    cursor = nl + 1;
  }
  if (!closed) return undefined;

  let found: number | undefined;
  for (const line of fmLines) {
    const match = /^[ \t]*ticketNumber[ \t]*:[ \t]*(\d+)[ \t]*$/.exec(line);
    if (match === null) continue;
    const value = Number(match[1]);
    if (!Number.isInteger(value) || value < 1) return undefined;
    if (found !== undefined && found !== value) return undefined;
    found = value;
  }
  return found;
}

/**
 * Resolve at most one ticketNumber across frozen attachment bodies.
 * Zero matches → unbound. Multiple distinct values → unbound (do not guess).
 */
export function resolveTicketNumberFromAttachmentBodies(
  bodies: readonly (Buffer | string)[],
): TicketIdentity | undefined {
  const found = new Set<number>();
  for (const body of bodies) {
    const value = parseTicketNumberFrontmatter(body);
    if (value !== undefined) found.add(value);
  }
  if (found.size !== 1) return undefined;
  return found.values().next().value;
}
