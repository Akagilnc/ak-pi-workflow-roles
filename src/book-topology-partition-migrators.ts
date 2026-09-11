import type { BookTopologyPartitionMigrator } from "./book-topology-migration.ts";
import { BOOK_TOPOLOGY_RECORD_CLASS_MIGRATORS } from "./book-topology-record-class-migrators.ts";

/**
 * One assembly point for the independently implemented legacy partitions.
 * #865–#868 populate this list; the orchestrator refuses an empty migration.
 * #866 contributes record-class migrators (ticket-provenance / submission-ledger /
 * attempt-history / misplaced-record-class). Runs (#865) should precede run-owned
 * record classes when both are assembled.
 */
export const BOOK_TOPOLOGY_PARTITION_MIGRATORS: readonly BookTopologyPartitionMigrator[] = [
  ...BOOK_TOPOLOGY_RECORD_CLASS_MIGRATORS,
];
