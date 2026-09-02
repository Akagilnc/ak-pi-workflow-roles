import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { DurablePrincipal, DurablePrincipalAuthority } from "../host-contracts.ts";
import type { GrokSessionIdentityAuthority } from "./role-turn-host.ts";

/** ACP binding filename written only by the grok host on initial bind. */
export const GROK_ACP_SESSION_BINDING = "grok-acp-session.json";

/** Durable ACP binding stored beside the host-owned session principal. */
export function createGrokSessionIdentityAuthority(authority: DurablePrincipalAuthority): GrokSessionIdentityAuthority {
  const bindingPath = (principal: DurablePrincipal): string =>
    join(authority.decode(principal).sessionDirectory, GROK_ACP_SESSION_BINDING);
  return {
    resolveSessionFile(principal) {
      return authority.decode(principal).sessionFile;
    },
    async load(principal) {
      try {
        const value: unknown = JSON.parse(await readFile(bindingPath(principal), "utf8"));
        if (typeof value !== "object" || value === null || typeof (value as { sessionId?: unknown }).sessionId !== "string") {
          throw new Error("durable Grok ACP session binding is invalid");
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
