/**
 * Sum assistant-message usage rows from a session.jsonl (nested public summons).
 * Accumulates real cost when rows carry it; never invents cost zeros (#675).
 */
import type { Usage } from "@earendil-works/pi-ai";
import { join } from "node:path";

import type { PublicSummonResult } from "./public-role-summons.ts";

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
  let costInput = 0;
  let costOutput = 0;
  let costCacheRead = 0;
  let costCacheWrite = 0;
  let costTotal = 0;
  let sawCost = false;
  for (const row of rows) {
    if (row.type !== "message" || row.message?.role !== "assistant") continue;
    const usage = row.message.usage;
    if (usage === undefined) continue;
    total += usage.totalTokens ?? 0;
    input += usage.input ?? 0;
    output += usage.output ?? 0;
    cacheRead += usage.cacheRead ?? 0;
    cacheWrite += usage.cacheWrite ?? 0;
    if (usage.cost !== undefined) {
      sawCost = true;
      costInput += usage.cost.input ?? 0;
      costOutput += usage.cost.output ?? 0;
      costCacheRead += usage.cost.cacheRead ?? 0;
      costCacheWrite += usage.cost.cacheWrite ?? 0;
      costTotal += usage.cost.total ?? 0;
    }
  }
  if (total <= 0 && input <= 0 && output <= 0) return undefined;
  const base = {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: total > 0 ? total : input + output + cacheRead + cacheWrite,
  };
  // Cost only when session rows carried it — unknown stays absent (not zero).
  if (!sawCost) return base as Usage;
  return {
    ...base,
    cost: {
      input: costInput,
      output: costOutput,
      cacheRead: costCacheRead,
      cacheWrite: costCacheWrite,
      total: costTotal,
    },
  };
}

/**
 * Resolve the independent role run's session.jsonl from a public summon result.
 * Prefers explicit runDirectory, then terminal artifacts, then no_receipt runPointer.
 */
export function sessionFileFromPublicSummon(
  summoned: PublicSummonResult,
): string | undefined {
  if (typeof summoned.runDirectory === "string" && summoned.runDirectory.trim() !== "") {
    return join(summoned.runDirectory, "session", "session.jsonl");
  }
  const fromArtifacts = summoned.terminal?.artifacts
    ?.map((a) => (a as { path?: string }).path)
    .find((p): p is string => typeof p === "string" && p.endsWith("session.jsonl"));
  if (fromArtifacts !== undefined) return fromArtifacts;
  const outcome = summoned.terminal?.roleOutcome;
  if (outcome === undefined) return undefined;
  const facts = (outcome as { decisiveFacts?: Record<string, unknown> }).decisiveFacts;
  const pointer = facts?.runPointer;
  if (typeof pointer === "string" && pointer.trim() !== "") {
    return join(pointer, "session", "session.jsonl");
  }
  return undefined;
}

/** Shared usage projection for nested public summons — undefined when unknown. */
export async function usageFromPublicSummon(
  summoned: PublicSummonResult,
): Promise<Usage | undefined> {
  const sessionFile = sessionFileFromPublicSummon(summoned);
  if (sessionFile === undefined) return undefined;
  return readAssistantUsageFromSessionFile(sessionFile);
}
