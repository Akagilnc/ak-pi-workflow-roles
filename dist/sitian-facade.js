/**
 * Sitian Facade (司天门面) — Sole entrypoint for record reporting across all producers.
 * ADR 0065 single record entry, #520 r8.
 */
import { appendSitianRecord } from "./sitian-appender.js";
export * from "./sitian-contracts.js";
export * from "./sitian-appender.js";
export * from "./sitian-reader.js";
/**
 * Sole write API for Sitian canonical records.
 * Returns typed RecordPointer with durable record identity and readable file location.
 */
export function sitianReport(input) {
    return appendSitianRecord(input);
}
