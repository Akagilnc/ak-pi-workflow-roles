/**
 * Normalize runner env turn-host injection (#526).
 * Accepts production roleTurnHost or test-legacy piRunner; always yields RoleTurnHost.
 */
import type {
  DurablePrincipalAuthority,
  RoleTurnHost,
  RoleTurnKnownFailure,
} from "../host-contracts.ts";
import { createPiRoleTurnHost } from "../pi/role-turn-host.ts";

export type LegacyPiRunner = (
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number },
) => Promise<{
  code: number | null;
  stderr: string;
  timedOut: boolean;
  knownFailure?: RoleTurnKnownFailure;
}>;

export type TurnHostEnvFields = {
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
  roleTurnHost?: RoleTurnHost;
  piRunner?: LegacyPiRunner;
  extraPiArgs?: readonly string[];
  timeoutMs?: number;
};

export function resolveEnvRoleTurnHost(env: TurnHostEnvFields): RoleTurnHost {
  if (env.roleTurnHost !== undefined) return env.roleTurnHost;
  if (env.piRunner !== undefined) {
    return createPiRoleTurnHost({
      packageRoot: env.packageRoot,
      principalAuthority: env.principalAuthority,
      spawnRunner: env.piRunner,
      ...(env.extraPiArgs === undefined ? {} : { extraPiArgs: env.extraPiArgs }),
      ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    });
  }
  throw new Error("Role run env requires roleTurnHost (or test-legacy piRunner)");
}
