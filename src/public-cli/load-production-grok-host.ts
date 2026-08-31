/**
 * Deferred loader for the grok-build production host factory.
 *
 * The public ak-role bin must not statically value-import production-host (or its
 * role-runtime / pi-coding-agent edges). Specifier is runtime-constructed so
 * esbuild leaves this import external (ADR 0052 discovery stays peer-free).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { DurablePrincipalAuthority, RoleTurnHost } from "../host-contracts.ts";

export type ProductionGrokHostFactory = (options: {
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
}) => RoleTurnHost;

/**
 * Resolve createProductionGrokRoleTurnHost from the package tree without a static
 * graph edge into the public CLI bundle.
 */
export async function loadProductionGrokHostFactory(
  packageRoot: string,
): Promise<ProductionGrokHostFactory> {
  const built = join(packageRoot, "dist/grok/production-host.js");
  const source = join(packageRoot, "src/grok/production-host.ts");
  // Prefer the built artifact (plain node); fall back to source under tsx tests.
  const target = existsSync(built) ? built : source;
  const href = pathToFileURL(target).href;
  const mod = (await import(href)) as {
    createProductionGrokRoleTurnHost: ProductionGrokHostFactory;
  };
  return mod.createProductionGrokRoleTurnHost;
}
