/**
 * Public Countersign role runtime — 门下省票庭审读官（ADR 0074）。
 * Caller supplies ticket materials via attachments + instruction; Countersign
 * reads code for facts and returns the five-question verdict.
 */
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  COUNTERSIGN_ACCEPTED_TEXT,
  COUNTERSIGN_OUTPUT_TOOL_NAME,
  countersignOutputSchema,
  projectLawfulCountersignOutput,
  retainCountersignSubmission,
} from "./countersign-contracts.ts";
import {
  failOnInfrastructureFailureDeclaration,
} from "./package-contracts/terminating-infrastructure.ts";

export {
  COUNTERSIGN_ACCEPTED_TEXT,
  COUNTERSIGN_OUTPUT_TOOL_NAME,
};

export type CountersignRoleDependencies = {
  loadSoul(): Promise<string>;
};

export type CountersignRoleHostActions = {
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
    throw new Error("给事中回执非唯一终局工具调用");
  }
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  if (
    calls.length !== 1 ||
    calls[0]?.id !== toolCallId ||
    calls[0]?.name !== COUNTERSIGN_OUTPUT_TOOL_NAME
  ) {
    throw new Error("给事中回执非唯一终局工具调用");
  }
}

export function createCountersignRoleRuntime(
  pi: ExtensionAPI,
  dependencies: CountersignRoleDependencies,
  host: CountersignRoleHostActions,
) {
  let soul: string | undefined;
  let registered = false;

  return {
    async activate() {
      const loaded = (await dependencies.loadSoul()).trim();
      if (loaded.length === 0) throw new Error("Countersign soul is empty");
      soul = loaded;

      if (!registered) {
        registered = true;
        pi.registerTool({
          name: COUNTERSIGN_OUTPUT_TOOL_NAME,
          label: "给事中输出",
          description: "提交票庭审读五问的 typed 署/封驳/上呈决议。",
          promptSnippet: "提交给事中决议",
          parameters: countersignOutputSchema,
          async execute(
            toolCallId,
            parameters,
            _signal,
            _onUpdate,
            ctx,
          ): Promise<AgentToolResult<unknown>> {
            if (soul === undefined) {
              throw new Error("给事中未激活");
            }
            // Infra declaration fails via the shared host seam before any
            // verdict projection.
            failOnInfrastructureFailureDeclaration(parameters, host, ctx, toolCallId);
            // Unique submission + terminate only. Shape is not an admission gate
            // (第 0 条 / ADR 0055): lawful verdicts projected; else params as-is.
            requireSingletonSubmissionCall(toolCallId, ctx);
            const lawful = projectLawfulCountersignOutput(parameters);
            const details = lawful ?? retainCountersignSubmission(parameters);
            return {
              content: [{ type: "text" as const, text: COUNTERSIGN_ACCEPTED_TEXT }],
              details,
              terminate: true as const,
            };
          },
        });
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) {
            throw new Error("给事中未激活");
          }
          return {
            systemPrompt: `${event.systemPrompt}\n\n<countersign_soul>\n${soul}\n</countersign_soul>`,
          };
        });
      }

      // Evidence role: keep Pi default tools + countersign output (取证本职).
      const all = pi.getAllTools().map((tool) => tool.name);
      if (all.filter((name) => name === COUNTERSIGN_OUTPUT_TOOL_NAME).length !== 1) {
        throw new Error(
          `Countersign required tool collision or missing: ${COUNTERSIGN_OUTPUT_TOOL_NAME}`,
        );
      }
    },
  };
}
