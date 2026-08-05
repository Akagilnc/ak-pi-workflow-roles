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
 * Output MUST sit outside the ledger. The ledger is read-only.
 */
import { resolve } from "node:path";

import { writeTicketTrajectoryPage } from "../src/ticket-trajectory.ts";

function usage(): never {
  console.error(`Usage: npx tsx scripts/render-ticket-trajectory.ts --ledger <bookDir> --issue <n> --out <htmlPath>
  --ledger   家册 book directory (…/books/<book>)
  --issue    issue number
  --out      HTML output path (must be outside the ledger)
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
if (!ledger || !issueRaw || !out) usage();

const issueNumber = Number(issueRaw);
if (!Number.isInteger(issueNumber) || issueNumber < 1) {
  console.error("--issue must be a positive integer");
  process.exit(2);
}

const result = await writeTicketTrajectoryPage({
  ledgerDir: resolve(ledger),
  ticketSnapshot: { issueNumber },
  now: new Date(),
  outputPath: resolve(out),
});

console.error(`wrote ${result.outputPath}`);
