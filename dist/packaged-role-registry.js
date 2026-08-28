import { COLLECTOR_OUTPUT_TOOL } from "./package-contracts/collector-output.js";
import { JUDGE_OUTPUT_TOOL_NAME } from "./package-contracts/judge-output.js";
import { REVIEWER_OUTPUT_TOOL_NAME } from "./package-contracts/reviewer-output.js";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "./package-contracts/worker-output.js";
import { DOCTOR_OUTPUT_TOOL_NAME } from "./doctor-contracts.js";
import { MERGER_OUTPUT_TOOL_NAME } from "./merger-contracts.js";
import { NOTARY_OUTPUT_TOOL_NAME } from "./notary-contracts.js";
const NOTARY_SESSION_MATERIALS = [
  "CLAUDE.md",
  "souls/notary.md",
  "souls/gate-output-guide.md"
];
const PUBLIC_ROLE_RECORDS = [
  {
    role: "judge",
    phases: [null],
    outputTool: JUDGE_OUTPUT_TOOL_NAME,
    inputFlag: void 0,
    phaseFlag: void 0,
    activationStage: "load-and-install",
    sessionMaterials: [
      "CLAUDE.md",
      "souls/judge.md",
      "souls/audit-law.md",
      "souls/quality-law.md",
      "souls/judge-output-guide.md"
    ]
  },
  {
    role: "fixer",
    phases: ["plan", "apply"],
    outputTool: FIXER_OUTPUT_TOOL_NAME,
    inputFlag: "ak-fix-packet",
    phaseFlag: "ak-fixer-phase",
    activationStage: "load-and-install",
    sessionMaterials: [
      "CLAUDE.md",
      "souls/fixer.md",
      "souls/quality-law.md",
      "souls/fixer-output-guide.md"
    ]
  },
  {
    role: "coder",
    phases: ["plan", "apply"],
    outputTool: CODER_OUTPUT_TOOL_NAME,
    inputFlag: "ak-coder-task",
    phaseFlag: "ak-coder-phase",
    activationStage: "load-and-install",
    sessionMaterials: [
      "CLAUDE.md",
      "souls/coder.md",
      "souls/quality-law.md",
      "souls/coder-output-guide.md"
    ]
  },
  {
    role: "reviewer",
    phases: [null],
    outputTool: REVIEWER_OUTPUT_TOOL_NAME,
    inputFlag: void 0,
    phaseFlag: void 0,
    activationStage: "load-and-install",
    sessionMaterials: [
      "CLAUDE.md",
      "souls/reviewer.md",
      "souls/audit-law.md",
      "souls/quality-law.md"
    ]
  },
  // ak-collector-repo is GitHub owner/repo identity, not a local material path (#438).
  {
    role: "collector",
    phases: [null],
    outputTool: COLLECTOR_OUTPUT_TOOL,
    inputFlag: void 0,
    phaseFlag: void 0,
    activationStage: "load-and-install",
    sessionMaterials: ["CLAUDE.md", "souls/collector.md"]
  },
  {
    role: "doctor",
    phases: [null],
    outputTool: DOCTOR_OUTPUT_TOOL_NAME,
    inputFlag: "ak-doctor-case",
    phaseFlag: void 0,
    activationStage: "load-and-install",
    sessionMaterials: ["CLAUDE.md", "souls/doctor.md"]
  },
  {
    role: "merger",
    phases: [null],
    outputTool: MERGER_OUTPUT_TOOL_NAME,
    inputFlag: "ak-merger-input",
    phaseFlag: void 0,
    activationStage: "prepare-git-and-install",
    sessionMaterials: ["CLAUDE.md", "souls/merger.md"]
  },
  {
    role: "notary",
    phases: [null],
    outputTool: NOTARY_OUTPUT_TOOL_NAME,
    inputFlag: "ak-notary-source-run",
    phaseFlag: void 0,
    activationStage: "load-and-install",
    sessionMaterials: NOTARY_SESSION_MATERIALS
  }
];
function metadataProjection(record) {
  return {
    role: record.role,
    phases: record.phases,
    outputTool: record.outputTool,
    inputFlag: record.inputFlag,
    phaseFlag: record.phaseFlag,
    activationStage: record.activationStage
  };
}
const PACKAGED_ROLE_REGISTRY = PUBLIC_ROLE_RECORDS.map(metadataProjection);
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
function publicRoleSessionMaterials(role) {
  const record = PUBLIC_ROLE_RECORDS.find((entry) => entry.role === role);
  if (!record) {
    throw new Error(`unknown public role: ${role}`);
  }
  return record.sessionMaterials;
}
export {
  NOTARY_SESSION_MATERIALS,
  PACKAGED_ROLE_REGISTRY,
  PUBLIC_ROLE_RECORDS,
  packagedRoleInputFlag,
  packagedRoleMetadata,
  packagedRoleOutputTool,
  packagedRolePhaseFlag,
  publicRoleSessionMaterials
};
