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

function ticketFromRecord(record: Record<string, unknown>): number | undefined {
  const ticketNumber = record.ticketNumber;
  if (
    typeof ticketNumber === "number" &&
    Number.isSafeInteger(ticketNumber) &&
    ticketNumber >= 1
  ) {
    return ticketNumber;
  }
  return undefined;
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
 * Sole effective ticketNumber for a retained run: board admitted → board
 * invocation → migration derivation. Derivation is last so board wins and is
 * never overwritten by a derived page.
 */
export async function readRunTicketNumber(
  runDirectory: string,
): Promise<number | undefined> {
  return (
    (await readBoardPageTicketNumber(runDirectory, "admitted-request.json")) ??
    (await readBoardPageTicketNumber(runDirectory, "invocation.json")) ??
    (await readMigrationDerivedTicketNumber(runDirectory))
  );
}
