const OUTPUT_TOOLS = {
  judge: "ak_judge_output",
  fixer: "ak_fixer_output",
  coder: "ak_coder_output",
  reviewer: "ak_reviewer_output",
  collector: "ak_collector_output",
  doctor: "ak_doctor_output",
  merger: "ak_merger_output"
};
const PACKAGED_ROLE_REGISTRY = [
  { role: "judge", phases: [null], outputTool: OUTPUT_TOOLS.judge, inputFlag: void 0, phaseFlag: void 0, activationStage: "load-and-install" },
  { role: "fixer", phases: ["plan", "apply"], outputTool: OUTPUT_TOOLS.fixer, inputFlag: "ak-fix-packet", phaseFlag: "ak-fixer-phase", activationStage: "load-and-install" },
  { role: "coder", phases: ["plan", "apply"], outputTool: OUTPUT_TOOLS.coder, inputFlag: "ak-coder-task", phaseFlag: "ak-coder-phase", activationStage: "load-and-install" },
  { role: "reviewer", phases: [null], outputTool: OUTPUT_TOOLS.reviewer, inputFlag: "ak-review-task", phaseFlag: void 0, activationStage: "load-and-install" },
  { role: "collector", phases: [null], outputTool: OUTPUT_TOOLS.collector, inputFlag: "ak-collector-legs", phaseFlag: void 0, activationStage: "load-and-install" },
  { role: "doctor", phases: [null], outputTool: OUTPUT_TOOLS.doctor, inputFlag: "ak-doctor-case", phaseFlag: void 0, activationStage: "load-and-install" },
  { role: "merger", phases: [null], outputTool: OUTPUT_TOOLS.merger, inputFlag: "ak-merger-input", phaseFlag: void 0, activationStage: "prepare-git-and-install" }
];
function packagedRoleMetadata(role) {
  return PACKAGED_ROLE_REGISTRY.find((entry) => entry.role === role);
}
function packagedRoleInputFlag(role) {
  return packagedRoleMetadata(role)?.inputFlag;
}
function packagedRolePhaseFlag(role) {
  return packagedRoleMetadata(role)?.phaseFlag;
}
function packagedRoleOutputTool(role) {
  return packagedRoleMetadata(role)?.outputTool;
}
export {
  PACKAGED_ROLE_REGISTRY,
  packagedRoleInputFlag,
  packagedRoleMetadata,
  packagedRoleOutputTool,
  packagedRolePhaseFlag
};
