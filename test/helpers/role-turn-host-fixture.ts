/**
 * Shared test injection seam (#526): adapt legacy faux Pi-runner shape to RoleTurnHost.
 * Single helper — no dual-track piRunner on CliEnv.
 */
import { join } from "node:path";
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
import { sealAcceptedSubmissionFromSession } from "./submission-ledger-fixture.ts";

/** Minimal alternative host: controls typed results without entering the Pi adapter. */
export function createMinimalHost(
  executeTurn: (request: RoleTurnRequest) => Promise<RoleTurnResult>,
): RoleTurnHost {
  return { executeTurn };
}

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
    const sessionIdx = args.indexOf("--session");
    const sessionDirIdx = args.indexOf("--session-dir");
    const sessionFile =
      sessionIdx >= 0 && typeof args[sessionIdx + 1] === "string"
        ? args[sessionIdx + 1]
        : sessionDirIdx >= 0 && typeof args[sessionDirIdx + 1] === "string"
          ? join(args[sessionDirIdx + 1]!, "session.jsonl")
          : undefined;
    const runDirectory = spawnOptions.env.AK_ROLE_RUN_DIR;
    if (typeof sessionFile === "string" && typeof runDirectory === "string" && runDirectory.length > 0) {
      await sealAcceptedSubmissionFromSession({
        cwd: spawnOptions.cwd,
        runDirectory,
        sessionFile,
        ...(typeof spawnOptions.env.HOME === "string" ? { home: spawnOptions.env.HOME } : {}),
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
