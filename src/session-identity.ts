import { dirname, join } from "node:path";

import type { DurablePrincipal, DurablePrincipalAuthority } from "./host-contracts.ts";
import {
  DEFAULT_ROLE_TURN_HOST,
  lookupHeadlessHostDescription,
  lookupHostDescription,
} from "./host-descriptions.ts";
import { renderCurrentSync, RUN_STATE_FILE } from "./run-dossier.ts";
import { readSitianRecords, reportRunRecord } from "./sitian-facade.ts";
import { isRecord } from "./unknown-value.ts";
import type { SessionIdentityAuthority } from "./prepared-role-turn.ts";

/** Log record kind of one host-session binding (a host's native session id for this run). */
export const HOST_SESSION_ID_RECORD_KIND = "host-session-id" as const;

/**
 * Durable session binding: one state row per bind, scoped by host name — a run
 * that changes hosts on resume must never hand one host's native session id to
 * another. The latest record for the host wins. The public call renders
 * `current.json` at the bind itself so host.sessions is projected before the
 * host CLI starts, not only at settlement.
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
      const { records, diagnostics } = await readSitianRecords(join(runDirectoryOf(principal), RUN_STATE_FILE));
      if (diagnostics.length > 0) {
        process.stderr.write(
          `[session-identity] ${RUN_STATE_FILE} has ${diagnostics.length} malformed row(s); reachable bindings kept: ${runDirectoryOf(principal)}\n`,
        );
      }
      let bound: string | undefined;
      for (const record of records) {
        if (record.kind !== HOST_SESSION_ID_RECORD_KIND || !isRecord(record.payload)) continue;
        if (record.payload.host !== hostName) continue;
        if (typeof record.payload.sessionId !== "string") throw new Error("durable session binding is invalid");
        bound = record.payload.sessionId;
      }
      return bound;
    },
    async bind(principal, sessionId) {
      const runDirectory = runDirectoryOf(principal);
      reportRunRecord(runDirectory, HOST_SESSION_ID_RECORD_KIND, { host: hostName, sessionId }, "session-identity");
      renderCurrentSync(runDirectory);
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
