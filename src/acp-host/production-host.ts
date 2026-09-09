/**
 * Production composition for the generic ACP RoleTurnHost adapter (#732).
 * Owns injectables around the S6 true adapter; does not alter adapter behavior.
 *
 * The agent runs against the operator home and its credentials in place. The
 * factory does not create a run-scoped agent home, does not rewrite HOME, and
 * does not copy or scrub credentials. Sitian records on the run are the dossier.
 */
import { randomUUID } from "node:crypto";

import type { DurablePrincipalAuthority, RoleTurnHost, RoleTurnRequest } from "../host-contracts.ts";
import { prepareRoleEnvelope } from "../role-envelope.ts";
import type { RoleRuntimeDependencies } from "../role-runtime.ts";
import { createRoleRuntimeDependencies } from "../role-runtime-dependencies.ts";
import { createSessionIdentityAuthority } from "../session-identity.ts";
import { acpStdioArgs, resolveAcpBinary, type AcpHostDescription } from "./description.ts";
import {
  connectAcpStdio,
  createAcpRoleTurnHost,
  type AcpRoleTurnHostConfig,
} from "./role-turn-host.ts";
import { ensureSeatProfileSoul } from "./seat-profile-soul.ts";

export type ProductionAcpHostOptions = Readonly<{
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
  description: AcpHostDescription;
  /** Seat-table host key (e.g. grok-build). */
  hostName: string;
}>;

function createComposedAcpRoleTurnHost(
  config: Omit<AcpRoleTurnHostConfig, "prepare"> & {
    readonly roleRuntimeDependencies: RoleRuntimeDependencies;
    readonly socketPath?: (request: RoleTurnRequest) => string;
  },
) {
  return createAcpRoleTurnHost({
    ...config,
    prepare: (request) => prepareRoleEnvelope({
      request,
      dependencies: config.roleRuntimeDependencies,
      sessionFile: config.sessionIdentity.resolveSessionFile(request.principal),
      socketPath: config.socketPath?.(request) ?? `/tmp/ak-acp-mcp-${randomUUID()}.sock`,
    }),
  });
}

/**
 * Assemble a production ACP RoleTurnHost from the S6 true adapter for one host
 * description. Agent subprocesses inherit the operator home; the run directory
 * is sitian-only.
 */
export function createProductionAcpRoleTurnHost(options: ProductionAcpHostOptions): RoleTurnHost {
  const { packageRoot, principalAuthority, description, hostName } = options;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...description.childEnv,
    AK_PACKAGE_ROOT: packageRoot,
  };

  return createComposedAcpRoleTurnHost({
    hostName,
    sessionIdentity: createSessionIdentityAuthority(principalAuthority, description.sessionBindingFile),
    boundResume: description.boundResume,
    modelPassing: description.modelPassing,
    roleRuntimeDependencies: createRoleRuntimeDependencies(packageRoot),
    async connect(request) {
      const seatProfile = description.seatProfileSoul;
      const profileName = seatProfile === undefined
        ? undefined
        : await ensureSeatProfileSoul({
          spec: seatProfile,
          operatorHome: request.home,
          packageRoot,
          role: request.activation.role,
        });
      return connectAcpStdio({
        binary: resolveAcpBinary(description, request.home),
        args: acpStdioArgs(
          description,
          request.model,
          profileName === undefined ? undefined : { profileName },
        ),
        cwd: request.cwd,
        env,
      });
    },
  });
}
