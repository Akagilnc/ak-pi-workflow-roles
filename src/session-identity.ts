import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DurablePrincipal, DurablePrincipalAuthority } from "./host-contracts.ts";
import {
  DEFAULT_ROLE_TURN_HOST,
  lookupHeadlessHostDescription,
  lookupHostDescription,
} from "./host-descriptions.ts";
import type { SessionIdentityAuthority } from "./prepared-role-turn.ts";

/** Durable session binding stored beside the host-owned session principal. */
export function createSessionIdentityAuthority(
  authority: DurablePrincipalAuthority,
  sessionBindingFile: string,
): SessionIdentityAuthority {
  const bindingPath = (principal: DurablePrincipal): string =>
    join(authority.decode(principal).sessionDirectory, sessionBindingFile);
  return {
    resolveSessionFile(principal) {
      return authority.decode(principal).sessionFile;
    },
    async load(principal) {
      try {
        const value: unknown = JSON.parse(await readFile(bindingPath(principal), "utf8"));
        if (typeof value !== "object" || value === null || typeof (value as { sessionId?: unknown }).sessionId !== "string") {
          throw new Error("durable session binding is invalid");
        }
        return (value as { sessionId: string }).sessionId;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    async bind(principal, sessionId) {
      const target = bindingPath(principal);
      await mkdir(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ sessionId })}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(temporary, target);
    },
  };
}

/**
 * Host-aware resumable-session probe (#840 P1). The shared auto-resume loop
 * (public-cli/auto-resume.ts) asks one question — "can this principal's turn
 * still be resumed" — without itself knowing which concrete host executed it.
 * Pi's own session.jsonl transcript (DurablePrincipalAuthority#isAvailable)
 * answers that only for the pi host; ACP and headless hosts persist their
 * resumable native session id under their own session-identity binding file
 * instead (#729 / #731 / #645) and never write session.jsonl, so the plain
 * pi check always reports them unavailable after one attempt. One lookup per
 * registered host family — no per-host-name branch, no per-seat whitelist.
 */
export function resolveHostAwareSessionAvailability(
  host: string | undefined,
  principalAuthority: DurablePrincipalAuthority,
): (principal: DurablePrincipal) => Promise<boolean> {
  if (host === undefined || host === DEFAULT_ROLE_TURN_HOST) {
    return (principal) => principalAuthority.isAvailable(principal);
  }
  // Unregistered names have no binding file: absence, not a guess at pi.
  return async (principal) =>
    (await readStoredHostSessionId(host, principalAuthority, principal)) !== undefined;
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
  const sessionId = await createSessionIdentityAuthority(
    authority,
    description.sessionBindingFile,
  ).load(principal);
  if (sessionId === undefined || sessionId === "") return undefined;
  return sessionId;
}
