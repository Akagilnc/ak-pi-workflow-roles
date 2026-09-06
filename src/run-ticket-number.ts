/**
 * Typed ticketNumber reader for a retained run's durable pages.
 * admitted-request.json first, invocation.json fallback. Missing page (ENOENT)
 * → try next / undefined; damage and non-ENOENT IO failures propagate.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

async function readPageTicketNumber(
  runDirectory: string,
  page: "admitted-request.json" | "invocation.json",
): Promise<number | undefined> {
  try {
    const raw = JSON.parse(await readFile(join(runDirectory, page), "utf8")) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return undefined;
    }
    return ticketFromRecord(raw as Record<string, unknown>);
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

/** Sole reader of ticketNumber from a retained run's admitted then invocation pages. */
export async function readRunTicketNumber(
  runDirectory: string,
): Promise<number | undefined> {
  return (
    (await readPageTicketNumber(runDirectory, "admitted-request.json")) ??
    (await readPageTicketNumber(runDirectory, "invocation.json"))
  );
}
