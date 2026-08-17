/**
 * Package-owned engine detour tool (#357 T2 / #378).
 * Registered by shared role-runtime when Judge|Reviewer + engine activation signal is present.
 * Evidence-child legs install the same definition via customTools (no spawn in role modules).
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import {
  ENGINE_DETOUR_ALREADY_USED_DIAGNOSTIC,
  ENGINE_DETOUR_TOOL_NAME,
  engineDetourFailureDiagnostic,
  engineNameFromEnv,
  isEngineDetourFailure,
  runEngineDetourOnce,
} from "./engine-detour.ts";
import { wrapPackageOwnedToolDefinition } from "./package-owned-tool-idle.ts";

const engineDetourArgsSchema = Type.Object(
  {
    argv: Type.Array(Type.String({ minLength: 1 }), {
      minItems: 1,
      description:
        "Executable argv for one engine subprocess. First element is the command (PATH lookup); remaining elements are arguments. Build argv from the host CLI actual interface for the configured engine name; when optional packaged notes are present in the session prompt, follow those bytes. Do not invent package flags.",
    }),
  },
  { additionalProperties: false },
);

type EngineDetourArgs = Static<typeof engineDetourArgsSchema>;

export type EngineDetourHostActions = {
  failInfrastructure(
    error: unknown,
    ctx: ExtensionContext,
    toolCallId?: string,
  ): never;
};

export type EngineDetourToolRegistration = {
  /** True when the tool definition was installed on this ExtensionAPI. */
  readonly registered: boolean;
};

type EngineDetourLatch = { used: boolean };

/**
 * Build one once-latch detour tool definition for a configured engine name.
 * `latch` is shared so parent registration can reset between activations.
 * `fail` owns host abort (parent) vs throw (evidence child).
 */
export function createEngineDetourToolDefinition(input: {
  engineName: string;
  latch?: EngineDetourLatch;
  fail: (error: Error, toolCallId: string, ctx: ExtensionContext) => never;
}): ToolDefinition {
  const latch = input.latch ?? { used: false };
  const engineName = input.engineName;
  return wrapPackageOwnedToolDefinition({
    name: ENGINE_DETOUR_TOOL_NAME,
    label: "Engine Detour",
    description:
      `Run one labor-engine subprocess (engine=${engineName}) and return its stdout to this session. Call at most once per activation. Build argv from the host CLI actual interface for this engine name; when optional packaged notes are present in the session prompt, follow those bytes too.`,
    promptSnippet: "Run the configured labor engine once and return its stdout",
    promptGuidelines: [
      `Use ${ENGINE_DETOUR_TOOL_NAME} exactly once for the configured engine (${engineName}). Optional packaged notes are guidance when present; a bare engine name alone is also a valid call path.`,
      "Pass argv for the host CLI of this engine name — first element is the executable name on PATH. Follow optional packaged notes when delivered; otherwise act from the engine name and the host CLI actual interface. Do not invent package flags.",
      "On success, use the returned stdout as labor content for the existing typed submission / report path.",
    ],
    parameters: engineDetourArgsSchema,
    async execute(
      toolCallId,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<unknown>> {
      if (latch.used) {
        input.fail(
          new Error(ENGINE_DETOUR_ALREADY_USED_DIAGNOSTIC),
          toolCallId,
          ctx,
        );
      }
      latch.used = true;

      const args = params as EngineDetourArgs;
      const argv = Array.isArray(args.argv) ? args.argv : [];
      if (argv.length === 0 || argv.some((part) => typeof part !== "string" || part.length === 0)) {
        input.fail(
          new Error("engine detour argv must be a non-empty string array"),
          toolCallId,
          ctx,
        );
      }

      let result: Awaited<ReturnType<typeof runEngineDetourOnce>>;
      try {
        result = await runEngineDetourOnce({
          argv,
          cwd: ctx.cwd,
          ...(signal === undefined ? {} : { signal }),
        });
      } catch (error) {
        input.fail(
          error instanceof Error ? error : new Error(String(error)),
          toolCallId,
          ctx,
        );
      }

      if (isEngineDetourFailure(result)) {
        input.fail(
          new Error(engineDetourFailureDiagnostic(result)),
          toolCallId,
          ctx,
        );
      }

      return {
        content: [{ type: "text" as const, text: result.stdout }],
        details: {
          tool: ENGINE_DETOUR_TOOL_NAME,
          code: result.code,
        },
      };
    },
  }) as ToolDefinition;
}

/**
 * Register the engine-generic detour tool once for this process when Judge/Reviewer has
 * an engine activation signal. Returns whether registration occurred.
 * Once-latch is activation-scoped via the returned reset handle.
 */
export function registerEngineDetourTool(
  pi: ExtensionAPI,
  hostActions: EngineDetourHostActions,
): EngineDetourToolRegistration & { resetLatch(): void } {
  const engineName = engineNameFromEnv();
  if (engineName === undefined) {
    return {
      registered: false,
      resetLatch() {
        /* no-op when unregistered */
      },
    };
  }

  const latch: EngineDetourLatch = { used: false };
  const definition = createEngineDetourToolDefinition({
    engineName,
    latch,
    fail(error, toolCallId, ctx) {
      hostActions.failInfrastructure(error, ctx, toolCallId);
    },
  });
  pi.registerTool(definition);

  return {
    registered: true,
    resetLatch() {
      latch.used = false;
    },
  };
}
