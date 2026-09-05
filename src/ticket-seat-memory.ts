/**
 * #636 ticket+seat logical memory principal for officer seats.
 * Reuses archivist subject-keyed createRecordSession resume (navigator path);
 * no parallel continuation machine, no length/round thresholds.
 *
 * Pure read/topology stays free of SessionManager so public-bin cold paths
 * (analyst/settlement/invocation) cannot fold pi-coding-agent into main.js.
 * Open-session loads createRecordSessionOpen via runtime-constructed import.
 */
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { homeFromRunDirectory } from "./activation-ledger-topology.ts";
import { subjectKeyedRecordDirectory } from "./archivist-record-topology.ts";
import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  DurablePrincipalCoordinates,
} from "./host-contracts.ts";

type CreateRecordSessionOpen = typeof import("./archivist-record-entry.ts").createRecordSessionOpen;

/**
 * Resolve createRecordSessionOpen without a static graph edge into the public
 * CLI bundle (same deferred-load pattern as load-production-grok-host / #580).
 */
async function loadCreateRecordSessionOpen(): Promise<CreateRecordSessionOpen> {
  const here = dirname(fileURLToPath(import.meta.url));
  // Source/tsx: sibling under src/. Bundled public bin: dist/public-cli/main.js → ../.
  const candidates = [
    join(here, "archivist-record-entry.ts"),
    join(here, "archivist-record-entry.js"),
    join(here, "..", "archivist-record-entry.js"),
    join(here, "..", "archivist-record-entry.ts"),
  ];
  const target = candidates.find((path) => existsSync(path));
  if (target === undefined) {
    throw new Error(
      `archivist record entry module not found from ${here} (ticket-seat memory open)`,
    );
  }
  const mod = (await import(pathToFileURL(target).href)) as {
    createRecordSessionOpen: CreateRecordSessionOpen;
  };
  return mod.createRecordSessionOpen;
}

/** Record kind for officer ticket-seat memory nests (subject-keyed resume). */
export const TICKET_SEAT_MEMORY_KIND = "auditor-roles" as const;

/** Seats that continue a ticket-keyed memory principal (#636). */
export const TICKET_SEAT_MEMORY_SEATS = ["inspector", "notary", "auditor"] as const;

export type TicketSeatMemorySeat = (typeof TICKET_SEAT_MEMORY_SEATS)[number];

export function isTicketSeatMemorySeat(value: string): value is TicketSeatMemorySeat {
  return (TICKET_SEAT_MEMORY_SEATS as readonly string[]).includes(value);
}

/**
 * Explicit ticket+seat binding fact for memory side effects (#636).
 * Directory-outside-run guessing is not a business identity.
 */
export function isTicketSeatMemoryBound(input: {
  readonly role: string;
  readonly ticketNumber?: number;
}): input is { readonly role: TicketSeatMemorySeat; readonly ticketNumber: number } {
  return (
    isTicketSeatMemorySeat(input.role) &&
    typeof input.ticketNumber === "number" &&
    Number.isSafeInteger(input.ticketNumber) &&
    input.ticketNumber >= 1
  );
}

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

/**
 * Logical memory subject = ticket number + seat.
 * Digest placement is owned by createRecordSession; this string is the sole subject key.
 * Seat is the closed TicketSeatMemorySeat type — callers narrow before entry.
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
  return `${ticketNumber}:${seat}`;
}

/** Book-relative session directory via sole archivist subject topology. */
export function ticketSeatMemorySessionDirectory(input: {
  readonly ticketNumber: number;
  readonly seat: TicketSeatMemorySeat;
  readonly cwd: string;
  readonly home?: string;
  readonly parentSessionFile?: string;
}): string {
  return subjectKeyedRecordDirectory({
    cwd: input.cwd,
    kind: TICKET_SEAT_MEMORY_KIND,
    subject: ticketSeatMemorySubject(input.ticketNumber, input.seat),
    ...(input.parentSessionFile === undefined
      ? {}
      : { parentSessionFile: input.parentSessionFile }),
    ...(input.home === undefined ? {} : { home: input.home }),
  });
}

type RunAdmittedPageFacts = {
  readonly ticketNumber?: number;
  readonly projectRoot?: string;
};

/**
 * One read of admitted-request.json facts used by ticket-seat discovery.
 * Missing page (ENOENT) → empty facts; damage / non-ENOENT IO propagate.
 */
async function readRunAdmittedPageFacts(
  runDirectory: string,
): Promise<RunAdmittedPageFacts> {
  try {
    const raw = JSON.parse(
      await readFile(join(runDirectory, "admitted-request.json"), "utf8"),
    ) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return {};
    }
    const record = raw as Record<string, unknown>;
    const ticketNumber = record.ticketNumber;
    const projectRoot = record.projectRoot;
    return {
      ...(typeof ticketNumber === "number" &&
      Number.isSafeInteger(ticketNumber) &&
      ticketNumber >= 1
        ? { ticketNumber }
        : {}),
      ...(typeof projectRoot === "string" ? { projectRoot } : {}),
    };
  } catch (error) {
    if (isEnoent(error)) return {};
    throw error;
  }
}

/** Ticket number from invocation.json only (admitted page already consulted). */
async function readInvocationTicketNumber(
  runDirectory: string,
): Promise<number | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(join(runDirectory, "invocation.json"), "utf8"),
    ) as unknown;
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return undefined;
    }
    const ticketNumber = (raw as Record<string, unknown>).ticketNumber;
    if (
      typeof ticketNumber === "number" &&
      Number.isSafeInteger(ticketNumber) &&
      ticketNumber >= 1
    ) {
      return ticketNumber;
    }
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  return undefined;
}

/**
 * Sole reader of ticketNumber from a retained run's admitted-request.json,
 * falling back to invocation.json. Same integer rules as public-cli source-run
 * inheritance (#635). Missing page (ENOENT) → try next / undefined; damage and
 * non-ENOENT IO failures propagate (failure honesty).
 */
export async function readRunTicketNumber(
  runDirectory: string,
): Promise<number | undefined> {
  const admitted = await readRunAdmittedPageFacts(runDirectory);
  if (admitted.ticketNumber !== undefined) return admitted.ticketNumber;
  return readInvocationTicketNumber(runDirectory);
}

/**
 * Sole discovery of ticket-seat memory nest directories for a retained run.
 * Reads ticket + projectRoot once from the admitted page (ticket falls back to
 * invocation only); home path-derives from the run.
 * Missing ticket / projectRoot / home topology → [] (callers keep legacy parent-nest lookup).
 * Damaged pages and non-ENOENT IO failures propagate (failure honesty).
 */
export async function resolveTicketSeatMemoryNestDirectories(input: {
  readonly runDirectory: string;
  readonly seats: readonly TicketSeatMemorySeat[];
}): Promise<readonly string[]> {
  if (input.seats.length === 0) return [];

  // One admitted-request read supplies both ticket and projectRoot; ticket may
  // still fall back to invocation.json without re-opening the admitted page.
  const admitted = await readRunAdmittedPageFacts(input.runDirectory);
  const ticketNumber =
    admitted.ticketNumber ?? (await readInvocationTicketNumber(input.runDirectory));
  if (ticketNumber === undefined) return [];

  let home: string;
  try {
    home = homeFromRunDirectory(input.runDirectory);
  } catch {
    // Path not under package .ak-roles topology — no ticket-seat nest to discover.
    return [];
  }

  const projectRoot = admitted.projectRoot;
  if (projectRoot === undefined) return [];

  return input.seats.map((seat) =>
    ticketSeatMemorySessionDirectory({
      ticketNumber,
      seat,
      cwd: projectRoot,
      home,
    }),
  );
}

/**
 * Open-or-create the ticket+seat memory principal via createRecordSession subject
 * resume (navigator path). Returns coordinates for the durable principal codec.
 *
 * `ledgerAnchorSessionFile` must live under the intended package home `.ak-roles`
 * tree so createRecordSession path-derives the correct ledger home (ADR 0048).
 * Subject placement still lands at book/kind/digest — anchor is not the nest.
 *
 * `resumed` comes only from the archivist open fact — no parallel existsSync.
 */
export async function openTicketSeatMemoryCoordinates(input: {
  readonly ticketNumber: number;
  readonly seat: TicketSeatMemorySeat;
  readonly cwd: string;
  readonly ledgerAnchorSessionFile: string;
}): Promise<DurablePrincipalCoordinates & { readonly resumed: boolean }> {
  const createRecordSessionOpen = await loadCreateRecordSessionOpen();
  const opened = createRecordSessionOpen({
    cwd: input.cwd,
    kind: TICKET_SEAT_MEMORY_KIND,
    subject: ticketSeatMemorySubject(input.ticketNumber, input.seat),
    parent: {
      getSessionFile: () => input.ledgerAnchorSessionFile,
    },
  });
  const sessionFile = opened.session.getSessionFile();
  const sessionDirectory = opened.session.getSessionDir();
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
  return { sessionDirectory, sessionFile, resumed: opened.resumed };
}

export type TicketSeatMemoryRebindResult = {
  readonly coordinates: DurablePrincipalCoordinates;
  /** True when the nest already existed — callers must send continuation.kind=resume. */
  readonly resumed: boolean;
};

/**
 * Rebind an admitted public officer run onto the ticket+seat memory principal.
 * Run directory (admitted-request / attachments / artifacts) stays independent;
 * only the logical memory principal continues across runs (#636 / ADR 0079).
 *
 * Host authority seals coordinates (no public-layer principal forgery).
 * Page rewrite: missing page (ENOENT) is lawful skip; other failures propagate.
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
}): Promise<TicketSeatMemoryRebindResult | undefined> {
  const ticketNumber = input.admitted.ticketNumber;
  if (ticketNumber === undefined) return undefined;

  // Anchor under the already-issued run principal so ledger home path-derives
  // from the package home that issued admission (never ambient passwd home).
  const anchor = input.principalAuthority.decode(input.admitted.principal);
  const opened = await openTicketSeatMemoryCoordinates({
    ticketNumber,
    seat: input.seat,
    cwd: input.admitted.projectRoot,
    ledgerAnchorSessionFile: anchor.sessionFile,
  });
  const coordinates: DurablePrincipalCoordinates = {
    sessionDirectory: opened.sessionDirectory,
    sessionFile: opened.sessionFile,
  };
  const principal = input.principalAuthority.seal(coordinates);
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
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Missing page is lawful for some seats; skip.
        continue;
      }
      throw error;
    }
  }
  return { coordinates, resumed: opened.resumed };
}

const TICKET_SEAT_LAST_HOST_FILE = "last-host.json";

export type TicketSeatMemoryLastHost = {
  readonly host: string;
  /**
   * Established Grok native isolation run (GROK_HOME parent) when Grok has run on this nest.
   * Preserved across non-Grok hosts so same-host retry and return-to-Grok reopen the same home.
   * Absent until a Grok turn records ownership.
   */
  readonly runDirectory?: string;
};

/** Read the last host that wrote the ticket-seat memory nest (#617 DK-4 / #636). */
export async function readTicketSeatMemoryLastHost(
  sessionDirectory: string,
): Promise<TicketSeatMemoryLastHost | undefined> {
  try {
    const raw = JSON.parse(
      await readFile(join(sessionDirectory, TICKET_SEAT_LAST_HOST_FILE), "utf8"),
    ) as unknown;
    if (
      raw === null ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      typeof (raw as { host?: unknown }).host !== "string" ||
      (raw as { host: string }).host.length === 0
    ) {
      throw new Error(
        `ticket-seat memory last-host page is damaged under ${sessionDirectory}`,
      );
    }
    const host = (raw as { host: string }).host;
    const runDirectory = (raw as { runDirectory?: unknown }).runDirectory;
    return {
      host,
      ...(typeof runDirectory === "string" && runDirectory.length > 0
        ? { runDirectory }
        : {}),
    };
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

/** Persist the host that just wrote the ticket-seat memory nest. */
export async function writeTicketSeatMemoryLastHost(
  sessionDirectory: string,
  host: string,
  runDirectory?: string,
): Promise<void> {
  if (host.trim() === "") {
    throw new Error("ticket-seat memory last-host requires a non-empty host");
  }
  const body: TicketSeatMemoryLastHost = {
    host,
    ...(runDirectory !== undefined && runDirectory.length > 0
      ? { runDirectory }
      : {}),
  };
  await writeFile(
    join(sessionDirectory, TICKET_SEAT_LAST_HOST_FILE),
    `${JSON.stringify(body, null, 2)}\n`,
    "utf8",
  );
}
