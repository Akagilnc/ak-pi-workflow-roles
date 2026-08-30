/**
 * Shared test injection seam (#526): adapt legacy faux Pi-runner shape to RoleTurnHost.
 * Single helper — no dual-track piRunner on CliEnv.
 */
import type {
  DurablePrincipalAuthority,
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
  RoleTurnResult,
} from "../../src/host-contracts.ts";
import {
  createPiRoleTurnHost,
  type PiSpawnRunner,
} from "../../src/pi/role-turn-host.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import { sealAcceptedSubmissionForSpawn } from "./submission-ledger-fixture.ts";

/** Minimal alternative host: controls typed results without entering the Pi adapter. */
export function createMinimalHost(
  executeTurn: (request: RoleTurnRequest) => Promise<RoleTurnResult>,
): RoleTurnHost {
  return { executeTurn };
}

/** Optional durable sealed fact the faux runner already owns as typed details. */
export type LegacyFauxSealedAcceptance = {
  readonly role: TerminalRoleName;
  readonly details: unknown;
  readonly toolCallId?: string;
};

/** Legacy faux runner shape used by pre-#526 tests. */
export type LegacyFauxPiRunner = (
  args: readonly string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
) => Promise<{
  code: number | null;
  stderr: string;
  timedOut: boolean;
  args?: string[];
  piIdentity?: { executable: string; version: string };
  knownFailure?: RoleTurnKnownFailure;
  /** When set, write the sealed settlement fixture from these typed details only. */
  sealedAcceptance?: LegacyFauxSealedAcceptance;
}>;

/**
 * Build a RoleTurnHost that still drives the real argv translation, then hands
 * the built argv to a legacy faux runner. Behavior assertions on args stay valid.
 */
export function roleTurnHostFromLegacyPiRunner(options: {
  packageRoot: string;
  principalAuthority: DurablePrincipalAuthority;
  piRunner: LegacyFauxPiRunner;
  extraPiArgs?: readonly string[];
  timeoutMs?: number;
}): RoleTurnHost {
  const spawnRunner: PiSpawnRunner = async (args, spawnOptions) => {
    const result = await options.piRunner(args, spawnOptions);
    if (result.sealedAcceptance !== undefined) {
      await sealAcceptedSubmissionForSpawn({
        cwd: spawnOptions.cwd,
        env: spawnOptions.env,
        role: result.sealedAcceptance.role,
        details: result.sealedAcceptance.details,
        ...(result.sealedAcceptance.toolCallId === undefined
          ? {}
          : { toolCallId: result.sealedAcceptance.toolCallId }),
      });
    }
    const projected: RoleTurnResult = {
      code: result.code,
      stderr: result.stderr,
      timedOut: result.timedOut,
      ...(result.knownFailure === undefined ? {} : { knownFailure: result.knownFailure }),
    };
    return projected;
  };
  return createPiRoleTurnHost({
    packageRoot: options.packageRoot,
    principalAuthority: options.principalAuthority,
    spawnRunner,
    ...(options.extraPiArgs === undefined ? {} : { extraPiArgs: options.extraPiArgs }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
}
