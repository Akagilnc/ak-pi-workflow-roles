import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import {
  activationBookDirectory,
  activationWaitingLedgerPath,
  appendActivationLedgerJsonlLine,
  appendDispatchStubFact,
} from "./activation-ledger.ts";
import { buildDispatchStubFact } from "./activation-reconciliation.ts";
import {
  errnoCode,
  errorText,
  ensureRealDirectoryTree,
} from "./activation-ledger-topology.ts";

/** Positive integer GitHub/issue identity. Independent of correlation. */
export type TicketIdentity = number;

/** Opaque nonempty site string supplied by the dispatcher. Equality only. */
export type SiteIdentity = string;

export const TICKET_BINDING_EVENT = "ticket-binding" as const;

export const DISPATCH_LEASE_PENDING_FILE = "dispatch-lease.json" as const;

export type PendingTicketDispatchLease = {
  readonly ticketNumber: TicketIdentity;
  readonly bookKey: string;
  readonly siteIdentity: SiteIdentity;
  readonly offeredAt: string;
};

export type TicketBindingDispatchFact = {
  readonly event: typeof TICKET_BINDING_EVENT;
  readonly observedAt: string;
  readonly bookKey: string;
  readonly siteIdentity: SiteIdentity;
  readonly ticketNumber: TicketIdentity;
  readonly correlation: { readonly kind: "caller"; readonly id: string };
};

export type ClaimedTicketDispatchLease = {
  readonly ticketNumber: TicketIdentity;
  readonly bookKey: string;
  readonly siteIdentity: SiteIdentity;
  readonly correlationId: string;
};

export class TicketDispatchLeaseError extends Error {
  readonly code: string = "AK_TICKET_DISPATCH_LEASE";
  constructor(message: string, options?: { cause?: unknown }) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "TicketDispatchLeaseError";
  }
}

/** No pending lease in the book's unique slot. */
export class TicketDispatchLeaseMissingError extends TicketDispatchLeaseError {
  override readonly code = "AK_TICKET_DISPATCH_LEASE_MISSING" as const;
  constructor(message = "no ticket dispatch lease pending for this book", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TicketDispatchLeaseMissingError";
  }
}

/** Pending lease already exists, or another claimer already consumed it. */
export class TicketDispatchLeaseHeldError extends TicketDispatchLeaseError {
  override readonly code = "AK_TICKET_DISPATCH_LEASE_HELD" as const;
  constructor(
    message = "ticket dispatch lease is held or not unique",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TicketDispatchLeaseHeldError";
  }
}

/** Claim siteIdentity is not equal to the offered site. */
export class TicketDispatchLeaseSiteMismatchError extends TicketDispatchLeaseError {
  override readonly code = "AK_TICKET_DISPATCH_LEASE_SITE_MISMATCH" as const;
  constructor(
    message = "ticket dispatch lease siteIdentity does not match claimer",
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TicketDispatchLeaseSiteMismatchError";
  }
}

export class TicketRunAttributionError extends Error {
  readonly code = "AK_TICKET_RUN_ATTRIBUTION" as const;
  readonly kind: "ambiguous" | "unbound";
  constructor(
    kind: "ambiguous" | "unbound",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(
      message,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = "TicketRunAttributionError";
    this.kind = kind;
  }
}

function requirePositiveTicketNumber(ticketNumber: number): TicketIdentity {
  if (!Number.isInteger(ticketNumber) || ticketNumber < 1) {
    throw new TicketDispatchLeaseError(
      `ticketNumber must be a positive integer, got ${String(ticketNumber)}`,
    );
  }
  return ticketNumber;
}

function requireNonemptyString(value: string, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TicketDispatchLeaseError(`${label} must be a nonempty string`);
  }
  return value;
}

function pendingLeasePath(ledgerHome: string, bookKey: string): string {
  return join(activationBookDirectory(ledgerHome, bookKey), DISPATCH_LEASE_PENDING_FILE);
}

/** Unique per-claim path so acquire and read bind the same object; never a shared sidecar. */
function exclusiveClaimPath(ledgerHome: string, bookKey: string, claimToken: string): string {
  return join(
    activationBookDirectory(ledgerHome, bookKey),
    `dispatch-lease.claimed.${claimToken}.json`,
  );
}

export function buildTicketBindingDispatchFact(input: {
  readonly observedAt: string;
  readonly bookKey: string;
  readonly siteIdentity: SiteIdentity;
  readonly ticketNumber: TicketIdentity;
  readonly correlation: { readonly kind: "caller"; readonly id: string };
}): TicketBindingDispatchFact {
  return {
    event: TICKET_BINDING_EVENT,
    observedAt: input.observedAt,
    bookKey: input.bookKey,
    siteIdentity: input.siteIdentity,
    ticketNumber: input.ticketNumber,
    correlation: { kind: "caller", id: input.correlation.id },
  };
}

function parsePendingLease(raw: string, sourcePath: string): PendingTicketDispatchLease {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new TicketDispatchLeaseError(
      `ticket dispatch lease is not valid JSON (${sourcePath}): ${errorText(error)}`,
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TicketDispatchLeaseError(
      `ticket dispatch lease body is not an object (${sourcePath})`,
    );
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.ticketNumber !== "number") {
    throw new TicketDispatchLeaseError(
      `ticket dispatch lease ticketNumber is missing (${sourcePath})`,
    );
  }
  if (typeof record.bookKey !== "string" || record.bookKey.length === 0) {
    throw new TicketDispatchLeaseError(
      `ticket dispatch lease bookKey is missing (${sourcePath})`,
    );
  }
  if (typeof record.siteIdentity !== "string" || record.siteIdentity.length === 0) {
    throw new TicketDispatchLeaseError(
      `ticket dispatch lease siteIdentity is missing (${sourcePath})`,
    );
  }
  if (typeof record.offeredAt !== "string" || record.offeredAt.length === 0) {
    throw new TicketDispatchLeaseError(
      `ticket dispatch lease offeredAt is missing (${sourcePath})`,
    );
  }
  return {
    ticketNumber: requirePositiveTicketNumber(record.ticketNumber),
    bookKey: record.bookKey,
    siteIdentity: record.siteIdentity,
    offeredAt: record.offeredAt,
  };
}

/** Parse one waiting.jsonl row as a closed ticket-binding fact (or undefined). */
export function parseTicketBindingFact(value: unknown): TicketBindingDispatchFact | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (record.event !== TICKET_BINDING_EVENT) return undefined;
  if (typeof record.observedAt !== "string" || record.observedAt.length === 0) {
    return undefined;
  }
  if (typeof record.bookKey !== "string" || record.bookKey.length === 0) {
    return undefined;
  }
  if (typeof record.siteIdentity !== "string" || record.siteIdentity.length === 0) {
    return undefined;
  }
  if (typeof record.ticketNumber !== "number" || !Number.isInteger(record.ticketNumber) || record.ticketNumber < 1) {
    return undefined;
  }
  const correlation = record.correlation;
  if (correlation === null || typeof correlation !== "object" || Array.isArray(correlation)) {
    return undefined;
  }
  const corr = correlation as Record<string, unknown>;
  if (corr.kind !== "caller" || typeof corr.id !== "string" || corr.id.length === 0) {
    return undefined;
  }
  return {
    event: TICKET_BINDING_EVENT,
    observedAt: record.observedAt,
    bookKey: record.bookKey,
    siteIdentity: record.siteIdentity,
    ticketNumber: record.ticketNumber,
    correlation: { kind: "caller", id: corr.id },
  };
}

/**
 * Offer the book's unique one-shot pending dispatch lease.
 * At most one pending slot per book (wx create). EEXIST is held/not unique.
 */
export function offerTicketDispatchLease(options: {
  readonly ledgerHome: string;
  readonly bookKey: string;
  readonly siteIdentity: SiteIdentity;
  readonly ticketNumber: TicketIdentity;
  readonly now?: Date;
}): void {
  const bookKey = requireNonemptyString(options.bookKey, "bookKey");
  const siteIdentity = requireNonemptyString(options.siteIdentity, "siteIdentity");
  const ticketNumber = requirePositiveTicketNumber(options.ticketNumber);
  const bookDir = activationBookDirectory(options.ledgerHome, bookKey);
  ensureRealDirectoryTree(options.ledgerHome, bookDir);
  const pendingPath = pendingLeasePath(options.ledgerHome, bookKey);
  const body: PendingTicketDispatchLease = {
    ticketNumber,
    bookKey,
    siteIdentity,
    offeredAt: (options.now ?? new Date()).toISOString(),
  };
  const bytes = Buffer.from(`${JSON.stringify(body)}\n`, "utf8");
  let fd: number | undefined;
  let primaryFailure: unknown;
  try {
    try {
      fd = openSync(pendingPath, "wx", 0o644);
    } catch (error) {
      if (errnoCode(error) === "EEXIST") {
        throw new TicketDispatchLeaseHeldError(
          `pending ticket dispatch lease already exists for book ${bookKey}`,
          { cause: error },
        );
      }
      throw new TicketDispatchLeaseError(
        `failed to offer ticket dispatch lease (${pendingPath}): ${errorText(error)}`,
        { cause: error },
      );
    }
    const written = writeSync(fd, bytes, 0, bytes.length, null);
    if (written !== bytes.length) {
      throw new TicketDispatchLeaseError(
        `ticket dispatch lease short write: wrote ${written} of ${bytes.length} bytes to ${pendingPath}`,
      );
    }
  } catch (error) {
    primaryFailure = error;
  }
  if (fd !== undefined) {
    try {
      closeSync(fd);
    } catch (closeFailure) {
      if (primaryFailure !== undefined) {
        throw new AggregateError(
          [primaryFailure, closeFailure],
          "ticket dispatch lease offer and close failed",
          { cause: primaryFailure },
        );
      }
      throw closeFailure;
    }
  }
  if (primaryFailure !== undefined) throw primaryFailure;
}

/**
 * Put an exclusively-owned claim body back into the pending slot only when the
 * slot is empty. Never rename-over: a concurrent offer may already occupy pending.
 * Returns whether the body was restored; either way the claimer must treat the
 * site as mismatched. Leftover claimed files remain crash-orphans (never shared).
 */
function restoreExclusiveClaimToPendingSlot(options: {
  readonly pendingPath: string;
  readonly raw: string;
}): "restored" | "slot-occupied" {
  const bytes = Buffer.from(options.raw, "utf8");
  let fd: number | undefined;
  try {
    fd = openSync(options.pendingPath, "wx", 0o644);
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      return "slot-occupied";
    }
    throw new TicketDispatchLeaseError(
      `failed to restore ticket dispatch lease to pending (${options.pendingPath}): ${errorText(error)}`,
      { cause: error },
    );
  }
  try {
    const written = writeSync(fd, bytes, 0, bytes.length, null);
    if (written !== bytes.length) {
      throw new TicketDispatchLeaseError(
        `ticket dispatch lease restore short write: wrote ${written} of ${bytes.length} bytes to ${options.pendingPath}`,
      );
    }
  } finally {
    closeSync(fd);
  }
  return "restored";
}

/**
 * Atomically claim the book's pending lease. Acquire and read bind the same
 * exclusive object (rename pending → unique claim path, then read that path).
 * Generates an opaque correlation, appends ticket-binding + dispatch-stub onto
 * waiting.jsonl, and empties the slot. Resume must not call this.
 *
 * Crash ownership: a leftover unique claim file is orphaned and never blocks the
 * next claim (no shared sidecar, no recovery protocol).
 *
 * Site-mismatch restore never rename-overwrites pending: a concurrent offer may
 * fill the slot after exclusive acquire; restore uses wx and leaves that offer.
 */
export function claimTicketDispatchLease(options: {
  readonly ledgerHome: string;
  readonly bookKey: string;
  readonly siteIdentity: SiteIdentity;
  readonly createCorrelationId?: () => string;
  readonly pid?: number;
  readonly now?: Date;
}): ClaimedTicketDispatchLease {
  const bookKey = requireNonemptyString(options.bookKey, "bookKey");
  const siteIdentity = requireNonemptyString(options.siteIdentity, "siteIdentity");
  const pendingPath = pendingLeasePath(options.ledgerHome, bookKey);
  const claimToken = randomUUID();
  const claimedPath = exclusiveClaimPath(options.ledgerHome, bookKey, claimToken);

  try {
    renameSync(pendingPath, claimedPath);
  } catch (error) {
    if (errnoCode(error) === "ENOENT") {
      throw new TicketDispatchLeaseMissingError(
        `no ticket dispatch lease pending for book ${bookKey}`,
        { cause: error },
      );
    }
    throw new TicketDispatchLeaseError(
      `failed to claim ticket dispatch lease (${pendingPath}): ${errorText(error)}`,
      { cause: error },
    );
  }

  try {
    let raw: string;
    try {
      raw = readFileSync(claimedPath, "utf8");
    } catch (error) {
      throw new TicketDispatchLeaseError(
        `failed to read claimed ticket dispatch lease (${claimedPath}): ${errorText(error)}`,
        { cause: error },
      );
    }
    const pending = parsePendingLease(raw, claimedPath);
    if (pending.bookKey !== bookKey) {
      throw new TicketDispatchLeaseError(
        `ticket dispatch lease bookKey mismatch for book ${bookKey}`,
      );
    }
    if (pending.siteIdentity !== siteIdentity) {
      // Exclusive restore only. POSIX rename would clobber a newer offer that
      // filled the pending slot after we acquired this exclusive object.
      restoreExclusiveClaimToPendingSlot({
        pendingPath,
        raw,
      });
      throw new TicketDispatchLeaseSiteMismatchError(
        `ticket dispatch lease siteIdentity does not match claimer for book ${bookKey}`,
      );
    }

    const correlationId = (options.createCorrelationId ?? randomUUID)();
    if (typeof correlationId !== "string" || correlationId.length === 0) {
      throw new TicketDispatchLeaseError("claimed correlation id must be a nonempty string");
    }
    const observedAt = (options.now ?? new Date()).toISOString();
    const binding = buildTicketBindingDispatchFact({
      observedAt,
      bookKey,
      siteIdentity: pending.siteIdentity,
      ticketNumber: pending.ticketNumber,
      correlation: { kind: "caller", id: correlationId },
    });
    const waitingPath = activationWaitingLedgerPath(options.ledgerHome, bookKey);
    appendActivationLedgerJsonlLine(waitingPath, binding, {
      ledgerHome: options.ledgerHome,
    });
    appendDispatchStubFact(
      waitingPath,
      buildDispatchStubFact({
        observedAt,
        bookKey,
        dispatch: { kind: "process", pid: options.pid ?? process.pid },
        correlation: { kind: "caller", id: correlationId },
      }),
      { ledgerHome: options.ledgerHome },
    );
    return {
      ticketNumber: pending.ticketNumber,
      bookKey,
      siteIdentity: pending.siteIdentity,
      correlationId,
    };
  } finally {
    try {
      unlinkSync(claimedPath);
    } catch {
      // Exclusive claim file is ours only. Already restored to pending on site mismatch,
      // or leftover on crash — never a shared sidecar that blocks the next claim.
    }
  }
}

function readWaitingJsonlLines(waitingPath: string): unknown[] {
  let text: string;
  try {
    text = readFileSync(waitingPath, "utf8");
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return [];
    throw error;
  }
  const rows: unknown[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Skip malformed lines honestly; do not guess tickets from them.
      continue;
    }
  }
  return rows;
}

/** Scan waiting.jsonl for closed ticket-binding facts. Never infers tickets from other events. */
export function listTicketBindingFacts(
  ledgerHome: string,
  bookKey: string,
): TicketBindingDispatchFact[] {
  const waitingPath = activationWaitingLedgerPath(ledgerHome, bookKey);
  const facts: TicketBindingDispatchFact[] = [];
  for (const row of readWaitingJsonlLines(waitingPath)) {
    const fact = parseTicketBindingFact(row);
    if (fact !== undefined) facts.push(fact);
  }
  return facts;
}

/** Shared waiting.jsonl scan used by trajectory join (book dir is ledgerDir). */
export function listTicketBindingFactsFromBookDir(
  ledgerDir: string,
): TicketBindingDispatchFact[] {
  const waitingPath = join(ledgerDir, "waiting.jsonl");
  const facts: TicketBindingDispatchFact[] = [];
  for (const row of readWaitingJsonlLines(waitingPath)) {
    const fact = parseTicketBindingFact(row);
    if (fact !== undefined) facts.push(fact);
  }
  return facts;
}

export function readWaitingJsonlRecords(waitingPath: string): unknown[] {
  return readWaitingJsonlLines(waitingPath);
}

/** One-shot book-level waiting.jsonl scan for trajectory join reuse. */
export function loadBookWaitingRecords(ledgerDir: string): unknown[] {
  return readWaitingJsonlLines(join(ledgerDir, "waiting.jsonl"));
}
