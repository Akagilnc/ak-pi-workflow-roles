import { issuePiDurablePrincipalCoordinates } from "./pi/durable-principal.ts";

export type RoleRunSessionCoordinates = {
  readonly ledgerHome: string;
  readonly bookKey: string;
  readonly runDirectory: string;
  readonly sessionDirectory: string;
  readonly sessionFile: string;
};

/**
 * Compatibility projection for non-public Archivist consumers.
 * Public CLI issuance is owned by the host durable-principal authority.
 */
export function roleRunSessionCoordinates(options: {
  readonly cwd: string;
  readonly runId: string;
  readonly role: string;
  readonly home?: string;
}): RoleRunSessionCoordinates {
  return issuePiDurablePrincipalCoordinates(options);
}
