/**
 * Middle-layer role activation → host flag map (#819 / ADR 0082).
 * Sole envelope-assembly definition for activation flags across host families.
 * Host adapters only deliver these flags (ACP/headless getFlag map; pi argv pairs).
 */
import type { RoleTurnRequest } from "./host-contracts.ts";
import { packagedRoleActivationFlags } from "./packaged-role-registry.ts";

/**
 * Project closed RoleTurnActivation onto the shared host flag map.
 * Seat flag names and fields come from the composition-root record.
 * countersign ticketNumber stays off this map (no private transport flag, #632).
 */
export function projectActivationFlags(request: RoleTurnRequest): Map<string, boolean | string> {
  const activation = request.activation;
  const flags = new Map<string, boolean | string>([["ak-role", activation.role]]);
  if (request.stationChild === true) {
    flags.set("ak-station-child", true);
  }
  const values = activation as Record<string, unknown>;
  for (const spec of packagedRoleActivationFlags(activation.role)) {
    if (spec.flag === undefined) continue;
    const text = activationFlagText(values[spec.field]);
    if (text !== undefined) flags.set(spec.flag, text);
  }
  return flags;
}

function activationFlagText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return JSON.stringify(value);
  }
  return undefined;
}
