#!/usr/bin/env node
import { resolve } from "node:path";

import { migrateBookTopology } from "../src/book-topology-migration.ts";
import { BOOK_TOPOLOGY_PARTITION_MIGRATORS } from "../src/book-topology-partition-migrators.ts";

function ledgerHomeFromArgv(argv: readonly string[]): string | undefined {
  if (argv.length === 0) return undefined;
  if (argv.length === 2 && argv[0] === "--ledger-home") return resolve(argv[1]);
  throw new Error("usage: tsx scripts/migrate-book-topology.ts [--ledger-home <path>]");
}

const report = await migrateBookTopology({
  ledgerHome: ledgerHomeFromArgv(process.argv.slice(2)),
  migrators: BOOK_TOPOLOGY_PARTITION_MIGRATORS,
});
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
