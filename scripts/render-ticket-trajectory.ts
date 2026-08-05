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
  --refresh-seconds   refresh boundary in seconds (default ${DEFAULT_REFRESH_BOUNDARY_SECONDS})
`);
  process.exit(2);
}

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(name);
  if (idx < 0) return undefined;
  return process.argv[idx + 1];
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
  const result = await writeTicketTrajectoryPage({
    ledgerDir: resolve(ledger),
    ticketSnapshot: { issueNumber },
    now: new Date(),
    outputPath: resolve(out),
    refreshBoundarySeconds,
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

const first = await handle.started;
console.error(`wrote ${first.outputPath}; watching every ${refreshBoundarySeconds}s (stop with SIGINT)`);

const shutdown = async (signal: string) => {
  console.error(`stopping on ${signal}`);
  await handle.stop();
  process.exit(0);
};

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});
process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
