/**
 * #636 ticket+seat logical memory principal for officer seats.
 * Reuses archivist subject-keyed createRecordSession resume (navigator path);
 * no parallel continuation machine, no length/round thresholds.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { resolveBookKeyFromGit } from "./activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "./activation-ledger-topology.ts";
import { createRecordSession } from "./archivist-record-entry.ts";
import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  DurablePrincipalCoordinates,
} from "./host-contracts.ts";

/** Record kind for officer ticket-seat memory nests (subject-keyed resume). */
export const TICKET_SEAT_MEMORY_KIND = "auditor-roles" as const;

/** Seats that continue a ticket-keyed memory principal (#636). */
export const TICKET_SEAT_MEMORY_SEATS = ["inspector", "notary", "auditor"] as const;

export type TicketSeatMemorySeat = (typeof TICKET_SEAT_MEMORY_SEATS)[number];

export function isTicketSeatMemorySeat(value: string): value is TicketSeatMemorySeat {
  return (TICKET_SEAT_MEMORY_SEATS as readonly string[]).includes(value);
}

/**
 * Logical memory subject = ticket number + seat.
 * Digest placement is owned by createRecordSession; this string is the sole subject key.
 */
export function ticketSeatMemorySubject(
  ticketNumber: number,
  seat: TicketSeatMemorySeat,
): string {
  if (!Number.isSafeInteger(ticketNumber) || ticketNumber < 1) {
    throw new Error(
      `ticket-seat memory subject requires a positive ticket number, got ${String(ticketNumber)}`,
    );
  }
  if (!isTicketSeatMemorySeat(seat)) {
    throw new Error(`ticket-seat memory subject rejects unknown seat ${JSON.stringify(seat)}`);
  }
  return `${ticketNumber}:${seat}`;
}

/** Book-relative session directory for a ticket+seat memory principal (topology only). */
export function ticketSeatMemorySessionDirectory(input: {
  readonly ticketNumber: number;
  readonly seat: TicketSeatMemorySeat;
  readonly cwd: string;
  readonly home?: string;
}): string {
  const ledgerHome = resolveActivationLedgerHome(input.home);
  const bookKey = resolveBookKeyFromGit(input.cwd);
  const digest = createHash("sha256")
    .update(ticketSeatMemorySubject(input.ticketNumber, input.seat))
    .digest("hex")
    .slice(0, 32);
  return join(
    activationBookDirectory(ledgerHome, bookKey),
    TICKET_SEAT_MEMORY_KIND,
    digest,
  );
}

/**
 * Read ticketNumber from a retained run's admitted-request.json, falling back to
 * invocation.json. Same integer rules as public-cli source-run inheritance (#635).
 */
export async function readRunTicketNumber(
  runDirectory: string,
): Promise<number | undefined> {
  for (const page of ["admitted-request.json", "invocation.json"] as const) {
    try {
      const raw = JSON.parse(
        await readFile(join(runDirectory, page), "utf8"),
      ) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const ticketNumber = (raw as Record<string, unknown>).ticketNumber;
      if (
        typeof ticketNumber === "number" &&
        Number.isSafeInteger(ticketNumber) &&
        ticketNumber >= 1
      ) {
        return ticketNumber;
      }
    } catch {
      // Missing or unreadable page → try next; unbound if none yield a ticket.
    }
  }
  return undefined;
}

/**
 * Open-or-create the ticket+seat memory principal via createRecordSession subject
 * resume (navigator path). Returns coordinates for the durable principal codec.
 *
 * `ledgerAnchorSessionFile` must live under the intended package home `.ak-roles`
 * tree so createRecordSession path-derives the correct ledger home (ADR 0048).
 * Subject placement still lands at book/kind/digest — anchor is not the nest.
 */
export function openTicketSeatMemoryCoordinates(input: {
  readonly ticketNumber: number;
  readonly seat: TicketSeatMemorySeat;
  readonly cwd: string;
  readonly ledgerAnchorSessionFile: string;
}): DurablePrincipalCoordinates {
  const session = createRecordSession({
    cwd: input.cwd,
    kind: TICKET_SEAT_MEMORY_KIND,
    subject: ticketSeatMemorySubject(input.ticketNumber, input.seat),
    parent: {
      getSessionFile: () => input.ledgerAnchorSessionFile,
    },
  });
  const sessionFile = session.getSessionFile();
  const sessionDirectory = session.getSessionDir();
  if (typeof sessionFile !== "string" || sessionFile.length === 0) {
    throw new Error(
      `ticket-seat memory principal missing session file for ticket #${input.ticketNumber} seat ${input.seat}`,
    );
  }
  if (typeof sessionDirectory !== "string" || sessionDirectory.length === 0) {
    throw new Error(
      `ticket-seat memory principal missing session directory for ticket #${input.ticketNumber} seat ${input.seat}`,
    );
  }
  return { sessionDirectory, sessionFile };
}

/**
 * Rebind an admitted public officer run onto the ticket+seat memory principal.
 * Run directory (admitted-request / attachments / artifacts) stays independent;
 * only the logical memory principal continues across runs (#636 / ADR 0079).
 */
export async function rebindAdmittedToTicketSeatMemory(input: {
  readonly admitted: {
    readonly runDirectory: string;
    readonly projectRoot: string;
    readonly ticketNumber?: number;
    principal: DurablePrincipal;
  };
  readonly seat: TicketSeatMemorySeat;
  readonly principalAuthority: DurablePrincipalAuthority;
  readonly home?: string;
}): Promise<DurablePrincipalCoordinates | undefined> {
  const ticketNumber = input.admitted.ticketNumber;
  if (ticketNumber === undefined) return undefined;

  // Anchor under the already-issued run principal so ledger home path-derives
  // from the package home that issued admission (never ambient passwd home).
  const anchor = input.principalAuthority.decode(input.admitted.principal);
  const coordinates = openTicketSeatMemoryCoordinates({
    ticketNumber,
    seat: input.seat,
    cwd: input.admitted.projectRoot,
    ledgerAnchorSessionFile: anchor.sessionFile,
  });
  // Encode via authority issue shape is unavailable for arbitrary paths; reuse
  // decode-compatible wire object (same two-field coordinates as Pi codec).
  const principal = coordinates as DurablePrincipal;
  // Validate round-trip through the host authority.
  input.principalAuthority.decode(principal);
  (input.admitted as { principal: DurablePrincipal }).principal = principal;

  for (const page of ["admitted-request.json", "invocation.json"] as const) {
    const path = join(input.admitted.runDirectory, page);
    try {
      const raw = JSON.parse(await readFile(path, "utf8")) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) continue;
      const next = {
        ...(raw as Record<string, unknown>),
        sessionDirectory: coordinates.sessionDirectory,
        sessionFile: coordinates.sessionFile,
      };
      await writeFile(path, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    } catch {
      // Missing page is lawful for some seats; skip.
    }
  }
  return coordinates;
}

const TICKET_SEAT_LAST_HOST_FILE = "last-host.json";

/** Read the last host that wrote the ticket-seat memory nest (#617 DK-4 / #636). */
export async function readTicketSeatMemoryLastHost(
  sessionDirectory: string,
): Promise<string | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(join(sessionDirectory, TICKET_SEAT_LAST_HOST_FILE), "utf8"),
    ) as unknown;
    if (
      raw !== null &&
      typeof raw === "object" &&
      !Array.isArray(raw) &&
      typeof (raw as { host?: unknown }).host === "string" &&
      (raw as { host: string }).host.length > 0
    ) {
      return (raw as { host: string }).host;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** Persist the host that just wrote the ticket-seat memory nest. */
export async function writeTicketSeatMemoryLastHost(
  sessionDirectory: string,
  host: string,
): Promise<void> {
  if (host.trim() === "") return;
  await writeFile(
    join(sessionDirectory, TICKET_SEAT_LAST_HOST_FILE),
    `${JSON.stringify({ host }, null, 2)}\n`,
    "utf8",
  );
}
