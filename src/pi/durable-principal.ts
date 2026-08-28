import { lstat } from "node:fs/promises";
import { join } from "node:path";

import type {
  DurablePrincipal,
  DurablePrincipalAuthority,
  DurablePrincipalCoordinates,
  NewDurablePrincipalRequest,
} from "../host-contracts.ts";
import { roleRunSessionCoordinates } from "../archivist-role-run-coordinates.ts";

type PiDurablePrincipal = DurablePrincipal & {
  readonly sessionDirectory: string;
  readonly sessionFile: string;
};

function encode(coordinates: DurablePrincipalCoordinates): PiDurablePrincipal {
  return coordinates as PiDurablePrincipal;
}

/** Pi's durable-principal codec and availability authority. */
export const piDurablePrincipalAuthority: DurablePrincipalAuthority = {
  issue(request: NewDurablePrincipalRequest): DurablePrincipal {
    const coordinates = roleRunSessionCoordinates(request);
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
