/**
 * Single authority for #617 DK-4 cross-host prior-native projection.
 * Classifies the prior volume into the two record families that exist
 * (Pi native session file / sitian run records), never by host name.
 */
import { access, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RoleTurnHostTransition } from "./host-contracts.ts";

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Present Pi native session path, or empty when ENOENT. */
async function listPiNativeRecordPaths(sessionFile: string): Promise<string[]> {
  try {
    await access(sessionFile);
    return [sessionFile];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

/**
 * Present sitian records.jsonl paths under sessionParent topology (#717).
 * resolveSitianRecordPathInLedger writes dirname(sessionParent)/<category>/records.jsonl
 * when sessionParent is inside ledger home — never session.jsonl itself.
 */
async function listSitianRecordPaths(sessionParent: string): Promise<string[]> {
  const sessionRoot = dirname(sessionParent);
  let entries;
  try {
    entries = await readdir(sessionRoot, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const recordPaths: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const recordFile = join(sessionRoot, entry.name, "records.jsonl");
    try {
      await access(recordFile);
      recordPaths.push(recordFile);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  recordPaths.sort();
  return recordPaths;
}

/**
 * Project one hostTransition only for a real host switch. Empty native volume
 * still yields a typed switch (empty path list).
 *
 * Pi wrote its own session.jsonl; every other host's run volume is the sitian
 * record set on the live run (ADR 0077 `record-scope-phase-two`, #717) — the CLI's
 * own journals stay in the operator home and are never copied here.
 */
export async function projectHostTransitionPriorNative(input: {
  readonly previousHost: string;
  readonly liveHost: string;
  readonly piSessionFile: string;
}): Promise<RoleTurnHostTransition | undefined> {
  if (input.previousHost === input.liveHost) return undefined;
  if (input.previousHost === "pi") {
    return {
      priorNativeKind: "pi-native",
      priorNativePaths: await listPiNativeRecordPaths(input.piSessionFile),
    };
  }
  // Sitian path handoff only — do not read bytes.
  return {
    priorNativeKind: "sitian",
    priorNativePaths: await listSitianRecordPaths(input.piSessionFile),
  };
}
