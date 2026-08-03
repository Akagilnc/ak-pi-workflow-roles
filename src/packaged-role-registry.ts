/** The single package-owned source for role attendance and settlement metadata. */
const OUTPUT_TOOLS = {
  judge: "ak_judge_output",
  fixer: "ak_fixer_output",
  coder: "ak_coder_output",
  reviewer: "ak_reviewer_output",
  collector: "ak_collector_output",
  doctor: "ak_doctor_output",
  merger: "ak_merger_output",
} as const;
export const PACKAGED_ROLE_REGISTRY = [
  { role: "judge", phases: [null], outputTool: OUTPUT_TOOLS.judge, inputFlag: undefined, phaseFlag: undefined, activationStage: "load-and-install" },
  { role: "fixer", phases: ["plan", "apply"], outputTool: OUTPUT_TOOLS.fixer, inputFlag: "ak-fix-packet", phaseFlag: "ak-fixer-phase", activationStage: "load-and-install" },
  { role: "coder", phases: ["plan", "apply"], outputTool: OUTPUT_TOOLS.coder, inputFlag: "ak-coder-task", phaseFlag: "ak-coder-phase", activationStage: "load-and-install" },
  { role: "reviewer", phases: [null], outputTool: OUTPUT_TOOLS.reviewer, inputFlag: "ak-review-task", phaseFlag: undefined, activationStage: "load-and-install" },
  { role: "collector", phases: [null], outputTool: OUTPUT_TOOLS.collector, inputFlag: "ak-collector-legs", phaseFlag: undefined, activationStage: "load-and-install" },
  { role: "doctor", phases: [null], outputTool: OUTPUT_TOOLS.doctor, inputFlag: "ak-doctor-case", phaseFlag: undefined, activationStage: "load-and-install" },
  { role: "merger", phases: [null], outputTool: OUTPUT_TOOLS.merger, inputFlag: "ak-merger-input", phaseFlag: undefined, activationStage: "prepare-git-and-install" },
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
