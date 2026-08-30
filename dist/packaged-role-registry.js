import { COLLECTOR_OUTPUT_TOOL } from "./package-contracts/collector-output.js";
import { JUDGE_OUTPUT_TOOL_NAME } from "./package-contracts/judge-output.js";
import { REVIEWER_OUTPUT_TOOL_NAME } from "./package-contracts/reviewer-output.js";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "./package-contracts/worker-output.js";
import { DOCTOR_OUTPUT_TOOL_NAME } from "./doctor-contracts.js";
import { MERGER_OUTPUT_TOOL_NAME } from "./merger-contracts.js";
import { NOTARY_OUTPUT_TOOL_NAME } from "./notary-contracts.js";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "./inspector-contracts.js";
const PACKAGED_ROLE_REGISTRY = [
  { role: "judge", phases: [null], outputTool: JUDGE_OUTPUT_TOOL_NAME, inputFlag: void 0, phaseFlag: void 0, activationStage: "load-and-install" },
  { role: "fixer", phases: ["plan", "apply"], outputTool: FIXER_OUTPUT_TOOL_NAME, inputFlag: "ak-fix-packet", phaseFlag: "ak-fixer-phase", activationStage: "load-and-install" },
  { role: "coder", phases: ["plan", "apply"], outputTool: CODER_OUTPUT_TOOL_NAME, inputFlag: "ak-coder-task", phaseFlag: "ak-coder-phase", activationStage: "load-and-install" },
  { role: "reviewer", phases: [null], outputTool: REVIEWER_OUTPUT_TOOL_NAME, inputFlag: void 0, phaseFlag: void 0, activationStage: "load-and-install" },
  // ak-collector-repo is GitHub owner/repo identity, not a local material path (#438).
  { role: "collector", phases: [null], outputTool: COLLECTOR_OUTPUT_TOOL, inputFlag: void 0, phaseFlag: void 0, activationStage: "load-and-install" },
  { role: "doctor", phases: [null], outputTool: DOCTOR_OUTPUT_TOOL_NAME, inputFlag: "ak-doctor-case", phaseFlag: void 0, activationStage: "load-and-install" },
  { role: "merger", phases: [null], outputTool: MERGER_OUTPUT_TOOL_NAME, inputFlag: "ak-merger-input", phaseFlag: void 0, activationStage: "prepare-git-and-install" },
  { role: "notary", phases: [null], outputTool: NOTARY_OUTPUT_TOOL_NAME, inputFlag: "ak-notary-source-run", phaseFlag: void 0, activationStage: "load-and-install" },
  { role: "inspector", phases: [null], outputTool: INSPECTOR_OUTPUT_TOOL_NAME, inputFlag: void 0, phaseFlag: void 0, activationStage: "load-and-install" }
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
