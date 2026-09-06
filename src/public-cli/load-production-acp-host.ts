/**
 * Deferred loader for the packaged ACP RoleTurnHost factory.
 *
 * Public ak-role bin must not statically value-import the production host (or its
 * role-runtime / pi-coding-agent edges). Specifier is runtime-constructed so
 * esbuild leaves this import external (ADR 0052 discovery stays peer-free).
 *
 * Factory module remains the grok production host until #732 de-grokifies it;
 * this loader is selected by host-description-table key, not a host-name fork.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { DurablePrincipalAuthority, RoleTurnHost } from "../host-contracts.ts";

export type ProductionAcpHostFactory = (options: {
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
}) => RoleTurnHost;

/**
 * Resolve the production ACP host factory from the package tree without a
 * static graph edge into the public CLI bundle.
 */
export async function loadProductionAcpHostFactory(
  packageRoot: string,
): Promise<ProductionAcpHostFactory> {
  const built = join(packageRoot, "dist/grok/production-host.js");
  const source = join(packageRoot, "src/grok/production-host.ts");
  // Prefer the built artifact (plain node); fall back to source under tsx tests.
  const target = existsSync(built) ? built : source;
  const href = pathToFileURL(target).href;
  const mod = (await import(href)) as {
    createProductionGrokRoleTurnHost: ProductionAcpHostFactory;
  };
  return mod.createProductionGrokRoleTurnHost;
}
