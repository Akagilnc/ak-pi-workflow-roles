/**
 * Single authority for #617 DK-4 cross-host prior-native projection.
 * Closed host discriminators only; unknown previous/live hosts never inject.
 */
import { access, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { RoleTurnHostTransition } from "./host-contracts.ts";

const KNOWN_ROLE_TURN_HOSTS = ["pi", "grok-build"] as const;
type KnownRoleTurnHost = (typeof KNOWN_ROLE_TURN_HOSTS)[number];

function isKnownRoleTurnHost(value: string): value is KnownRoleTurnHost {
  return (KNOWN_ROLE_TURN_HOSTS as readonly string[]).includes(value);
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "ENOENT";
}

/** Read Pi native session file bytes exactly. ENOENT → undefined; empty file → "". */
async function readPiNativeSessionRecords(sessionFile: string): Promise<string | undefined> {
  try {
    return await readFile(sessionFile, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
}

/**
 * Read Grok native updates.jsonl files under runDirectory/grok-home/sessions.
 * Deterministically delivers all applicable native records sorted by relative path.
 * ENOENT / zero files → undefined.
 */
/** Native Grok updates.jsonl paths under runDirectory/grok-home/sessions, sorted. */
export async function listGrokNativeRecordPaths(runDirectory: string): Promise<string[]> {
  const grokSessionsDir = join(runDirectory, "grok-home", "sessions");
  let encodedCwds;
  try {
    encodedCwds = await readdir(grokSessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
  const updatesPaths: string[] = [];
  for (const cwdEntry of encodedCwds) {
    if (!cwdEntry.isDirectory()) continue;
    let sessionDirs;
    try {
      sessionDirs = await readdir(join(grokSessionsDir, cwdEntry.name), { withFileTypes: true });
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    for (const sessEntry of sessionDirs) {
      if (!sessEntry.isDirectory()) continue;
      updatesPaths.push(join(grokSessionsDir, cwdEntry.name, sessEntry.name, "updates.jsonl"));
    }
  }
  updatesPaths.sort();
  const present: string[] = [];
  for (const updatesFile of updatesPaths) {
    try {
      await access(updatesFile);
      present.push(updatesFile);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
  return present;
}

/**
 * Project one hostTransition only for a real switch between known hosts.
 * Unknown host names → undefined (no inject). Empty native volume → transition
 * with empty priorNativeRecords so adapters still see the typed switch.
 */
export async function projectHostTransitionPriorNative(input: {
  readonly previousHost: string;
  readonly liveHost: string;
  readonly runDirectory: string;
  readonly piSessionFile: string;
}): Promise<RoleTurnHostTransition | undefined> {
  if (input.previousHost === input.liveHost) return undefined;
  if (!isKnownRoleTurnHost(input.previousHost) || !isKnownRoleTurnHost(input.liveHost)) {
    return undefined;
  }
  if (input.previousHost === "pi") {
    const records = await readPiNativeSessionRecords(input.piSessionFile);
    return {
      previousHost: "pi",
      priorNativeRecords: records ?? "",
    };
  }
  // previousHost === "grok-build": DK-7 path handoff only — do not read bytes.
  const paths = await listGrokNativeRecordPaths(input.runDirectory);
  return {
    previousHost: "grok-build",
    priorNativeRecords: "",
    priorNativePaths: paths,
  };
}
