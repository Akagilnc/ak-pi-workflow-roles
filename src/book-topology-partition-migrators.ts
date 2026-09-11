import type { BookTopologyPartitionMigrator } from "./book-topology-migration.ts";
import { bookTopologyRunsMigrator } from "./book-topology-runs-migrator.ts";

/**
 * One assembly point for the independently implemented legacy partitions.
 * #865–#868 populate this list; the orchestrator refuses an empty migration.
 */
export const BOOK_TOPOLOGY_PARTITION_MIGRATORS: readonly BookTopologyPartitionMigrator[] = [
  bookTopologyRunsMigrator,
];
