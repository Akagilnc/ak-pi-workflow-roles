/**
 * Sum assistant-message usage rows from a session.jsonl (nested public summons).
 */
import type { Usage } from "@earendil-works/pi-ai";

export async function readAssistantUsageFromSessionFile(
  sessionFile: string,
): Promise<Usage | undefined> {
  const { readFile } = await import("node:fs/promises");
  let text: string;
  try {
    text = await readFile(sessionFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw error;
  }
  let rows: Array<{ type?: string; message?: { role?: string; usage?: Usage } }>;
  try {
    rows = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as {
        type?: string;
        message?: { role?: string; usage?: Usage };
      });
  } catch (error) {
    throw new Error(
      `session usage parse failed (${sessionFile}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  let total = 0;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const row of rows) {
    if (row.type !== "message" || row.message?.role !== "assistant") continue;
    const usage = row.message.usage;
    if (usage === undefined) continue;
    total += usage.totalTokens ?? 0;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
  }
  if (total <= 0 && input <= 0 && output <= 0) return undefined;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: total > 0 ? total : input + output + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}
