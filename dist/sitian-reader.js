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
function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}
/** Read a Sitian record volume with full traversal and non-destructive diagnostics. */
export async function readSitianRecords(recordFile) {
    if (!existsSync(recordFile)) {
        return { records: [], diagnostics: [] };
    }
    const text = await readFile(recordFile, "utf8");
    const lines = text.split("\n");
    const records = [];
    const diagnostics = [];
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (!line.trim())
            continue;
        try {
            const parsed = JSON.parse(line);
            if (isRecord(parsed)) {
                records.push(parsed);
            }
            else {
                const typeDesc = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
                diagnostics.push({
                    kind: "malformed",
                    line: index + 1,
                    raw: line,
                    error: `expected JSON object, got ${typeDesc}`,
                });
            }
        }
        catch (error) {
            diagnostics.push({
                kind: "malformed",
                line: index + 1,
                raw: line,
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }
    return { records, diagnostics };
}
