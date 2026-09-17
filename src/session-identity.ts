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
  const description = lookupHostDescription(host) ?? lookupHeadlessHostDescription(host);
  if (description === undefined) {
    // Host selection already fails closed on an unregistered name (#510) long
    // before a turn dispatches; mirror the same fail-closed default here
    // rather than guessing at pi's binding for a name pi does not own.
    return () => Promise.resolve(false);
  }
  const sessionIdentity = createSessionIdentityAuthority(principalAuthority, description.sessionBindingFile);
  return async (principal) => (await sessionIdentity.load(principal)) !== undefined;
}
