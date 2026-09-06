/**
 * Single authority for #617 DK-4 cross-host prior-native projection.
 * Closed host discriminators only; unknown previous/live hosts never inject.
 */
import { access, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { RoleTurnHostTransition } from "./host-contracts.ts";

const KNOWN_ROLE_TURN_HOSTS = ["pi", "grok-build"] as const;
type KnownRoleTurnHost = (typeof KNOWN_ROLE_TURN_HOSTS)[number];

function isKnownRoleTurnHost(value: string): value is KnownRoleTurnHost {
  return (KNOWN_ROLE_TURN_HOSTS as readonly string[]).includes(value);
}

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
 * Project one hostTransition only for a real switch between known hosts.
 * Unknown host names → undefined (no inject). Empty native volume still
 * yields a typed switch (empty path list).
 *
 * Pi previous → Pi session.jsonl path.
 * Grok previous → sitian records on the live run (#717). Grok CLI journals
 * stay in the operator grok home; they are not copied here.
 */
export async function projectHostTransitionPriorNative(input: {
  readonly previousHost: string;
  readonly liveHost: string;
  readonly piSessionFile: string;
}): Promise<RoleTurnHostTransition | undefined> {
  if (input.previousHost === input.liveHost) return undefined;
  if (!isKnownRoleTurnHost(input.previousHost) || !isKnownRoleTurnHost(input.liveHost)) {
    return undefined;
  }
  if (input.previousHost === "pi") {
    const paths = await listPiNativeRecordPaths(input.piSessionFile);
    return {
      previousHost: "pi",
      priorNativePaths: paths,
    };
  }
  // previousHost === "grok-build": sitian path handoff only — do not read bytes.
  const paths = await listSitianRecordPaths(input.piSessionFile);
  return {
    previousHost: "grok-build",
    priorNativePaths: paths,
  };
}
