import { dirname } from "node:path";

import type { DurablePrincipal, DurablePrincipalAuthority } from "./host-contracts.ts";
import {
  DEFAULT_ROLE_TURN_HOST,
  lookupHeadlessHostDescription,
  lookupHostDescription,
} from "./host-descriptions.ts";
import { readSectionSync, writeSectionSync } from "./run-dossier.ts";
import type { SessionIdentityAuthority } from "./prepared-role-turn.ts";

/**
 * Durable session binding: `host.sessions[<hostName>]` of the run's current.json.
 * Scoped by host name — a run that changes hosts on resume must never hand one
 * host's native session id to another.
 */
export function createSessionIdentityAuthority(
  authority: DurablePrincipalAuthority,
  hostName: string,
): SessionIdentityAuthority {
  const runDirectoryOf = (principal: DurablePrincipal): string =>
    dirname(authority.decode(principal).sessionDirectory);
  return {
    resolveSessionFile(principal) {
      return authority.decode(principal).sessionFile;
    },
    async load(principal) {
      const sessions = readSectionSync(runDirectoryOf(principal), "host")?.sessions;
      if (sessions === undefined) return undefined;
      if (typeof sessions !== "object" || sessions === null) throw new Error("durable session binding is invalid");
      const sessionId = (sessions as Record<string, unknown>)[hostName];
      if (sessionId === undefined) return undefined;
      if (typeof sessionId !== "string") throw new Error("durable session binding is invalid");
      return sessionId;
    },
    async bind(principal, sessionId) {
      const runDirectory = runDirectoryOf(principal);
      const host = readSectionSync(runDirectory, "host");
      const sessions = typeof host?.sessions === "object" && host.sessions !== null ? host.sessions : {};
      writeSectionSync(runDirectory, "host", { ...host, sessions: { ...sessions, [hostName]: sessionId } });
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
  const sessionId = await createSessionIdentityAuthority(authority, host).load(principal);
  if (sessionId === undefined || sessionId === "") return undefined;
  return sessionId;
}
