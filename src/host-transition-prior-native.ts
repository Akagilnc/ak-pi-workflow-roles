/**
 * Single authority for #617 DK-4 cross-host prior-native projection.
 * Projects native files alongside Sitian records for cross-host handoff.
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
 * Present copied native dossiers and sitian records under sessionParent topology (#717).
 * resolveSitianRecordPathInLedger writes dirname(sessionParent)/<category>/records.jsonl
 * when sessionParent is inside ledger home — never session.jsonl itself.
 */
async function listSitianRecordPaths(sessionParent: string, previousHost: string): Promise<string[]> {
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
    if (entry.name.startsWith(`${previousHost}-`) && /-\d+(?:\.jsonl)?$/.test(entry.name)) {
      if (entry.isFile()) recordPaths.push(join(sessionRoot, entry.name));
      if (entry.isDirectory()) {
        for (const leaf of ["chat_history.jsonl", "usage.json"]) {
          const path = join(sessionRoot, entry.name, leaf);
          try { await access(path); recordPaths.push(path); }
          catch (error) { if (!isEnoent(error)) throw error; }
        }
      }
    }
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
 * Pi wrote session.jsonl; external hosts supply copied native files and Sitian records.
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
  // Hand off existing record paths without reading their bytes.
  return {
    priorNativeKind: "sitian",
    priorNativePaths: await listSitianRecordPaths(input.piSessionFile, input.previousHost),
  };
}
