#!/usr/bin/env node
/**
 * Internal machine launcher entry (not a public bin; ADR 0052).
 *
 * The selecting machine already holds a board-selected ticket identity. This
 * entry derives bookKey + siteIdentity from the project root (cwd / --project,
 * same as ak-role) and starts the real offer → ak-role path. It does not accept
 * the human offer-only form --book/--site/--ticket.
 *
 * Usage (selecting machine supplies the snapshot issue number it already holds):
 *   npx tsx scripts/dispatch-selected-ticket-role.ts <ticketNumber> \
 *     [--project <site>] [--home <processHome>] -- <ak-role-args...>
 *
 * Example:
 *   npx tsx scripts/dispatch-selected-ticket-role.ts 176 --project /site -- \
 *     judge --project /site "Review the plan."
 */
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveBookKeyFromGit } from "../src/activation-ledger-git.ts";
import { resolveActivationLedgerHome } from "../src/activation-ledger-topology.ts";
import { dispatchSelectedTicketRole } from "../src/factory-board-ticket-dispatch.ts";

function usage(): never {
  console.error(`Usage: npx tsx scripts/dispatch-selected-ticket-role.ts <ticketNumber> [--project <site>] [--home <processHome>] -- <ak-role-args...>
  <ticketNumber>  board snapshot issue number already selected by the machine
  --project       site identity / ak-role project root (default: cwd)
  --home          process home for the activation ledger (default: homedir)
  --              end of launcher flags; remaining argv is forwarded to ak-role
`);
  process.exit(2);
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
if (sep < 0) usage();
const launcherArgv = argv.slice(0, sep);
const akRoleArgs = argv.slice(sep + 1);
if (akRoleArgs.length === 0) usage();

const ticketRaw = launcherArgv[0];
if (ticketRaw === undefined || ticketRaw.startsWith("-")) usage();
const ticketNumber = Number(ticketRaw);
if (!Number.isInteger(ticketNumber) || ticketNumber < 1) {
  console.error("ticketNumber must be a positive integer");
  process.exit(2);
}

function flag(name: string): string | undefined {
  const idx = launcherArgv.indexOf(name);
  if (idx < 0) return undefined;
  return launcherArgv[idx + 1];
}

const projectRaw = flag("--project");
const homeRaw = flag("--home");
const siteIdentity = resolve(projectRaw ?? process.cwd());
const home = homeRaw === undefined ? homedir() : homeRaw;
const ledgerHome = resolveActivationLedgerHome(() => home);
const bookKey = resolveBookKeyFromGit(siteIdentity);

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "..");
const defaultAkRole = resolve(packageRoot, "dist/public-cli/main.js");
const akRolePath = process.env.AK_ROLE_PATH?.trim() || defaultAkRole;

// Prefer PATH-resolved ak-role when present so installed seats match production.
const pathResolved = spawnSync("sh", ["-c", "command -v ak-role"], {
  encoding: "utf8",
  env: process.env,
});
const resolvedAkRole =
  pathResolved.status === 0 && pathResolved.stdout.trim().length > 0
    ? pathResolved.stdout.trim()
    : akRolePath;

try {
  const result = dispatchSelectedTicketRole({
    ledgerHome,
    bookKey,
    siteIdentity,
    ticketNumber,
    akRolePath: resolvedAkRole,
    akRoleArgs,
    env: process.env,
  });
  if (result.stdout.length > 0) process.stdout.write(result.stdout);
  if (result.stderr.length > 0) process.stderr.write(result.stderr);
  process.exit(result.status ?? 1);
} catch (error) {
  console.error(formatError(error));
  process.exit(1);
}
