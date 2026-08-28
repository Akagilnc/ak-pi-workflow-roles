import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  DurablePrincipalCoordinates,
  NewDurablePrincipalRequest,
} from "../host-contracts.ts";
import { resolveBookKeyFromGit } from "../activation-ledger-git.ts";
import {
  activationBookDirectory,
  resolveActivationLedgerHome,
} from "../activation-ledger-topology.ts";

type PiDurablePrincipal = DurablePrincipal & {
  readonly sessionDirectory: string;
  readonly sessionFile: string;
};

function encode(coordinates: DurablePrincipalCoordinates): PiDurablePrincipal {
  return coordinates as PiDurablePrincipal;
}

export function issuePiDurablePrincipalCoordinates(
  request: NewDurablePrincipalRequest,
): DurablePrincipalCoordinates & {
  readonly ledgerHome: string;
  readonly bookKey: string;
  readonly runDirectory: string;
} {
  const ledgerHome = resolveActivationLedgerHome(
    request.home === undefined ? undefined : () => request.home!,
  );
  const bookKey = resolveBookKeyFromGit(request.cwd);
  const runDirectory = join(
    activationBookDirectory(ledgerHome, bookKey),
    "runs",
    `${request.runId}@${request.role}`,
  );
  const sessionDirectory = join(runDirectory, "session");
  return {
    ledgerHome,
    bookKey,
    runDirectory,
    sessionDirectory,
    sessionFile: join(sessionDirectory, "session.jsonl"),
  };
}

/** Pi's durable-principal codec and availability authority. */
export const piDurablePrincipalAuthority: DurablePrincipalAuthority = {
  issue(request: NewDurablePrincipalRequest): DurablePrincipal {
    const coordinates = issuePiDurablePrincipalCoordinates(request);
    return encode({
      sessionDirectory: coordinates.sessionDirectory,
      sessionFile: coordinates.sessionFile,
    });
  },
  decode(value: unknown): DurablePrincipalCoordinates {
    const record = value as Partial<DurablePrincipalCoordinates> | null;
    if (record === null || typeof record !== "object") {
      throw new Error("durable principal payload is missing");
    }
    if (typeof record.sessionDirectory !== "string" || record.sessionDirectory.trim() === "") {
      throw new Error("durable principal session directory is missing");
    }
    return {
      sessionDirectory: record.sessionDirectory,
      sessionFile:
        typeof record.sessionFile === "string" && record.sessionFile.trim() !== ""
          ? record.sessionFile
          : join(record.sessionDirectory, "session.jsonl"),
    };
  },
  async isAvailable(principal: DurablePrincipal): Promise<boolean> {
    const { sessionFile } = this.decode(principal);
    try {
      const stat = await lstat(sessionFile);
      return stat.isFile() && !stat.isSymbolicLink();
    } catch {
      return false;
    }
  },
};

/** Transitional coordinate accessor; S1b-2 removes it with argv builders. */
export function decodePiDurablePrincipal(
  authority: DurablePrincipalAuthority,
  principal: DurablePrincipal,
): DurablePrincipalCoordinates {
  return authority.decode(principal);
}

/** Rehydrate a durable principal from persisted two-field wire bytes. */
export function rehydratePiDurablePrincipal(
  authority: DurablePrincipalAuthority,
  wire: unknown,
): DurablePrincipal {
  return encode(authority.decode(wire));
}

/** Encode already-decoded coordinates into an opaque principal (no second decode). */
export function encodePiDurablePrincipal(
  coordinates: DurablePrincipalCoordinates,
): DurablePrincipal {
  return encode(coordinates);
}
