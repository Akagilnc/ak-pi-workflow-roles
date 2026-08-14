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
 */

/** Positive integer GitHub/issue identity carried on a typed ticket face. */
export type TicketIdentity = number;

/**
 * Parse one attachment body for the typed frontmatter ticketNumber field.
 * Returns undefined when the contract is absent or not well-formed.
 */
export function parseTicketNumberFrontmatter(
  bytes: Buffer | string,
): TicketIdentity | undefined {
  const text = typeof bytes === "string" ? bytes : bytes.toString("utf8");
  if (!text.startsWith("---")) return undefined;
  // Closing fence must start a line (`\n---`), matching the skill frontmatter strip.
  const end = text.indexOf("\n---", 3);
  if (end === -1) return undefined;
  const fm = text.slice(3, end).replace(/^\r?\n/, "");
  let found: number | undefined;
  for (const line of fm.split(/\r?\n/)) {
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
