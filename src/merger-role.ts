import type { RoleHost, HostContext } from "./host-contracts.ts";
import {
  MERGER_ACCEPTED_TEXT,
  MERGER_OUTPUT_TOOL_NAME,
  mergerOutputSchema,
  validateMergerInput,
  type MergerInput,
} from "./merger-contracts.ts";
import { exactUtf8 } from "./exact-utf8.ts";

export { MERGER_OUTPUT_TOOL_NAME };
export const MERGER_INPUT_FLAG = { name: "ak-merger-input", definition: { description: "Path to Merger assignment materials JSON", type: "string" as const } } as const;

export type MergerRoleDependencies = { loadSoul(): Promise<string>; loadInput(path: string): Promise<unknown>; };

function materialText(input: MergerInput, key: keyof MergerInput["materials"]): string {
  return exactUtf8(Buffer.from(input.materials[key].bytesBase64, "base64"), `Merger ${key}`);
}

/**
 * Merger (校书郎) role runtime.
 * Submission tool records every call (#836); host end is the final.
 * Git state / completion verification are not attendance or rejection gates (#827).
 */
export function createMergerRoleRuntime(pi: RoleHost, dependencies: MergerRoleDependencies) {
  let activation: { soul: string; input: Readonly<MergerInput> } | undefined;
  let registered = false;
  pi.registerFlag(MERGER_INPUT_FLAG.name, MERGER_INPUT_FLAG.definition);
  return {
    async activate() {
      const path = pi.getFlag(MERGER_INPUT_FLAG.name);
      if (typeof path !== "string" || path.trim().length === 0) throw new Error("Merger requires --ak-merger-input");
      const soul = (await dependencies.loadSoul()).trim();
      if (!soul) throw new Error("Merger soul is empty");
      const input = validateMergerInput(await dependencies.loadInput(path));
      activation = { soul, input };
      if (!registered) {
        registered = true;
        pi.registerTool({
          name: MERGER_OUTPUT_TOOL_NAME, label: "合并输出", description: "提交合并结果；输出分支为 completed 与 escalate。", promptSnippet: "提交合并结果", parameters: mergerOutputSchema,
          async execute(_id: string, params: unknown, _signal: AbortSignal | undefined, _update: unknown, _ctx: HostContext) {
            if (!activation) throw new Error("校书郎未激活");
            return { content: [{ type: "text" as const, text: MERGER_ACCEPTED_TEXT }], details: params, terminate: true as const };
          },
        });
        pi.on("before_agent_start", (event) => {
          if (!activation) throw new Error("校书郎未激活");
          const admitted = { attemptId: activation.input.attemptId, targetObjectId: activation.input.targetObjectId, sourceObjectId: activation.input.sourceObjectId, task: materialText(activation.input, "task"), authority: materialText(activation.input, "authority"), targetIntent: materialText(activation.input, "targetIntent"), sourceIntent: materialText(activation.input, "sourceIntent"), expectedConflictPaths: activation.input.expectedConflictPaths, resolutionScope: activation.input.resolutionScope, authorizedChecks: activation.input.authorizedChecks };
          return { systemPrompt: `${event.systemPrompt}\n\n<merger_soul>\n${activation.soul}\n</merger_soul>\n\n<merger_assignment>\n${JSON.stringify(admitted)}\n</merger_assignment>` };
        });
      }
      const all = pi.getAllTools().map((tool) => tool.name);
      if (all.filter((item) => item === MERGER_OUTPUT_TOOL_NAME).length !== 1) {
        throw new Error(`Merger required tool collision or missing: ${MERGER_OUTPUT_TOOL_NAME}`);
      }
    },
  };
}
