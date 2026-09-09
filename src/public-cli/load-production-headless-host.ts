/**
 * Deferred loader for the packaged generic headless RoleTurnHost factory (#645).
 *
 * Public ak-role bin must not statically value-import the production host (or its
 * role-runtime edges). Specifier is runtime-constructed so esbuild leaves this
 * import external (ADR 0052 discovery stays peer-free).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { HeadlessHostDescription } from "../headless-host/description.ts";
import { lookupHeadlessHostDescription } from "../host-descriptions.ts";
import type { DurablePrincipalAuthority, RoleTurnHost } from "../host-contracts.ts";

export type ProductionHeadlessHostFactory = (options: {
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
}) => RoleTurnHost;

type GenericHeadlessHostFactory = (options: {
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
  description: HeadlessHostDescription;
  hostName: string;
}) => RoleTurnHost;

/**
 * Resolve the production headless host factory for one registered headless host
 * key without a static graph edge into the public CLI bundle.
 */
export async function loadProductionHeadlessHostFactory(
  packageRoot: string,
  host: string,
): Promise<ProductionHeadlessHostFactory> {
  const description = lookupHeadlessHostDescription(host);
  if (description === undefined) {
    throw new Error(`unregistered headless host: ${host}`);
  }
  const built = join(packageRoot, "dist/headless-host/production-host.js");
  const source = join(packageRoot, "src/headless-host/production-host.ts");
  const target = existsSync(built) ? built : source;
  const href = pathToFileURL(target).href;
  const mod = (await import(href)) as {
    createProductionHeadlessRoleTurnHost: GenericHeadlessHostFactory;
  };
  const create = mod.createProductionHeadlessRoleTurnHost;
  return (options) => create({ ...options, description, hostName: host });
}
