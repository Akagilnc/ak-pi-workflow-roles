/**
 * Single authority for #617 DK-4 cross-host prior-native projection.
 * Closed host discriminators only; unknown previous/live hosts never inject.
 */
import { access, readdir } from "node:fs/promises";
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
 * Unknown host names → undefined (no inject). Empty native volume still
 * yields a typed switch (empty path list).
 *
 * Grok native home lives under the live run that wrote it (#617 DK-4 / #637
 * same-run resume). No cross-run previousRunDirectory override.
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
    const paths = await listPiNativeRecordPaths(input.piSessionFile);
    return {
      previousHost: "pi",
      priorNativePaths: paths,
    };
  }
  // previousHost === "grok-build": DK-7 path handoff only — do not read bytes.
  const paths = await listGrokNativeRecordPaths(input.runDirectory);
  return {
    previousHost: "grok-build",
    priorNativePaths: paths,
  };
}
