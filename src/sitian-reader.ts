/**
 * Sitian Reader kernel (ADR 0068 / #520 r8).
 * Sole authoritative read path for canonical Sitian records.
 * Traversal contract:
 * - Malformed lines are exposed as typed malformed diagnostics and traversal continues.
 * - Zero whitewashing, zero deduplication.
 * - Canonical rows after malformed lines are always reachable.
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import type {
  SitianMalformedDiagnostic,
  SitianReadResult,
  SitianRecord,
} from "./sitian-contracts.ts";

import { isRecord, errorText } from "./unknown-value.ts";

/**
 * Sole decoder for one Sitian JSONL volume's text. Sync so the run-dossier
 * renderer and the async file reader share one implementation.
 */
export function parseSitianRecordText(text: string): SitianReadResult {
  const lines = text.split("\n");
  const records: SitianRecord[] = [];
  const diagnostics: SitianMalformedDiagnostic[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (!line.trim()) continue;

    try {
      const parsed = JSON.parse(line);
      if (isRecord(parsed)) {
        records.push(parsed as unknown as SitianRecord);
      } else {
        const typeDesc = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
        diagnostics.push({
          kind: "malformed",
          line: index + 1,
          raw: line,
          error: `expected JSON object, got ${typeDesc}`,
        });
      }
    } catch (error) {
      diagnostics.push({
        kind: "malformed",
        line: index + 1,
        raw: line,
        error: errorText(error),
      });
    }
  }

  return { records, diagnostics };
}

/** Read a Sitian record volume with full traversal and non-destructive diagnostics. */
export async function readSitianRecords(recordFile: string): Promise<SitianReadResult> {
  if (!existsSync(recordFile)) {
    return { records: [], diagnostics: [] };
  }
  return parseSitianRecordText(await readFile(recordFile, "utf8"));
}
