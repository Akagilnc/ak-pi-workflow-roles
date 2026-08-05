#!/usr/bin/env node
/**
 * Internal entry for the single-ticket trajectory tracer (factory board S1).
 *
 * Not a public role CLI (ADR 0052). Not registered as a package bin.
 * Developers invoke via:
 *   npx tsx scripts/render-ticket-trajectory.ts \
 *     --ledger ~/.ak-roles/books/<book> \
 *     --issue 127 \
 *     --out /tmp/issue-127.html
 *
 * Optional --watch starts the production page lifecycle (regenerate on the
 * declared refresh boundary). Stop with Ctrl-C / SIGINT / SIGTERM.
 *
 * One-shot (default) writes a page that does NOT advertise refresh.
 * --watch writes a page that declares the bound and actually regenerates.
 *
 * Output MUST sit outside the ledger. The ledger is read-only.
 */
import { resolve } from "node:path";

import {
  DEFAULT_REFRESH_BOUNDARY_SECONDS,
  startTicketTrajectoryPage,
  writeTicketTrajectoryPage,
} from "../src/ticket-trajectory.ts";

function usage(): never {
  console.error(`Usage: npx tsx scripts/render-ticket-trajectory.ts --ledger <bookDir> --issue <n> --out <htmlPath> [--watch] [--refresh-seconds <n>]
  --ledger            家册 book directory (…/books/<book>)
  --issue             issue number
  --out               HTML output path (must be outside the ledger)
  --watch             keep regenerating within the refresh boundary until stopped
  --refresh-seconds   refresh boundary in seconds when --watch (default ${DEFAULT_REFRESH_BOUNDARY_SECONDS})
`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
}

function formatError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

const ledger = arg("--ledger");
const issueRaw = arg("--issue");
const out = arg("--out");
const watch = process.argv.includes("--watch");
const refreshRaw = arg("--refresh-seconds");
if (!ledger || !issueRaw || !out) usage();

const issueNumber = Number(issueRaw);
if (!Number.isInteger(issueNumber) || issueNumber < 1) {
  console.error("--issue must be a positive integer");
  process.exit(2);
}

const refreshBoundarySeconds =
  refreshRaw !== undefined ? Number(refreshRaw) : DEFAULT_REFRESH_BOUNDARY_SECONDS;
if (!(refreshBoundarySeconds > 0) || !Number.isFinite(refreshBoundarySeconds)) {
  console.error("--refresh-seconds must be a positive finite number");
  process.exit(2);
}

if (!watch) {
  // One-shot: no refresh declaration — page lifecycle matches actual behavior.
  const result = await writeTicketTrajectoryPage({
    ledgerDir: resolve(ledger),
    ticketSnapshot: { issueNumber },
    now: new Date(),
    outputPath: resolve(out),
  });
  console.error(`wrote ${result.outputPath}`);
  process.exit(0);
}

const handle = startTicketTrajectoryPage({
  ledgerDir: resolve(ledger),
  ticketSnapshot: { issueNumber },
  outputPath: resolve(out),
  refreshBoundarySeconds,
});

let exiting = false;
const exitOnce = (code: number): void => {
  if (exiting) return;
  exiting = true;
  process.exit(code);
};

// Post-start regeneration fault must terminate the process non-zero with cause.
void handle.closed.then(
  () => undefined,
  (error) => {
    console.error(formatError(error));
    exitOnce(1);
  },
);

try {
  const first = await handle.started;
  console.error(`wrote ${first.outputPath}; watching every ${refreshBoundarySeconds}s (stop with SIGINT)`);
} catch (error) {
  console.error(formatError(error));
  exitOnce(1);
}

const shutdown = async (signal: string) => {
  console.error(`stopping on ${signal}`);
  try {
    await handle.stop();
    exitOnce(0);
  } catch (error) {
    console.error(formatError(error));
    exitOnce(1);
  }
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
