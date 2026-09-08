/**
 * Family-dispatch loader for packaged external RoleTurnHost factories (#645).
 * ACP rows → production ACP host; headless rows → production headless host.
 * Unregistered names fail closed before any import.
 */
import { lookupHostFamily } from "../host-descriptions.ts";
import type { DurablePrincipalAuthority, RoleTurnHost } from "../host-contracts.ts";
import { loadProductionAcpHostFactory } from "./load-production-acp-host.ts";
import { loadProductionHeadlessHostFactory } from "./load-production-headless-host.ts";

export type ProductionExternalHostFactory = (options: {
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
}) => RoleTurnHost;

/** Resolve the production host factory for one registered external host key. */
export async function loadProductionExternalHostFactory(
  packageRoot: string,
  host: string,
): Promise<ProductionExternalHostFactory> {
  const family = lookupHostFamily(host);
  if (family === "acp") {
    return loadProductionAcpHostFactory(packageRoot, host);
  }
  if (family === "headless") {
    return loadProductionHeadlessHostFactory(packageRoot, host);
  }
  throw new Error(`unregistered host: ${host}`);
}
