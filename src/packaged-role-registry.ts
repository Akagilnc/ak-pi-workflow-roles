/** The single package-owned source for role attendance and settlement metadata. */
import { COLLECTOR_OUTPUT_TOOL } from "./package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "./package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "./package-contracts/reviewer-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "./package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "./doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "./merger-contracts.ts";

export const PACKAGED_ROLE_REGISTRY = [
  { role: "judge", phases: [null], outputTool: JUDGE_OUTPUT_TOOL_NAME, inputFlag: undefined, phaseFlag: undefined, activationStage: "load-and-install" },
  { role: "fixer", phases: ["plan", "apply"], outputTool: FIXER_OUTPUT_TOOL_NAME, inputFlag: "ak-fix-packet", phaseFlag: "ak-fixer-phase", activationStage: "load-and-install" },
  { role: "coder", phases: ["plan", "apply"], outputTool: CODER_OUTPUT_TOOL_NAME, inputFlag: "ak-coder-task", phaseFlag: "ak-coder-phase", activationStage: "load-and-install" },
  { role: "reviewer", phases: [null], outputTool: REVIEWER_OUTPUT_TOOL_NAME, inputFlag: "ak-review-task", phaseFlag: undefined, activationStage: "load-and-install" },
  { role: "collector", phases: [null], outputTool: COLLECTOR_OUTPUT_TOOL, inputFlag: "ak-collector-legs", phaseFlag: undefined, activationStage: "load-and-install" },
  { role: "doctor", phases: [null], outputTool: DOCTOR_OUTPUT_TOOL_NAME, inputFlag: "ak-doctor-case", phaseFlag: undefined, activationStage: "load-and-install" },
  { role: "merger", phases: [null], outputTool: MERGER_OUTPUT_TOOL_NAME, inputFlag: "ak-merger-input", phaseFlag: undefined, activationStage: "prepare-git-and-install" },
] as const;

export type PackagedRole = (typeof PACKAGED_ROLE_REGISTRY)[number]["role"];
export type PackagedRoleMetadata = (typeof PACKAGED_ROLE_REGISTRY)[number];

export function packagedRoleMetadata(role: string): PackagedRoleMetadata | undefined {
  return PACKAGED_ROLE_REGISTRY.find((entry) => entry.role === role);
}

export function packagedRoleInputFlag(role: string): string | undefined {
  return packagedRoleMetadata(role)?.inputFlag;
}

export function packagedRolePhaseFlag(role: string): string | undefined {
  return packagedRoleMetadata(role)?.phaseFlag;
}

export function packagedRoleOutputTool(role: string): string | undefined {
  return packagedRoleMetadata(role)?.outputTool;
}
