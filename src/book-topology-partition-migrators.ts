import { BOOK_TOPOLOGY_MIXED_VOLUME_MIGRATORS } from "./book-topology-mixed-volume-migrators.ts";
import type { BookTopologyPartitionMigrator } from "./book-topology-migration.ts";

/**
 * One assembly point for the independently implemented legacy partitions.
 * #865–#868 populate this list; the orchestrator refuses an empty migration.
 */
export const BOOK_TOPOLOGY_PARTITION_MIGRATORS: readonly BookTopologyPartitionMigrator[] = [
  ...BOOK_TOPOLOGY_MIXED_VOLUME_MIGRATORS,
];
