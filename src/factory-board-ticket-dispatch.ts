import { spawnSync } from "node:child_process";

import {
  offerTicketDispatchLease,
  type SiteIdentity,
  type TicketIdentity,
} from "./ticket-dispatch-lease.ts";

export type MachineTicketDispatchResult = {
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Real machine launcher for a board-selected ticket.
 *
 * The selecting process already holds typed ticket/book/site identity (board
 * snapshot issue number + ledger book + site equality string). This path:
 *   1) offers the book's unique one-shot dispatch lease, then
 *   2) starts `ak-role` at the site (real process; ak-role claims on admit).
 *
 * No separate human CLI channel may carry --book/--site/--ticket. Callers
 * without a selected ticket simply do not call this, and admit stays unbound.
 * Factory-board HTML render/watch must not call this (one pending slot per book).
 */
export function dispatchSelectedTicketRole(input: {
  readonly ledgerHome: string;
  readonly bookKey: string;
  readonly siteIdentity: SiteIdentity;
  readonly ticketNumber: TicketIdentity;
  readonly now?: Date;
  /** Absolute path to the ak-role executable (package bin or resolved PATH). */
  readonly akRolePath: string;
  /** Arguments passed to ak-role after the executable. */
  readonly akRoleArgs: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** stdin bytes for the child (ak-role/pi require closed stdin; default empty). */
  readonly stdin?: string;
}): MachineTicketDispatchResult {
  offerTicketDispatchLease({
    ledgerHome: input.ledgerHome,
    bookKey: input.bookKey,
    siteIdentity: input.siteIdentity,
    ticketNumber: input.ticketNumber,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  const result = spawnSync(input.akRolePath, [...input.akRoleArgs], {
    cwd: input.siteIdentity,
    env: input.env,
    encoding: "utf8",
    input: input.stdin ?? "",
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (result.error) {
    throw result.error;
  }
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}
