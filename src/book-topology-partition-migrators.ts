import { BOOK_TOPOLOGY_MIXED_VOLUME_MIGRATORS } from "./book-topology-mixed-volume-migrators.ts";
import type { BookTopologyPartitionMigrator } from "./book-topology-migration.ts";
import { BOOK_TOPOLOGY_T11_MIGRATORS } from "./book-topology-migrators-t11.ts";
import { BOOK_TOPOLOGY_RECORD_CLASS_MIGRATORS } from "./book-topology-record-class-migrators.ts";
import { bookTopologyRunsMigrator } from "./book-topology-runs-migrator.ts";

/**
 * One assembly point for the independently implemented legacy partitions.
 * #865–#868 populate this list; the orchestrator refuses an empty migration.
 * #866 contributes record-class migrators (ticket-provenance / submission-ledger /
 * attempt-history / misplaced-record-class). Runs (#865) should precede run-owned
 * record classes when both are assembled.
 *
 * T11 (#867) registration order: auditor-roles, issues, deprecated-kinds,
 * deprecated-run-pages, navigator, collector-handbook, manual-archives.
 * auditor-roles prefers a run already placed by T9 when that nest exists.
 * deprecated-run-pages must run after the runs migrator (T9): it deletes
 * matching pages from already-placed destination runs.
 */
export const BOOK_TOPOLOGY_PARTITION_MIGRATORS: readonly BookTopologyPartitionMigrator[] = [
  bookTopologyRunsMigrator,
  ...BOOK_TOPOLOGY_RECORD_CLASS_MIGRATORS,
  ...BOOK_TOPOLOGY_T11_MIGRATORS,
  ...BOOK_TOPOLOGY_MIXED_VOLUME_MIGRATORS,
];
