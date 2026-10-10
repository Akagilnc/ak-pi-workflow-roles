/**
 * Package-owned engine detour tool (#357 T2 / #378 / #380 / #1213).
 * Registered by shared role-runtime when any role + engine activation signal is present.
 * Evidence-child legs install the same definition via customTools (no spawn in role modules).
 * Engine process failures return as tool results to the same seat session — the package
 * does not abort the seat run on their behalf (#1213).
 * Caller AbortSignal cancellation propagates unchanged.
 */
import { Type, type Static } from "typebox";
import type { HostContext, HostToolDefinition, HostToolResult, RoleHost } from "./host-contracts.ts";

import {
  ENGINE_DETOUR_TOOL_NAME,
  engineDetourFailureSeatText,
  isEngineDetourFailure,
  resolveEngineModel,
  resolveEngineName,
  runEngineDetourOnce,
} from "./engine-detour.ts";
import {
  engineDetourStdoutByteLength,
  reportEngineDetourCall,
} from "./engine-detour-usage.ts";
import { runIdFromRunDirectory } from "./run-terminal-artifacts.ts";
import { serializeThrownValue } from "./serialize-thrown-value.ts";

// #836 r16 class 3: argv required/minItems/element-minLength stay — execute()
// must obtain the first item as the executable and spawn it (below; #82-98).
// Root additionalProperties:false is deleted — execute() reads only `argv`.
const engineDetourArgsSchema = Type.Object(
  {
    argv: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description: "首项为 PATH 中的可执行文件，其余项为参数。",
    }),
  },
  { additionalProperties: true },
);

type EngineDetourArgs = Static<typeof engineDetourArgsSchema>;

type EngineDetourContext = Pick<HostContext, "cwd" | "mode" | "abort"> & {
  sessionManager?: Pick<HostContext["sessionManager"], "getSessionFile">;
  runDirectory?: string;
  /** Public-invocation scope from the shared Host envelope (#537). */
  invocationScopeId?: string;
  /** Selected host from the shared Host envelope (#537 / ADR 0082). */
  host?: string;
};

/** Caller/upper-layer cancellation must propagate unchanged. */
function isCallerCancellation(
  error: unknown,
  signal: AbortSignal | undefined,
): boolean {
  if (signal?.aborted === true) return true;
  if (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  ) {
    return true;
  }
  return false;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error
    ? error
    : new Error(String(error).trim() || fallback);
}

/** Structured details shared by success and engine-process failure results. */
type EngineDetourResultDetails = {
  tool: typeof ENGINE_DETOUR_TOOL_NAME;
  code?: number;
  /** Full child stdout when the process closed (failure keeps labor output). */
  stdout?: string;
  stderr?: string;
  /** Node errno on spawn failure (e.g. ENOENT). */
  errorCode?: string;
  /** Full ledger-write failure when dual-fail (serializeThrownValue; seat still lives). */
  ledgerError?: string;
};

function engineFailureResult(input: {
  text: string;
  code?: number;
  stdout?: string;
  stderr?: string;
  errorCode?: string;
  ledgerError?: string;
}): HostToolResult<EngineDetourResultDetails> {
  const details: EngineDetourResultDetails = {
    tool: ENGINE_DETOUR_TOOL_NAME,
    ...(input.code === undefined ? {} : { code: input.code }),
    ...(input.stdout === undefined ? {} : { stdout: input.stdout }),
    ...(input.stderr === undefined ? {} : { stderr: input.stderr }),
    ...(input.errorCode === undefined ? {} : { errorCode: input.errorCode }),
    ...(input.ledgerError === undefined ? {} : { ledgerError: input.ledgerError }),
  };
  // MCP / invokeAkTool deliver content only — dual-fail ledger cause must ride
  // the seat-visible content channel, not details alone (#1213).
  let text = input.text;
  if (input.ledgerError !== undefined && input.ledgerError.length > 0) {
    if (text.length > 0 && !text.endsWith("\n")) text += "\n";
    text += input.ledgerError;
  }
  return {
    content: [{ type: "text" as const, text }],
    details,
    // Identified detour failure is a tool error, not a seat-run death (#1213).
    isError: true as const,
  };
}

/**
 * Build one detour tool definition for a configured engine name.
 * Engine process failures (nonzero/empty/spawn) and empty/invalid argv return as
 * ordinary tool results to the same seat — no seat-run abort (#1213 A3).
 * Caller AbortSignal cancellation propagates unchanged.
 */
export function createEngineDetourToolDefinition(input: {
  engineName: string;
  /** Optional pool-directive model id (#883); description only — argv stays caller-assembled. */
  engineModel?: string;
}): HostToolDefinition<typeof engineDetourArgsSchema, unknown, EngineDetourContext> {
  const engineName = input.engineName;
  const engineModel = input.engineModel;
  const engineCoord =
    engineModel === undefined
      ? `engine=${engineName}`
      : `engine=${engineName}, model=${engineModel}`;
  return {
    name: ENGINE_DETOUR_TOOL_NAME,
    label: "劳务引擎",
    description:
      `运行一次劳务引擎子进程（${engineCoord}），stdout 返回本 session。`,
    promptSnippet: "运行配置的劳务引擎一次并返回 stdout",
    parameters: engineDetourArgsSchema,
    async execute(
      toolCallId,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<HostToolResult> {
      const args = params as EngineDetourArgs;
      const argv = Array.isArray(args.argv) ? args.argv : [];

      const sessionParent = ctx.sessionManager?.getSessionFile?.();
      const startedAt = Date.now();
      const runDirectory = typeof ctx.runDirectory === "string" && ctx.runDirectory.length > 0
        ? ctx.runDirectory
        : undefined;
      const runId = runDirectory === undefined ? undefined : runIdFromRunDirectory(runDirectory);
      // Public-invocation scope + selected host from Host envelope only — never
      // courtAttemptId, never sidecar file, never pre-spawn current.json I/O.
      const invocationScopeId =
        typeof ctx.invocationScopeId === "string" && ctx.invocationScopeId.trim() !== ""
          ? ctx.invocationScopeId.trim()
          : undefined;
      const host =
        typeof ctx.host === "string" && ctx.host.trim() !== ""
          ? ctx.host.trim()
          : undefined;

      const recordCall = (observed: {
        code?: number;
        stdoutByteLength?: number;
      }): void => {
        if (typeof sessionParent !== "string" || sessionParent.length === 0) return;
        reportEngineDetourCall({
          toolCallId,
          durationMs: Math.max(0, Date.now() - startedAt),
          cwd: ctx.cwd,
          sessionParent,
          ...(runId === undefined ? {} : { runId }),
          ...(invocationScopeId === undefined ? {} : { invocationScopeId }),
          ...(host === undefined ? {} : { host }),
          ...(observed.code === undefined ? {} : { code: observed.code }),
          ...(observed.stdoutByteLength === undefined
            ? {}
            : { stdoutByteLength: observed.stdoutByteLength }),
        });
      };

      /** Record usage; on ledger failure keep the full thrown value (失败诚实, no abort). */
      const recordCallOrLedgerError = (
        observed: { code?: number; stdoutByteLength?: number },
      ): string | undefined => {
        try {
          recordCall(observed);
          return undefined;
        } catch (recordError) {
          return serializeThrownValue(recordError);
        }
      };

      if (argv.length === 0 || argv.some((part) => typeof part !== "string" || part.length === 0)) {
        // A3: parameter error returns to the seat — do not abort the run.
        // Call actually entered execute: book it with no forged process metrics (#1213 / #537).
        const ledgerError = recordCallOrLedgerError({});
        return engineFailureResult({
          text: "劳务引擎 argv 须为非空字符串数组",
          ...(ledgerError === undefined ? {} : { ledgerError }),
        });
      }

      let result: Awaited<ReturnType<typeof runEngineDetourOnce>>;
      try {
        result = await runEngineDetourOnce({
          argv,
          cwd: ctx.cwd,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        if (isCallerCancellation(error, signal)) throw error;
        // Spawn path: duration only — code/stdout bytes absent (not forged 0).
        // Return the real cause to the seat; do not abort the run (#1213).
        const engineError = asError(error, "劳务引擎 spawn 失败");
        const ledgerError = recordCallOrLedgerError({});
        const errno =
          typeof (engineError as NodeJS.ErrnoException).code === "string"
            ? (engineError as NodeJS.ErrnoException).code
            : undefined;
        return engineFailureResult({
          text: engineError.message,
          ...(errno === undefined ? {} : { errorCode: errno }),
          ...(ledgerError === undefined ? {} : { ledgerError }),
        });
      }

      const stdoutByteLength = engineDetourStdoutByteLength(result.stdout);
      const observed = { code: result.code, stdoutByteLength };

      // Classify closed-child failure before ledger write so a sitian failure
      // cannot erase nonzero/empty engine facts. Still a tool result (#1213).
      if (isEngineDetourFailure(result)) {
        const ledgerError = recordCallOrLedgerError(observed);
        return engineFailureResult({
          text: engineDetourFailureSeatText(result),
          code: result.code,
          stdout: result.stdout,
          stderr: result.stderr,
          ...(ledgerError === undefined ? {} : { ledgerError }),
        });
      }

      recordCall(observed);

      // Usage ledger lives in sitian + decisiveFacts only (#537) — not tool details.
      return {
        content: [{ type: "text" as const, text: result.stdout }],
        details: {
          tool: ENGINE_DETOUR_TOOL_NAME,
          code: result.code,
          stderr: result.stderr,
        },
      };
    },
  };
}

/**
 * Register the engine-generic detour tool once when any role has an engine
 * activation signal. Signal is request-scoped via RoleHost flag, with pi
 * child-process env as fallback (resolveEngineName). Returns whether registration occurred.
 */
export function registerEngineDetourTool(roleHost: RoleHost): boolean {
  const getFlag = (name: string) => roleHost.getFlag(name);
  const engineName = resolveEngineName(getFlag);
  if (engineName === undefined) {
    return false;
  }
  const engineModel = resolveEngineModel(getFlag);

  const definition = createEngineDetourToolDefinition({
    engineName,
    ...(engineModel === undefined ? {} : { engineModel }),
  });
  roleHost.registerTool(definition);

  return true;
}
