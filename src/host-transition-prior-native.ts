/**
 * Single authority for #617 DK-4 cross-host prior-native projection.
 * Closed host discriminators only; unknown previous/live hosts never inject.
 */
import { readFile, readdir } from "node:fs/promises";
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
 * Sole Grok native volume for a run: the single updates.jsonl under grok-home/sessions
 * when exactly one exists. Multiple session dirs are out of this projector's contract
 * (no unordered multi-file join). ENOENT / zero files → undefined.
 */
async function readGrokNativeSessionRecords(runDirectory: string): Promise<string | undefined> {
  const grokSessionsDir = join(runDirectory, "grok-home", "sessions");
  let encodedCwds;
  try {
    encodedCwds = await readdir(grokSessionsDir, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
  const updatesPaths: string[] = [];
  for (const cwdEntry of encodedCwds) {
    if (!cwdEntry.isDirectory()) continue;
    const sessionDirs = await readdir(join(grokSessionsDir, cwdEntry.name), { withFileTypes: true });
    for (const sessEntry of sessionDirs) {
      if (!sessEntry.isDirectory()) continue;
      updatesPaths.push(join(grokSessionsDir, cwdEntry.name, sessEntry.name, "updates.jsonl"));
    }
  }
  if (updatesPaths.length === 0) return undefined;
  if (updatesPaths.length !== 1) {
    // Ambiguous multi-session tree: no silent join. Caller sees empty prior records.
    return undefined;
  }
  try {
    return await readFile(updatesPaths[0]!, "utf8");
  } catch (error) {
    if (isEnoent(error)) return undefined;
    throw error;
  }
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
  // previousHost === "grok-build"
  const records = await readGrokNativeSessionRecords(input.runDirectory);
  return {
    previousHost: "grok-build",
    priorNativeRecords: records ?? "",
  };
}
