/**
 * Typed ticketNumber reader for a retained run's durable pages.
 * Production board reads use state.jsonl rows only (admitted, then invocation).
 * Pre-#1161 page files are readable only via readMigrationBoardTicketNumber.
 * Migration derivation page last so worktree-derived placement stays readable
 * without forging a board assertion. Missing page (ENOENT) → try next / undefined;
 * damage and non-ENOENT IO failures propagate.
 */
import { readPageSync } from "./run-dossier.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { isEnoent, isRecord } from "./unknown-value.ts";

/** Sole on-disk page for worktree-basename ticket derivation (#865). */
export const MIGRATION_TICKET_DERIVATION_PAGE =
  "migration-ticket-derivation.json" as const;

/** Positive-integer contract for display / snapshot inputs; binding uses the safe subset below. */
export function isPositiveTicketNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** Sole safe-positive ticket invariant (bind / admission / placement / readers). */
export function isSafePositiveTicketNumber(value: unknown): value is number {
  return isPositiveTicketNumber(value) && Number.isSafeInteger(value);
}

/** Shared digit spelling, also used for consumer-specific rejection diagnostics. */
export function isTicketNumberString(value: unknown): value is string {
  return typeof value === "string" && /^[1-9][0-9]*$/.test(value);
}

/**
 * Ticket spelling shared by placement, migration, and sitian subject routing.
 * A number, or a digit string with no sign, zero-pad, decimal, or `#`.
 * Unsafe integers are unidentified. Leading `#N` stays on readDeclaredTicketNumber.
 */
export function parseTicketNumber(value: unknown): number | undefined {
  if (isSafePositiveTicketNumber(value)) return value;
  if (!isTicketNumberString(value)) return undefined;
  const parsed = Number(value);
  return isSafePositiveTicketNumber(parsed) ? parsed : undefined;
}

/** Ticket number carried by a sitian subject, when the subject is a ticket. */
export function sitianSubjectTicketNumber(subject: unknown): number | undefined {
  if (typeof subject === "string" || typeof subject === "number") {
    return parseTicketNumber(subject);
  }
  if (subject !== null && typeof subject === "object" && !Array.isArray(subject)) {
    return parseTicketNumber((subject as { ticketNumber?: unknown }).ticketNumber);
  }
  return undefined;
}

/** Ticket-provenance directory id from a sitian subject, when the subject is a ticket. */
export function ticketNumberFromSitianSubject(subject: unknown): string | undefined {
  const parsed = sitianSubjectTicketNumber(subject);
  return parsed === undefined ? undefined : String(parsed);
}

/**
 * #1071 — read a role-declared ticketNumber field value for post-admission bind.
 * Accepts a safe positive integer, a digit string, or a leading `#N` token
 * (optional trailing material on the same field, e.g. `#1843 / PR #1876`).
 * Decimal-looking prefixes (`1843.5`, `#1843.5`) are unidentifiable → undefined
 * (leave unbound). Never reads prose note/report fields — callers must pass the
 * typed ticketNumber value only.
 */
export function readDeclaredTicketNumber(value: unknown): number | undefined {
  if (isSafePositiveTicketNumber(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  // `(?!\.\d)` keeps `#1843 / PR #1876` while rejecting `#1843.5` / `1843.5`
  // (word-boundary alone would truncate at the decimal point).
  const match = /^#?([1-9]\d*)(?!\.\d)(?:\b|$)/.exec(trimmed);
  if (match === null) return undefined;
  return parseTicketNumber(match[1]);
}

/** Loud reject for non-safe-positive ticket numbers before placement or bind. */
export function requireSafePositiveTicketNumber(
  ticketNumber: number,
  context = "ticketNumber",
): number {
  if (!isSafePositiveTicketNumber(ticketNumber)) {
    throw new Error(
      `${context} requires a safe positive integer, got ${String(ticketNumber)}`,
    );
  }
  return ticketNumber;
}

function ticketFromRecord(record: Record<string, unknown>): number | undefined {
  return isSafePositiveTicketNumber(record.ticketNumber)
    ? record.ticketNumber
    : undefined;
}

async function readJsonObject(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isRecord(raw)) {
      return undefined;
    }
    return raw;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

/** Pre-#1161 separate board pages — migration input only, not a runtime fact path. */
const LEGACY_BOARD_PAGE: Readonly<Record<"admitted" | "invocation", string>> = {
  admitted: "admitted-request.json",
  invocation: "invocation.json",
};

function readBoardPageTicketNumberFromRows(
  runDirectory: string,
  section: "admitted" | "invocation",
): number | undefined {
  const fromRows = readPageSync(runDirectory, section);
  return fromRows === undefined ? undefined : ticketFromRecord(fromRows);
}

async function readBoardPageTicketNumberFromLegacy(
  runDirectory: string,
  section: "admitted" | "invocation",
): Promise<number | undefined> {
  const record = await readJsonObject(join(runDirectory, LEGACY_BOARD_PAGE[section]));
  if (record === undefined) return undefined;
  return ticketFromRecord(record);
}

/**
 * Board-only ticketNumber from fact rows (admitted → invocation).
 * Public / production identity paths use this sole projection — never legacy pages.
 */
export async function readBoardTicketNumber(
  runDirectory: string,
): Promise<number | undefined> {
  return (
    readBoardPageTicketNumberFromRows(runDirectory, "admitted") ??
    readBoardPageTicketNumberFromRows(runDirectory, "invocation")
  );
}

/**
 * Migration-boundary board ticket: fact rows first, then pre-#1161 page files.
 * Only #852 migrators and placement may call this; runtime identity must not.
 */
export async function readMigrationBoardTicketNumber(
  runDirectory: string,
): Promise<number | undefined> {
  return (
    (await readBoardTicketNumber(runDirectory)) ??
    (await readBoardPageTicketNumberFromLegacy(runDirectory, "admitted")) ??
    (await readBoardPageTicketNumberFromLegacy(runDirectory, "invocation"))
  );
}

/**
 * Worktree-derivation ticket only — never a board assertion. Callers that must
 * distinguish board vs derived use this; effective readers use readRunTicketNumber.
 */
export async function readMigrationDerivedTicketNumber(
  runDirectory: string,
): Promise<number | undefined> {
  const record = await readJsonObject(
    join(runDirectory, MIGRATION_TICKET_DERIVATION_PAGE),
  );
  if (record === undefined) return undefined;
  if (record.derivation !== "worktree-path-basename") return undefined;
  return ticketFromRecord(record);
}

/**
 * Display / historical-placement ticketNumber for a retained run:
 * board admitted → board invocation → migration derivation.
 * Derivation is last so board wins. Callers that mint, resume, inherit, or
 * otherwise write ticket identity must use readBoardTicketNumber instead —
 * derived placement is never a board assertion.
 */
export async function readRunTicketNumber(
  runDirectory: string,
): Promise<number | undefined> {
  return (
    (await readBoardTicketNumber(runDirectory)) ??
    (await readMigrationDerivedTicketNumber(runDirectory))
  );
}
