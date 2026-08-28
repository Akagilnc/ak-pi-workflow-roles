/**
 * Test helper: materialize Pi extra-args from a host-neutral turn request.
 * Production argv ownership stays in src/pi/role-turn-host.ts.
 */
import type { DurablePrincipalAuthority, RoleTurnRequest } from "../../src/host-contracts.ts";
import { buildPiTurnExtraArgs } from "../../src/pi/role-turn-host.ts";

export function materializeTurnExtraArgs(
  request: RoleTurnRequest,
  authority: DurablePrincipalAuthority,
  extraPiArgs: readonly string[] = [],
): string[] {
  return buildPiTurnExtraArgs(request, authority, extraPiArgs);
}
