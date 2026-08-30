import { Type } from "typebox";
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { INSPECTOR_OUTPUT_TOOL_NAME } from "./inspector-contracts.ts";

export { INSPECTOR_OUTPUT_TOOL_NAME as INSPECTOR_OUTPUT_TOOL };
import { openToolObject } from "./open-tool-schema.ts";
import { failOnInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

const inspectorOutputSchema = openToolObject(Type.Object({
  status: Type.Unknown({ description: "pass | bounce — 形状指引，非 schema 闸" }),
  findings: Type.Unknown({ description: "string[] findings，随 pass 或 bounce 留存" }),
}));

export type InspectorRoleHostActions = {
  failInfrastructure(error: unknown, ctx: ExtensionContext, toolCallId?: string): never;
};

/** Direct Inspector activation; the shared envelope owns its lifecycle. */
export function createInspectorRoleRuntime(
  pi: ExtensionAPI,
  dependencies: { loadSoul(): Promise<string> },
  host: InspectorRoleHostActions,
) {
  let soul: string | undefined;
  let registered = false;

  return {
    async activate(): Promise<void> {
      soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Inspector soul is empty");

      if (!registered) {
        registered = true;
        pi.registerTool({
          name: INSPECTOR_OUTPUT_TOOL_NAME,
          label: "给事中输出",
          description: "提交复杂度与测试质量的 typed pass/bounce 决议。",
          promptSnippet: "提交给事中决议",
          parameters: inspectorOutputSchema,
          async execute(toolCallId, parameters, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
            failOnInfrastructureFailureDeclaration(parameters, host, ctx, toolCallId);
            return {
              content: [{ type: "text" as const, text: "Inspector verdict accepted" }],
              details: parameters,
              terminate: true as const,
            };
          },
        });
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("给事中未激活");
          return { systemPrompt: `${event.systemPrompt}\n\n<inspector_soul>\n${soul}\n</inspector_soul>` };
        });
      }

      const tools = pi.getAllTools().filter((tool) => tool.name === INSPECTOR_OUTPUT_TOOL_NAME);
      if (tools.length !== 1) throw new Error(`Inspector required tool collision or missing: ${INSPECTOR_OUTPUT_TOOL_NAME}`);
    },
  };
}
