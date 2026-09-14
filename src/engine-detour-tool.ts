/**
 * Package-owned engine detour tool (#357 T2 / #378 / #380).
 * Registered by shared role-runtime when any role + engine activation signal is present.
 * Evidence-child legs install the same definition via customTools (no spawn in role modules).
 * Engine process failures stop through the host infrastructure-failure seam.
 * Caller AbortSignal cancellation propagates unchanged.
 */
import { basename } from "node:path";
import { Type, type Static } from "typebox";
import type { HostContext, HostToolDefinition, HostToolResult, RoleHost } from "./host-contracts.ts";

import {
  ENGINE_DETOUR_TOOL_NAME,
  engineDetourFailureDiagnostic,
  isEngineDetourFailure,
  resolveEngineModel,
  resolveEngineName,
  runEngineDetourOnce,
} from "./engine-detour.ts";
import {
  engineDetourStdoutByteLength,
  readInvocationSelectedHost,
  reportEngineDetourCall,
} from "./engine-detour-usage.ts";

/** runDirectory leaf is `<runId>@<role>`; subject is optional. */
function basenameRunId(runDirectory: string): string | undefined {
  const leaf = basename(runDirectory);
  const at = leaf.indexOf("@");
  if (at <= 0) return undefined;
  return leaf.slice(0, at);
}

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
  /** Selected host when already projected onto HostContext. */
  host?: string;
};

export type EngineDetourHostActions = {
  failInfrastructure(
    error: unknown,
    ctx: EngineDetourContext,
    toolCallId?: string,
  ): never;
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

/**
 * Build one detour tool definition for a configured engine name.
 * `fail` owns host abort (parent) vs throw (evidence child) for tool misuse only.
 * Engine process failures (nonzero/empty/spawn) stop via `fail` with their cause.
 * Caller AbortSignal cancellation propagates unchanged.
 */
export function createEngineDetourToolDefinition(input: {
  engineName: string;
  /** Optional pool-directive model id (#883); description only — argv stays caller-assembled. */
  engineModel?: string;
  fail: (error: Error, toolCallId: string, ctx: EngineDetourContext) => never;
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
      if (argv.length === 0 || argv.some((part) => typeof part !== "string" || part.length === 0)) {
        input.fail(
          new Error("劳务引擎 argv 须为非空字符串数组"),
          toolCallId,
          ctx,
        );
      }

      const sessionParent = ctx.sessionManager?.getSessionFile?.();
      const startedAt = Date.now();
      const runDirectory = typeof ctx.runDirectory === "string" && ctx.runDirectory.length > 0
        ? ctx.runDirectory
        : undefined;
      const runId = runDirectory === undefined ? undefined : basenameRunId(runDirectory);
      // Public-invocation scope from Host envelope only — never courtAttemptId, never sidecar file.
      const invocationScopeId =
        typeof ctx.invocationScopeId === "string" && ctx.invocationScopeId.trim() !== ""
          ? ctx.invocationScopeId.trim()
          : undefined;
      const host =
        typeof ctx.host === "string" && ctx.host.trim() !== ""
          ? ctx.host.trim()
          : runDirectory === undefined
            ? undefined
            : readInvocationSelectedHost(runDirectory);

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

      /** Preserve engine cause; if ledger write also fails, keep both (失败诚实). */
      const failAfterLedger = (
        engineCause: Error,
        observed: { code?: number; stdoutByteLength?: number },
        aggregateMessage: string,
      ): never => {
        try {
          recordCall(observed);
        } catch (recordError) {
          input.fail(
            new AggregateError(
              [
                engineCause,
                asError(recordError, "engine detour usage ledger write failed"),
              ],
              aggregateMessage,
              { cause: engineCause },
            ),
            toolCallId,
            ctx,
          );
        }
        input.fail(engineCause, toolCallId, ctx);
      };

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
        return failAfterLedger(
          asError(error, "劳务引擎 spawn 失败"),
          {},
          "engine detour spawn and usage ledger both failed",
        );
      }

      const stdoutByteLength = engineDetourStdoutByteLength(result.stdout);
      const observed = { code: result.code, stdoutByteLength };

      // Classify closed-child failure before ledger write so a sitian failure
      // cannot erase nonzero/empty engine facts.
      if (isEngineDetourFailure(result)) {
        return failAfterLedger(
          new Error(engineDetourFailureDiagnostic(result)),
          observed,
          "engine detour child-close and usage ledger both failed",
        );
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
export function registerEngineDetourTool(
  roleHost: RoleHost,
  hostActions: EngineDetourHostActions,
): boolean {
  const getFlag = (name: string) => roleHost.getFlag(name);
  const engineName = resolveEngineName(getFlag);
  if (engineName === undefined) {
    return false;
  }
  const engineModel = resolveEngineModel(getFlag);

  const definition = createEngineDetourToolDefinition({
    engineName,
    ...(engineModel === undefined ? {} : { engineModel }),
    fail(error, toolCallId, ctx) {
      hostActions.failInfrastructure(error, ctx, toolCallId);
    },
  });
  roleHost.registerTool(definition);

  return true;
}
