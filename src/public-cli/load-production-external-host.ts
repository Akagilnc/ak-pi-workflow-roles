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

/** Lazy production external host — sole builder for CLI adapter table + public summons (#820). */
export function createLazyProductionExternalHost(options: {
  readonly packageRoot: string;
  readonly hostName: string;
  readonly principalAuthority: DurablePrincipalAuthority;
}): RoleTurnHost {
  let hostPromise: Promise<RoleTurnHost> | undefined;
  return {
    executeTurn: async (request) => {
      hostPromise ??= loadProductionExternalHostFactory(options.packageRoot, options.hostName).then((create) =>
        create({ packageRoot: options.packageRoot, principalAuthority: options.principalAuthority }),
      );
      return (await hostPromise).executeTurn(request);
    },
  };
}
