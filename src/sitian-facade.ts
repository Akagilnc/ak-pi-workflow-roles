/**
 * Sitian Facade (司天门面) — Sole entrypoint for record reporting across all producers.
 * ADR 0065 single record entry, #520 r8.
 *
 * Write paths:
 * - sitianReport → appender (SitianRecord rows, append + identity claim)
 * Read paths: readSitianRecords (canonical rows).
 */
import { appendSitianRecord } from "./sitian-appender.ts";
import type { RecordPointer, SitianRecordInput } from "./sitian-contracts.ts";

export * from "./sitian-contracts.ts";
export * from "./sitian-appender.ts";
export * from "./sitian-reader.ts";

/**
 * Sole append API for Sitian canonical records.
 * Returns typed RecordPointer with durable record identity and readable file location.
 */
export function sitianReport(input: SitianRecordInput): RecordPointer {
  return appendSitianRecord(input);
}
