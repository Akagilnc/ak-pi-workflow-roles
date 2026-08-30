/**
 * Sitian Facade (司天门面) — Sole entrypoint for record reporting across all producers.
 * ADR 0065 single record entry, #520 r8.
 */
import { appendSitianRecord } from "./sitian-appender.ts";
import type { RecordPointer, SitianRecordInput } from "./sitian-contracts.ts";

export * from "./sitian-contracts.ts";
export * from "./sitian-appender.ts";
export * from "./sitian-reader.ts";

/**
 * Sole write API for Sitian canonical records.
 * Returns typed RecordPointer with durable record identity and readable file location.
 */
export function sitianReport(input: SitianRecordInput): RecordPointer {
  return appendSitianRecord(input);
}
