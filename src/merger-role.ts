import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MERGER_ACCEPTED_TEXT, MERGER_OUTPUT_TOOL_NAME, mergerOutputSchema, validateMergerInput, validateMergerOutput, type MergerInput } from "./merger-contracts.ts";
import type { MergerGitState } from "./merger-git-state.ts";
import { failOnInfrastructureFailureDeclaration, withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";
import { exactUtf8 } from "./exact-utf8.ts";
import { isFullGitObjectId } from "./git-object-id.ts";

export { MERGER_OUTPUT_TOOL_NAME };
export const MERGER_INPUT_FLAG = { name: "ak-merger-input", definition: { description: "Path to an immutable digest-bound Merger v1 input JSON file", type: "string" as const } } as const;
export const MERGER_ACTIVE_TOOLS = ["read", "grep", "find", "ls", "bash", "write", "edit", MERGER_OUTPUT_TOOL_NAME] as const;
export type MergerRoleDependencies = { loadSoul(): Promise<string>; loadInput(path: string): Promise<unknown>; gitState: MergerGitState };
export type MergerRoleHostActions = { failInfrastructure(error: unknown, ctx: ExtensionContext, toolCallId?: string): never };

function same(a: readonly string[], b: readonly string[]): boolean { return a.length === b.length && a.every((value, i) => value === b[i]); }
function singleton(id: string, ctx: ExtensionContext): void { const leaf = ctx.sessionManager.getLeafEntry(); if (leaf?.type !== "message" || leaf.message.role !== "assistant") throw new Error("合并回执非唯一终局工具调用"); const calls = leaf.message.content.filter(part => part.type === "toolCall"); if (calls.length !== 1 || calls[0]?.id !== id || calls[0]?.name !== MERGER_OUTPUT_TOOL_NAME) throw new Error("合并回执非唯一终局工具调用"); }
function materialText(input: MergerInput, key: keyof MergerInput["materials"]): string { return exactUtf8(Buffer.from(input.materials[key].bytesBase64, "base64"), `Merger ${key}`); }

export function createMergerRoleRuntime(pi: ExtensionAPI, dependencies: MergerRoleDependencies, host: MergerRoleHostActions) {
  let activation: { soul: string; input: Readonly<MergerInput>; automaticMergeTreeId: string } | undefined;
  let registered = false;
  let accepted = false;
  pi.registerFlag(MERGER_INPUT_FLAG.name, MERGER_INPUT_FLAG.definition);
  return { async activate() {
    const path = pi.getFlag(MERGER_INPUT_FLAG.name);
    if (typeof path !== "string" || path.trim().length === 0) throw new Error("Merger requires --ak-merger-input");
    const soul = (await dependencies.loadSoul()).trim(); if (!soul) throw new Error("Merger soul is empty");
    const input = validateMergerInput(await dependencies.loadInput(path));
    const state = await dependencies.gitState.activeMerge();
    if (state.targetObjectId !== input.targetObjectId || state.sourceObjectId !== input.sourceObjectId || !same(state.unmergedPaths, input.expectedConflictPaths) || state.unmergedPaths.length === 0 || !isFullGitObjectId(state.automaticMergeTreeId) || state.automaticMergeTreeId.length !== input.targetObjectId.length) throw new Error("Merger activation rejected repository parent, merge, automatic-result, or complete conflict-set drift");
    activation = { soul, input, automaticMergeTreeId: state.automaticMergeTreeId }; accepted = false;
    if (!registered) { registered = true;
      pi.registerTool({ name: MERGER_OUTPUT_TOOL_NAME, label: "合并输出", description: "提交合并结果；输出分支为 completed 与 escalate；基础设施及 Git 失败经共享 host seam 承接。", promptSnippet: "提交合并结果", parameters: withInfrastructureFailureDeclaration(mergerOutputSchema),
        async execute(id, params, _signal, _update, ctx) {
          if (!activation) throw new Error("校书郎未激活");
          if (accepted) throw new Error("合并回执已受理");
          // #541: infra declaration fails via the shared host seam before output
          // validation / Git verification / accepted=true.
          failOnInfrastructureFailureDeclaration(params, host, ctx, id);
          let output;
          try {
            singleton(id, ctx);
            output = validateMergerOutput(params, activation.input.attemptId);
          } catch (error) {
            host.failInfrastructure(error, ctx, id);
          }
          if (output.status === "completed") {
            let state;
            try { state = await dependencies.gitState.completedMerge(output.mergeCommitId, activation.automaticMergeTreeId); }
            catch (error) { host.failInfrastructure(error, ctx, id); }
            const scope = new Set(activation.input.resolutionScope);
            if (state.mergeCommitId !== output.mergeCommitId || !same(state.parentObjectIds, [activation.input.targetObjectId, activation.input.sourceObjectId]) || state.unmergedPaths.length !== 0 || !state.worktreeClean || state.resolutionChangedPaths.some(path => !scope.has(path))) host.failInfrastructure(new Error("Merger completed-state verification failed"), ctx, id);
          }
          accepted = true;
          const acceptedDetails = output;
          return { content: [{ type: "text" as const, text: MERGER_ACCEPTED_TEXT }], details: acceptedDetails, terminate: true as const };
        } });
      pi.on("before_agent_start", event => { if (!activation) throw new Error("校书郎未激活"); const admitted = { attemptId: activation.input.attemptId, targetObjectId: activation.input.targetObjectId, sourceObjectId: activation.input.sourceObjectId, task: materialText(activation.input, "task"), authority: materialText(activation.input, "authority"), targetIntent: materialText(activation.input, "targetIntent"), sourceIntent: materialText(activation.input, "sourceIntent"), expectedConflictPaths: activation.input.expectedConflictPaths, resolutionScope: activation.input.resolutionScope, authorizedChecks: activation.input.authorizedChecks }; return { systemPrompt: `${event.systemPrompt}\n\n<merger_soul>\n${activation.soul}\n</merger_soul>\n\n<merger_assignment>\n${JSON.stringify(admitted)}\n</merger_assignment>` }; });
    }
    const all = pi.getAllTools().map(tool => tool.name);
    for (const name of MERGER_ACTIVE_TOOLS) if (all.filter(item => item === name).length !== 1) throw new Error(`Merger required tool collision or missing: ${name}`);
    pi.setActiveTools([...MERGER_ACTIVE_TOOLS]);
    const active = pi.getActiveTools?.() ?? [...MERGER_ACTIVE_TOOLS];
    if (!same(active, MERGER_ACTIVE_TOOLS)) throw new Error("Merger active tool narrowing failed");
  } };
}
