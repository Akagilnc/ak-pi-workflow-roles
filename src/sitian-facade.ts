/**
 * Sitian Facade (司天门面) — Sole entrypoint for record reporting across all producers.
 * ADR 0065 single record entry, #520 r8.
 *
 * Write paths:
 * - sitianReport → appender (SitianRecord rows, append + identity claim)
 * Read paths: readSitianRecords (canonical rows).
 */
import { sessionFileOf } from "./role-run-placement.ts";
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

/**
 * One record of a role run: history.jsonl for the history kinds and state.jsonl for the
 * state kinds (see the appender), log.jsonl for the run's own diagnostics (host dossier pointers,
 * dispatch / resume / post-admission faults, host stderr). Same single entry
 * as every other record; the run is named, never a file path.
 */
export function reportRunRecord(
  runDirectory: string,
  kind: string,
  payload: unknown,
  source: string,
): RecordPointer {
  return appendSitianRecord({
    level: "event",
    kind,
    sessionParent: sessionFileOf(runDirectory),
    source,
    payload,
  });
}
