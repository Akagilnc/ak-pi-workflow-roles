import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

const MODEL_LESS_RUN_FILE = "model-less-run.json";

export async function establishModelLessRunPrincipal(
  authority: DurablePrincipalAuthority,
  principal: DurablePrincipal,
): Promise<void> {
  const coordinates = authority.decode(principal);
  await mkdir(coordinates.sessionDirectory, { recursive: true });
  const path = join(coordinates.sessionDirectory, MODEL_LESS_RUN_FILE);
  try {
    await writeFile(path, `${JSON.stringify({ version: 1, kind: "model-less-run" })}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
}

export async function appendModelLessRunRecord(
  sessionFile: string,
  customType: string,
  data: Record<string, unknown>,
): Promise<boolean> {
  const sessionDirectory = dirname(sessionFile);
  try {
    const marker: unknown = JSON.parse(await readFile(join(sessionDirectory, MODEL_LESS_RUN_FILE), "utf8"));
    if (typeof marker !== "object" || marker === null || (marker as { kind?: unknown }).kind !== "model-less-run") {
      return false;
    }
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
  const recordsPath = join(sessionDirectory, "model-less-records.jsonl");
  let sequence = 1;
  try {
    const prior = (await readFile(recordsPath, "utf8")).trim().split("\n").filter(Boolean);
    sequence = prior.length + 1;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  await appendFile(
    recordsPath,
    `${JSON.stringify({ type: "custom", customType, data: { sequence, ...data } })}\n`,
    "utf8",
  );
  return true;
}

export async function isModelLessRunPrincipalAvailable(
  authority: DurablePrincipalAuthority,
  principal: DurablePrincipal,
): Promise<boolean> {
  try {
    const value: unknown = JSON.parse(await readFile(
      join(authority.decode(principal).sessionDirectory, MODEL_LESS_RUN_FILE),
      "utf8",
    ));
    return typeof value === "object" && value !== null
      && (value as { version?: unknown }).version === 1
      && (value as { kind?: unknown }).kind === "model-less-run";
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
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
  let hostAvailable: (principal: DurablePrincipal) => Promise<boolean>;
  if (host === undefined || host === DEFAULT_ROLE_TURN_HOST) {
    hostAvailable = (principal) => principalAuthority.isAvailable(principal);
  } else {
    const description = lookupHostDescription(host) ?? lookupHeadlessHostDescription(host);
    if (description === undefined) {
      hostAvailable = () => Promise.resolve(false);
    } else {
      const sessionIdentity = createSessionIdentityAuthority(principalAuthority, description.sessionBindingFile);
      hostAvailable = async (principal) => (await sessionIdentity.load(principal)) !== undefined;
    }
  }
  return async (principal) =>
    (await isModelLessRunPrincipalAvailable(principalAuthority, principal))
    || hostAvailable(principal);
}
