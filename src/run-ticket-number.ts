/**
 * Typed ticketNumber reader for a retained run's durable pages.
 * Board pages first (admitted-request, then invocation); migration derivation
 * page last so worktree-derived placement stays readable without forging a
 * board assertion. Missing page (ENOENT) → try next / undefined; damage and
 * non-ENOENT IO failures propagate.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/** Sole on-disk page for worktree-basename ticket derivation (#865). */
export const MIGRATION_TICKET_DERIVATION_PAGE =
  "migration-ticket-derivation.json" as const;

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/** Sole safe-positive ticket invariant (bind / admission / placement / readers). */
export function isSafePositiveTicketNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

/**
 * #1071 — read a role-declared ticketNumber field value for post-admission bind.
 * Accepts a safe positive integer, a digit string, or a leading `#N` token
 * (optional trailing material on the same field, e.g. `#1843 / PR #1876`).
 * Unidentifiable shapes return undefined (leave unbound); never reads prose
 * note/report fields — callers must pass the typed ticketNumber value only.
 */
export function readDeclaredTicketNumber(value: unknown): number | undefined {
  if (isSafePositiveTicketNumber(value)) return value;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  const match = /^#?([1-9]\d*)(?:\b|$)/.exec(trimmed);
  if (match === null) return undefined;
  const ticketNumber = Number(match[1]);
  return isSafePositiveTicketNumber(ticketNumber) ? ticketNumber : undefined;
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
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return undefined;
    }
    return raw as Record<string, unknown>;
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

async function readBoardPageTicketNumber(
  runDirectory: string,
  page: "admitted-request.json" | "invocation.json",
): Promise<number | undefined> {
  const record = await readJsonObject(join(runDirectory, page));
  if (record === undefined) return undefined;
  return ticketFromRecord(record);
}

/**
 * Board-only ticketNumber (admitted → invocation). Placement attribution and
 * any caller that must ignore derivation pages use this sole projection.
 */
export async function readBoardTicketNumber(
  runDirectory: string,
): Promise<number | undefined> {
  return (
    (await readBoardPageTicketNumber(runDirectory, "admitted-request.json")) ??
    (await readBoardPageTicketNumber(runDirectory, "invocation.json"))
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
