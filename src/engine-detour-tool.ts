/**
 * Package-owned engine detour tool (#357 T2).
 * Registered by shared role-runtime when Judge + engine activation signal is present.
 * Forbidden in judge-role.ts (lifecycle ban — no spawn in role modules).
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
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

/**
 * Register the engine-generic detour tool once for this process when Judge has
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

  let used = false;

  pi.registerTool({
    name: ENGINE_DETOUR_TOOL_NAME,
    label: "Engine Detour",
    description:
      `Run one labor-engine subprocess (engine=${engineName}) and return its stdout to this session. Call at most once per activation. Build argv from the host CLI actual interface for this engine name; when optional packaged notes are present in the session prompt, follow those bytes too.`,
    promptSnippet: "Run the configured labor engine once and return its stdout",
    promptGuidelines: [
      `Use ${ENGINE_DETOUR_TOOL_NAME} exactly once for the configured engine (${engineName}). Optional packaged notes are guidance when present; a bare engine name alone is also a valid call path.`,
      "Pass argv for the host CLI of this engine name — first element is the executable name on PATH. Follow optional packaged notes when delivered; otherwise act from the engine name and the host CLI actual interface. Do not invent package flags.",
      "On success, use the returned stdout as labor content for the existing typed submission tool.",
    ],
    parameters: engineDetourArgsSchema,
    async execute(
      toolCallId,
      params,
      signal,
      _onUpdate,
      ctx,
    ): Promise<AgentToolResult<unknown>> {
      if (used) {
        hostActions.failInfrastructure(
          new Error(ENGINE_DETOUR_ALREADY_USED_DIAGNOSTIC),
          ctx,
          toolCallId,
        );
      }
      used = true;

      const args = params as EngineDetourArgs;
      const argv = Array.isArray(args.argv) ? args.argv : [];
      if (argv.length === 0 || argv.some((part) => typeof part !== "string" || part.length === 0)) {
        hostActions.failInfrastructure(
          new Error("engine detour argv must be a non-empty string array"),
          ctx,
          toolCallId,
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
        hostActions.failInfrastructure(error, ctx, toolCallId);
      }

      if (isEngineDetourFailure(result)) {
        hostActions.failInfrastructure(
          new Error(engineDetourFailureDiagnostic(result)),
          ctx,
          toolCallId,
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
  });

  return {
    registered: true,
    resetLatch() {
      used = false;
    },
  };
}
