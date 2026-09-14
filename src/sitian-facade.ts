/**
 * Sitian Facade (司天门面) — Sole entrypoint for record reporting across all producers.
 * ADR 0065 single record entry, #520 r8.
 *
 * Write paths:
 * - sitianReport → appender (SitianRecord rows, append + identity claim)
 * - rewriteSitianVolume → whole-file reproject (ticket-provenance bare lines, #901)
 * Read paths: readSitianRecords (canonical rows) / readSitianVolumeText (raw body).
 */
import { appendSitianRecord } from "./sitian-appender.ts";
import type { RecordPointer, SitianRecordInput } from "./sitian-contracts.ts";

export * from "./sitian-contracts.ts";
export * from "./sitian-appender.ts";
export * from "./sitian-reader.ts";
export * from "./sitian-volume.ts";

/**
 * Sole append API for Sitian canonical records.
 * Returns typed RecordPointer with durable record identity and readable file location.
 */
export function sitianReport(input: SitianRecordInput): RecordPointer {
  return appendSitianRecord(input);
}
