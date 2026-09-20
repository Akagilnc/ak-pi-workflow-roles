import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { migrateBookTopology } from "../src/book-topology-migration.ts";
import { BOOK_TOPOLOGY_PARTITION_MIGRATORS } from "../src/book-topology-partition-migrators.ts";
import { relocateBoardBoundUnboundRunsInBooks } from "../src/book-topology-runs-migrator.ts";

const USAGE =
  "usage: node dist/migrate-book-topology.js [--ledger-home <path>]\n" +
  "       node dist/migrate-book-topology.js --relocate-board-bound-unbound [--ledger-home <path>]";

function parseMigrateArgv(argv: readonly string[]): {
  readonly relocateBoardBoundUnbound: boolean;
  readonly ledgerHome: string | undefined;
} {
  let relocateBoardBoundUnbound = false;
  let ledgerHome: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--relocate-board-bound-unbound") {
      relocateBoardBoundUnbound = true;
      continue;
    }
    if (arg === "--ledger-home") {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(USAGE);
      ledgerHome = resolve(value);
      i += 1;
      continue;
    }
    throw new Error(USAGE);
  }
  return { relocateBoardBoundUnbound, ledgerHome };
}

const parsed = parseMigrateArgv(process.argv.slice(2));
if (parsed.relocateBoardBoundUnbound) {
  // #863 stock: already-migrated trees — in-place unbound→ticket via shared seam.
  const ledgerHome = parsed.ledgerHome ?? join(homedir(), ".ak-roles");
  const report = await relocateBoardBoundUnboundRunsInBooks(
    join(ledgerHome, "books"),
    process.env,
    (diagnostic) => {
      process.stderr.write(diagnostic);
    },
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        ledgerHome,
        relocatedCount: report.relocated.length,
        relocated: report.relocated,
        mutationClosureRuns: report.mutationClosureRuns,
      },
      null,
      2,
    )}\n`,
  );
} else {
  const report = await migrateBookTopology({
    ledgerHome: parsed.ledgerHome,
    migrators: BOOK_TOPOLOGY_PARTITION_MIGRATORS,
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}
