/**
 * Shared test injection seam (#526): adapt legacy faux Pi-runner shape to RoleTurnHost.
 * Single helper — no dual-track piRunner on CliEnv.
 * Also owns the one scripted terminating-tool session writer (#502 DRY).
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import {
  SCRIPTED_TERMINATING_USER_ATTEMPT_ID,
  sealAcceptedSubmissionForSpawn,
} from "./submission-ledger-fixture.ts";

/** Read a dashed flag value from argv (shared by public-CLI tracers). */
export function argvFlagValue(
  args: readonly string[],
  flag: string,
): string | undefined {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  return args[index + 1];
}

/**
 * One authority: write a terminating-tool session JSONL and optionally return
 * sealedAcceptance. Seats pass role / toolName / details only — no per-seat
 * session-row or flagValue copies (#502).
 */
export function scriptedTerminatingToolSession(input: {
  readonly role: TerminalRoleName;
  readonly toolName: string;
  readonly details: unknown;
  readonly isError?: boolean;
  /** Default true when !isError. Pass false for accepted-once non-usable residual paths. */
  readonly seal?: boolean;
  readonly toolCallId?: string;
  readonly acceptedText?: string;
}): LegacyFauxPiRunner {
  const isError = input.isError === true;
  const seal = input.seal ?? !isError;
  const toolCallId = input.toolCallId ?? `call_${input.role}_1`;
  const acceptedText = input.acceptedText ?? `${input.role} output accepted`;
  const rows = [
    {
      type: "message",
      id: SCRIPTED_TERMINATING_USER_ATTEMPT_ID,
      parentId: null,
      timestamp: "2026-08-30T00:00:00.000Z",
      message: { role: "user", content: "kickoff", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: SCRIPTED_TERMINATING_USER_ATTEMPT_ID,
      timestamp: "2026-08-30T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: toolCallId,
            name: input.toolName,
            arguments: input.details,
          },
        ],
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "result-1",
      parentId: "assistant-1",
      timestamp: "2026-08-30T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId,
        toolName: input.toolName,
        content: [{ type: "text", text: acceptedText }],
        details: input.details,
        isError,
        timestamp: 3,
      },
    },
  ];
  return async (extraArgs) => {
    const sessionFile = argvFlagValue(extraArgs, "--session");
    assert.ok(sessionFile);
    await mkdir(join(sessionFile, ".."), { recursive: true });
    await writeFile(
      sessionFile,
      `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
      "utf8",
    );
    return {
      code: 0,
      timedOut: false,
      stderr: "",
      args: [...extraArgs],
      ...(seal
        ? {
            sealedAcceptance: {
              role: input.role,
              details: input.details,
              toolCallId,
            },
          }
        : {}),
    };
  };
}

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
