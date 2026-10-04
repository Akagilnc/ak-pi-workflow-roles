/**
 * Sitian Reader kernel (ADR 0068 / #520 r8).
 * Sole authoritative read path for canonical Sitian records.
 * Traversal contract:
 * - Malformed lines are exposed as typed malformed diagnostics and traversal continues.
 * - Zero whitewashing, zero deduplication.
 * - Canonical rows after malformed lines are always reachable.
 */
import { readFile } from "node:fs/promises";

import type {
  SitianMalformedDiagnostic,
  SitianReadResult,
  SitianRecord,
} from "./sitian-contracts.ts";

import { isRecord, errorText, isEnoent } from "./unknown-value.ts";

/** One non-blank JSONL line through the sole Sitian decoder. Blank → undefined. */
export type SitianLineDecode =
  | { readonly ok: true; readonly record: SitianRecord }
  | { readonly ok: false; readonly diagnostic: SitianMalformedDiagnostic };

/**
 * Decode one Sitian JSONL line. Callers that must keep original bytes use this
 * with the source line; volume readers fold it into records + diagnostics.
 */
export function decodeSitianRecordLine(
  line: string,
  lineNumber: number,
): SitianLineDecode | undefined {
  if (!line.trim()) return undefined;
  try {
    const parsed = JSON.parse(line);
    if (isRecord(parsed)) {
      return { ok: true, record: parsed as unknown as SitianRecord };
    }
    const typeDesc = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
    return {
      ok: false,
      diagnostic: {
        kind: "malformed",
        line: lineNumber,
        raw: line,
        error: `expected JSON object, got ${typeDesc}`,
      },
    };
  } catch (error) {
    return {
      ok: false,
      diagnostic: {
        kind: "malformed",
        line: lineNumber,
        raw: line,
        error: errorText(error),
      },
    };
  }
}

/**
 * Sole decoder for one Sitian JSONL volume's text. Sync so the run-dossier
 * renderer and the async file reader share one implementation.
 */
export function parseSitianRecordText(text: string): SitianReadResult {
  const lines = text.split("\n");
  const records: SitianRecord[] = [];
  const diagnostics: SitianMalformedDiagnostic[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const decoded = decodeSitianRecordLine(lines[index]!, index + 1);
    if (decoded === undefined) continue;
    if (decoded.ok) records.push(decoded.record);
    else diagnostics.push(decoded.diagnostic);
  }

  return { records, diagnostics };
}

/** Read a Sitian record volume with full traversal and non-destructive diagnostics. */
export async function readSitianRecords(recordFile: string): Promise<SitianReadResult> {
  // Direct read: only ENOENT is absence. EACCES/EPERM and other IO keep their cause
  // (Node fs docs: do not existsSync/access before open — #1161 C3).
  try {
    return parseSitianRecordText(await readFile(recordFile, "utf8"));
  } catch (error) {
    if (isEnoent(error)) return { records: [], diagnostics: [] };
    throw error;
  }
}
