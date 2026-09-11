import type { BookTopologyPartitionMigrator } from "./book-topology-migration.ts";
import { BOOK_TOPOLOGY_T11_MIGRATORS } from "./book-topology-migrators-t11.ts";

/**
 * One assembly point for the independently implemented legacy partitions.
 * #865–#868 populate this list; the orchestrator refuses an empty migration.
 *
 * T11 (#867) registration order: auditor-roles, issues, deprecated-kinds,
 * deprecated-run-pages, navigator, collector-handbook, manual-archives.
 * auditor-roles prefers a run already placed by T9 when that nest exists.
 * deprecated-run-pages must run after the runs migrator (T9): it scrubs
 * destination pages and exports copyRunDirectoryForMigration for T9 to use.
 */
export const BOOK_TOPOLOGY_PARTITION_MIGRATORS: readonly BookTopologyPartitionMigrator[] = [
  ...BOOK_TOPOLOGY_T11_MIGRATORS,
];
