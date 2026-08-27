/**
 * Public Notary role runtime — direct officer seat (not through Gatekeeper province).
 * Caller supplies only a source-run locator; Notary self-fetches authoritative materials.
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  NOTARY_ACCEPTED_TEXT,
  NOTARY_OUTPUT_TOOL_NAME,
  NOTARY_SOURCE_RUN_FLAG,
  notaryOutputSchema,
  validateNotaryOutput,
  type NotarySourceRunLocator,
} from "./notary-contracts.ts";

export {
  NOTARY_ACCEPTED_TEXT,
  NOTARY_OUTPUT_TOOL_NAME,
  NOTARY_SOURCE_RUN_FLAG,
};

export type NotaryRoleDependencies = {
  loadSoul(): Promise<string>;
  loadSourceRunLocator(path: string): Promise<NotarySourceRunLocator>;
};

export type NotaryRoleHostActions = {
  failInfrastructure(
    error: unknown,
    ctx: ExtensionContext,
    toolCallId?: string,
  ): never;
};

function requireSingletonSubmissionCall(
  toolCallId: string,
  ctx: ExtensionContext,
): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") {
    throw new Error("符宝郎回执非唯一终局工具调用");
  }
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  if (
    calls.length !== 1 ||
    calls[0]?.id !== toolCallId ||
    calls[0]?.name !== NOTARY_OUTPUT_TOOL_NAME
  ) {
    throw new Error("符宝郎回执非唯一终局工具调用");
  }
}

export function createNotaryRoleRuntime(
  pi: ExtensionAPI,
  dependencies: NotaryRoleDependencies,
  host: NotaryRoleHostActions,
) {
  let activation:
    | { soul: string; sourceRun: NotarySourceRunLocator }
    | undefined;
  let registered = false;
  pi.registerFlag(
    NOTARY_SOURCE_RUN_FLAG.name,
    NOTARY_SOURCE_RUN_FLAG.definition,
  );

  return {
    async activate() {
      const path = pi.getFlag(NOTARY_SOURCE_RUN_FLAG.name);
      if (typeof path !== "string" || path.trim() === "") {
        throw new Error("Notary requires --ak-notary-source-run");
      }
      const soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Notary soul is empty");
      const sourceRun = await dependencies.loadSourceRunLocator(path);
      activation = { soul, sourceRun };

      if (!registered) {
        registered = true;
        pi.registerTool({
          name: NOTARY_OUTPUT_TOOL_NAME,
          label: "符宝郎输出",
          description: "提交引文保真与票面对齐的 typed pass/bounce 决议。",
          promptSnippet: "提交符宝郎决议",
          parameters: notaryOutputSchema,
          async execute(
            toolCallId,
            parameters,
            _signal,
            _onUpdate,
            ctx,
          ): Promise<AgentToolResult<unknown>> {
            if (activation === undefined) {
              throw new Error("Notary is not activated");
            }
            let output;
            try {
              requireSingletonSubmissionCall(toolCallId, ctx);
              output = validateNotaryOutput(parameters);
            } catch (error) {
              // Non-explicit release stays a rejected terminating call so public
              // settlement can map it to the existing non-zero failure channel (#475).
              throw error instanceof Error
                ? error
                : new Error(String(error));
            }
            return {
              content: [{ type: "text" as const, text: NOTARY_ACCEPTED_TEXT }],
              details: output,
              terminate: true as const,
            };
          },
        });
        pi.on("before_agent_start", (event) => {
          if (activation === undefined) {
            throw new Error("Notary is not activated");
          }
          // Locator only — never preload ticket/diff/draft body (self-fetch contract).
          const bound = {
            sourceRun: activation.sourceRun,
          };
          return {
            systemPrompt: `${event.systemPrompt}\n\n<notary_soul>\n${activation.soul}\n</notary_soul>\n\n<notary_source_run>\n${JSON.stringify(bound)}\n</notary_source_run>`,
          };
        });
      }

      // Evidence role: keep Pi default tools + notary output (ADR 0064 unrestricted).
      const all = pi.getAllTools().map((tool) => tool.name);
      if (all.filter((name) => name === NOTARY_OUTPUT_TOOL_NAME).length !== 1) {
        throw new Error(
          `Notary required tool collision or missing: ${NOTARY_OUTPUT_TOOL_NAME}`,
        );
      }
    },
  };
}
