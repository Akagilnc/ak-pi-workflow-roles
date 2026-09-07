/**
 * Shared test injection seam (#526): adapt legacy faux Pi-runner shape to RoleTurnHost.
 * Single helper — no dual-track piRunner on CliEnv.
 * Also owns the one scripted terminating-tool session writer (#502 DRY).
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  DIARIST_OUTPUT_TOOL_NAME,
} from "../../src/diarist-contracts.ts";
import type {
  DurablePrincipalAuthority,
  RoleTurnHost,
  RoleTurnKnownFailure,
  RoleTurnRequest,
  RoleTurnResult,
} from "../../src/host-contracts.ts";
import { piDurablePrincipalAuthority } from "../../src/pi/durable-principal.ts";
import {
  createPiRoleTurnHost,
  type PiSpawnRunner,
} from "../../src/pi/role-turn-host.ts";
import type { TerminalRoleName } from "../../src/public-cli/terminal.ts";
import {
  sealAcceptedSubmission,
  sealAcceptedSubmissionForSpawn,
} from "./submission-ledger-fixture.ts";

/** Lawful 起居郎 true-unbound face (null ticket → 无录). Nested court fixtures use this. */
export const TRUE_UNBOUND_DIARIST_DETAILS = {
  status: "completed" as const,
  ticketNumber: null,
  selections: [] as const,
};

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
      id: "user-1",
      parentId: null,
      timestamp: "2026-08-30T00:00:00.000Z",
      message: { role: "user", content: "kickoff", timestamp: 1 },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
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

/**
 * Nested court 起居郎 under another seat must return a lawful true-unbound
 * terminal (exit 0, null ticket). Typed diarist failure is countersign controlled
 * failure (#771) — fixtures may not wash that into body-continue by omission.
 * When the seat under test is diarist itself, pass primaryRole: "diarist" so the
 * primary turn is not short-circuited.
 */
export function withNestedTrueUnboundDiarist(
  inner: RoleTurnHost,
  options?: { readonly primaryRole?: string },
): RoleTurnHost {
  return {
    async executeTurn(request: RoleTurnRequest): Promise<RoleTurnResult> {
      if (
        request.activation.role !== "diarist" ||
        options?.primaryRole === "diarist"
      ) {
        return inner.executeTurn(request);
      }
      const coords = piDurablePrincipalAuthority.decode(request.principal);
      const toolCallId = "call_diarist_true_unbound";
      await mkdir(coords.sessionDirectory, { recursive: true });
      await writeFile(
        coords.sessionFile,
        `${JSON.stringify({
          type: "message",
          message: {
            role: "toolResult",
            toolCallId,
            toolName: DIARIST_OUTPUT_TOOL_NAME,
            isError: false,
            details: TRUE_UNBOUND_DIARIST_DETAILS,
          },
        })}\n`,
        "utf8",
      );
      const leaf = request.runDirectory.split("/").pop() ?? "";
      const runId = leaf.endsWith("@diarist")
        ? leaf.slice(0, -"@diarist".length)
        : leaf;
      await sealAcceptedSubmission({
        cwd: request.cwd,
        home: request.home,
        runId,
        runDirectory: request.runDirectory,
        role: "diarist",
        details: TRUE_UNBOUND_DIARIST_DETAILS,
        toolCallId,
        // Align with real settlement input surface (#637): when courtAttemptId is
        // present, seal that attempt so a prior seal cannot skip this turn.
        ...(request.courtAttemptId === undefined
          ? {}
          : { courtAttemptId: request.courtAttemptId }),
      });
      return { code: 0, stderr: "", timedOut: false };
    },
  };
}

/** Legacy piRunner twin of withNestedTrueUnboundDiarist. */
export function withNestedTrueUnboundDiaristPiRunner(
  inner: LegacyFauxPiRunner,
  options?: { readonly primaryRole?: string },
): LegacyFauxPiRunner {
  return async (args, optionsSpawn) => {
    if (
      argvFlagValue(args, "--ak-role") === "diarist" &&
      options?.primaryRole !== "diarist"
    ) {
      return scriptedTerminatingToolSession({
        role: "diarist",
        toolName: DIARIST_OUTPUT_TOOL_NAME,
        details: TRUE_UNBOUND_DIARIST_DETAILS,
      })(args, optionsSpawn);
    }
    return inner(args, optionsSpawn);
  };
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
