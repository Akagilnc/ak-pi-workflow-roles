/**
 * Single authority for #617 DK-4 cross-host prior-native projection.
 * Closed host discriminators only; unknown previous/live hosts never inject.
 */
import { access } from "node:fs/promises";

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
 * Project one hostTransition only for a real switch between known hosts.
 * Unknown host names → undefined (no inject). Empty native volume still
 * yields a typed switch (empty path list).
 *
 * Prior native volume is the sitian session record on the live run (#717).
 * Grok CLI journals stay in the operator grok home; they are not copied here.
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
  const paths = await listPiNativeRecordPaths(input.piSessionFile);
  return {
    previousHost: input.previousHost,
    priorNativePaths: paths,
  };
}
