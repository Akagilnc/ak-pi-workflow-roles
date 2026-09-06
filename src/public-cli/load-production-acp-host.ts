/**
 * Deferred loader for the packaged generic ACP RoleTurnHost factory.
 *
 * Public ak-role bin must not statically value-import the production host (or its
 * role-runtime / pi-coding-agent edges). Specifier is runtime-constructed so
 * esbuild leaves this import external (ADR 0052 discovery stays peer-free).
 *
 * Host selection is a description-table lookup: the row for the seat's host key
 * is the factory input. There is no host-name fork here.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { AcpHostDescription } from "../acp-host/description.ts";
import { lookupHostDescription } from "../host-descriptions.ts";
import type { DurablePrincipalAuthority, RoleTurnHost } from "../host-contracts.ts";

export type ProductionAcpHostFactory = (options: {
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
}) => RoleTurnHost;

type GenericAcpHostFactory = (options: {
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
  description: AcpHostDescription;
}) => RoleTurnHost;

/**
 * Resolve the production ACP host factory for one registered host key without a
 * static graph edge into the public CLI bundle.
 */
export async function loadProductionAcpHostFactory(
  packageRoot: string,
  host: string,
): Promise<ProductionAcpHostFactory> {
  const description = lookupHostDescription(host);
  if (description === undefined) {
    throw new Error(`unregistered host: ${host}`);
  }
  const built = join(packageRoot, "dist/acp-host/production-host.js");
  const source = join(packageRoot, "src/acp-host/production-host.ts");
  // Prefer the built artifact (plain node); fall back to source under tsx tests.
  const target = existsSync(built) ? built : source;
  const href = pathToFileURL(target).href;
  const mod = (await import(href)) as {
    createProductionAcpRoleTurnHost: GenericAcpHostFactory;
  };
  const create = mod.createProductionAcpRoleTurnHost;
  return (options) => create({ ...options, description });
}
