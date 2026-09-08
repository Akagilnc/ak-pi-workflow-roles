/**
 * Production composition for the generic headless CLI RoleTurnHost (#645).
 * Agent subprocesses inherit the operator home and credentials in place.
 * No HOME rewrite, no isolated home, no credential parameters — CLI owns auth.
 * Sitian records on the run are the dossier; host private sessions stay private.
 *
 * Intermediate AK tools ride the shared envelope MCP relay via host-native
 * `--mcp-config` under `--strict-mcp-config`. The terminating receipt is the
 * host-native `--json-schema` / structured_output schema channel only
 * (#750 submission-tool-is-schema-channel) — terminating tool is not listed on MCP.
 */
import { randomUUID } from "node:crypto";

import type { DurablePrincipalAuthority, RoleTurnHost } from "../host-contracts.ts";
import { createAcpRoleRuntimeDependencies } from "../acp-host/production-host.ts";
import { prepareAcpRoleEnvelope } from "../acp-host/role-envelope.ts";
import { createAcpSessionIdentityAuthority } from "../acp-host/session-identity.ts";
import { resolveHeadlessBinary, type HeadlessHostDescription } from "./description.ts";
import { createHeadlessRoleTurnHost } from "./role-turn-host.ts";

export type ProductionHeadlessHostOptions = Readonly<{
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
  description: HeadlessHostDescription;
}>;

/**
 * Assemble a production headless RoleTurnHost from the shared envelope prepare
 * (MCP relay for AK tools) and one host description row. Binary is resolved
 * from each turn's operator home (`request.home`).
 */
export function createProductionHeadlessRoleTurnHost(
  options: ProductionHeadlessHostOptions,
): RoleTurnHost {
  const { packageRoot, principalAuthority, description } = options;
  const sessionIdentity = createAcpSessionIdentityAuthority(
    principalAuthority,
    description.sessionBindingFile,
  );
  const roleRuntimeDependencies = createAcpRoleRuntimeDependencies(packageRoot);

  const innerFor = (operatorHome: string): RoleTurnHost =>
    createHeadlessRoleTurnHost({
      description,
      sessionIdentity,
      binary: resolveHeadlessBinary(description, operatorHome),
      env: {
        ...process.env,
        AK_PACKAGE_ROOT: packageRoot,
      },
      prepare: (request) =>
        prepareAcpRoleEnvelope({
          request,
          dependencies: roleRuntimeDependencies,
          sessionFile: sessionIdentity.resolveSessionFile(request.principal),
          // Same MCP relay as ACP so intermediate AK tools stay reachable;
          // headless adapter projects the row into --mcp-config.
          socketPath: `/tmp/ak-headless-mcp-${randomUUID()}.sock`,
          // Schema channel owns the terminating receipt; hide it from MCP list.
          listTerminatingToolOnMcp: false,
        }),
    });

  let cachedHome: string | undefined;
  let cachedHost: RoleTurnHost | undefined;
  return {
    executeTurn(request) {
      if (cachedHost === undefined || cachedHome !== request.home) {
        cachedHome = request.home;
        cachedHost = innerFor(request.home);
      }
      return cachedHost.executeTurn(request);
    },
  };
}
