/**
 * Shared placement helpers for book-topology migrators (#865 / #866).
 * Single authority for historical run ticket derivation and destination run paths.
 */
import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";

const TICKET_NUMBER_RE = /^[1-9][0-9]*$/;
const RUN_DIR_NAME_RE = /^([^@]+)@([^@]+)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function ticketNumberFromUnknown(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === "string" && TICKET_NUMBER_RE.test(value)) return Number(value);
  return undefined;
}

export function isTicketNumberString(value: string): boolean {
  return TICKET_NUMBER_RE.test(value);
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const raw: unknown = JSON.parse(await readFile(path, "utf8"));
    return isRecord(raw) ? raw : undefined;
  } catch (error) {
    if ((error as { code?: unknown }).code === "ENOENT") return undefined;
    return undefined;
  }
}

export type MigratingRunTicketDerivation = {
  readonly method: "admitted-request" | "invocation" | "project-root-basename";
  readonly source: string;
};

/**
 * Ticket binding for a retained run directory (#852 / #865):
 * disk-recorded ticket first, then projectRoot basename when it is a ticket number.
 */
export async function resolveMigratingRunTicket(runDirectory: string): Promise<{
  readonly ticketNumber: number | undefined;
  readonly derivation: MigratingRunTicketDerivation | undefined;
}> {
  for (const page of ["admitted-request.json", "invocation.json"] as const) {
    const path = join(runDirectory, page);
    const body = await readJsonObject(path);
    if (body === undefined) continue;
    const direct = ticketNumberFromUnknown(body.ticketNumber);
    if (direct !== undefined) {
      return {
        ticketNumber: direct,
        derivation: {
          method: page === "admitted-request.json" ? "admitted-request" : "invocation",
          source: path,
        },
      };
    }
    if (isRecord(body.subject)) {
      const fromSubject = ticketNumberFromUnknown(body.subject.ticketNumber);
      if (fromSubject !== undefined) {
        return {
          ticketNumber: fromSubject,
          derivation: {
            method: page === "admitted-request.json" ? "admitted-request" : "invocation",
            source: path,
          },
        };
      }
    }
  }

  const admitted = await readJsonObject(join(runDirectory, "admitted-request.json"));
  const invocation = await readJsonObject(join(runDirectory, "invocation.json"));
  const projectRoot =
    (admitted !== undefined && typeof admitted.projectRoot === "string" ? admitted.projectRoot : undefined)
    ?? (invocation !== undefined && typeof invocation.projectRoot === "string" ? invocation.projectRoot : undefined);
  if (projectRoot !== undefined) {
    const leaf = basename(projectRoot.replace(/\\/g, "/"));
    const ticketNumber = ticketNumberFromUnknown(leaf);
    if (ticketNumber !== undefined) {
      return {
        ticketNumber,
        derivation: { method: "project-root-basename", source: projectRoot },
      };
    }
  }
  return { ticketNumber: undefined, derivation: undefined };
}

/** Locate `runId@role` under bookDir/runs, bookDir/<subject>/runs, bookDir/unbound/runs. */
export async function findBookRunDirectory(
  bookDir: string,
  runId: string,
): Promise<{ readonly runDirectory: string; readonly role: string } | undefined> {
  if (runId.trim() === "") return undefined;
  const subjectEntries = await readdir(bookDir, { withFileTypes: true }).catch((error: unknown) => {
    if ((error as { code?: unknown }).code === "ENOENT") return [] as const;
    throw error;
  });
  const subjectDirs = [
    "",
    ...subjectEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  ];
  for (const subject of subjectDirs) {
    const runsDir = subject === "" ? join(bookDir, "runs") : join(bookDir, subject, "runs");
    let entries: string[];
    try {
      entries = await readdir(runsDir);
    } catch (error) {
      if ((error as { code?: unknown }).code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.startsWith(`${runId}@`)) continue;
      const role = entry.slice(runId.length + 1);
      if (role.length === 0 || role.includes("@")) continue;
      return { runDirectory: join(runsDir, entry), role };
    }
  }
  return undefined;
}

export function destinationRunDirectory(
  booksDirectory: string,
  bookKey: string,
  ticketNumber: number | undefined,
  runId: string,
  role: string,
): string {
  const subjectDirectory = ticketNumber !== undefined ? String(ticketNumber) : "unbound";
  return join(booksDirectory, bookKey, subjectDirectory, "runs", `${runId}@${role}`);
}

/** Extract runId@role from a sessionParent path when it points at a run session. */
export function runCoordsFromSessionParent(
  sessionParent: unknown,
): { readonly runId: string; readonly role: string } | undefined {
  if (typeof sessionParent !== "string" || sessionParent.length === 0) return undefined;
  const normalized = sessionParent.replace(/\\/g, "/");
  const marker = "/runs/";
  const index = normalized.lastIndexOf(marker);
  if (index < 0) return undefined;
  const after = normalized.slice(index + marker.length);
  const leaf = after.split("/")[0] ?? "";
  const match = RUN_DIR_NAME_RE.exec(leaf);
  if (match === null) return undefined;
  return { runId: match[1]!, role: match[2]! };
}

export function runIdFromSubject(subject: unknown): string | undefined {
  if (typeof subject === "string" && subject.length > 0) return subject;
  if (isRecord(subject) && typeof subject.runId === "string" && subject.runId.length > 0) {
    return subject.runId;
  }
  return undefined;
}

export function ticketNumberFromSubject(subject: unknown): number | undefined {
  if (typeof subject === "string" || typeof subject === "number") {
    return ticketNumberFromUnknown(subject);
  }
  if (isRecord(subject)) return ticketNumberFromUnknown(subject.ticketNumber);
  return undefined;
}
