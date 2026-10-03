import { dirname } from "node:path";

import type { DurablePrincipal, DurablePrincipalAuthority } from "./host-contracts.ts";
import {
  DEFAULT_ROLE_TURN_HOST,
  lookupHeadlessHostDescription,
  lookupHostDescription,
} from "./host-descriptions.ts";
import { readSectionSync, writeSectionSync } from "./run-dossier.ts";
import type { SessionIdentityAuthority } from "./prepared-role-turn.ts";

/** Durable session binding: the `host` section of the run's current.json. */
export function createSessionIdentityAuthority(
  authority: DurablePrincipalAuthority,
): SessionIdentityAuthority {
  const runDirectoryOf = (principal: DurablePrincipal): string =>
    dirname(authority.decode(principal).sessionDirectory);
  return {
    resolveSessionFile(principal) {
      return authority.decode(principal).sessionFile;
    },
    async load(principal) {
      const sessionId = readSectionSync(runDirectoryOf(principal), "host")?.sessionId;
      if (sessionId === undefined) return undefined;
      if (typeof sessionId !== "string") throw new Error("durable session binding is invalid");
      return sessionId;
    },
    async bind(principal, sessionId) {
      const runDirectory = runDirectoryOf(principal);
      writeSectionSync(runDirectory, "host", { ...readSectionSync(runDirectory, "host"), sessionId });
    },
  };
}

/**
 * Native session/thread id already stored for this principal on `host`.
 * Public explicit resume reads it once and hands it to the host adapter.
 * Pi has no separate binding file. A missing file is absence, not the package run id.
 */
export async function readStoredHostSessionId(
  host: string | undefined,
  authority: DurablePrincipalAuthority,
  principal: DurablePrincipal,
): Promise<string | undefined> {
  if (host === undefined || host === DEFAULT_ROLE_TURN_HOST) return undefined;
  const description = lookupHostDescription(host) ?? lookupHeadlessHostDescription(host);
  if (description === undefined) return undefined;
  const sessionId = await createSessionIdentityAuthority(authority).load(principal);
  if (sessionId === undefined || sessionId === "") return undefined;
  return sessionId;
}
