/** Composition-root unique authoritative public-role records (#509 / #524). */
import { COLLECTOR_OUTPUT_TOOL } from "./package-contracts/collector-output.js";
import { JUDGE_OUTPUT_TOOL_NAME } from "./package-contracts/judge-output.js";
import { REVIEWER_OUTPUT_TOOL_NAME } from "./package-contracts/reviewer-output.js";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "./package-contracts/worker-output.js";
import { DOCTOR_OUTPUT_TOOL_NAME } from "./doctor-contracts.js";
import { MERGER_OUTPUT_TOOL_NAME } from "./merger-contracts.js";
import { NOTARY_OUTPUT_TOOL_NAME } from "./notary-contracts.js";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "./countersign-contracts.js";
/** Shared by public notary and gatekeeper-province notary. */
export const NOTARY_SESSION_MATERIALS = [
    "CLAUDE.md",
    "souls/notary.md",
    "souls/gate-output-guide.md",
];
/**
 * One record per public callable role. Navigator is absent (name-only materials
 * live on the session-opening projection).
 */
export const PUBLIC_ROLE_RECORDS = [
    {
        role: "judge",
        phases: [null],
        outputTool: JUDGE_OUTPUT_TOOL_NAME,
        inputFlag: undefined,
        phaseFlag: undefined,
        activationStage: "load-and-install",
        sessionMaterials: [
            "CLAUDE.md",
            "souls/judge.md",
            "souls/audit-law.md",
            "souls/quality-law.md",
            "souls/judge-output-guide.md",
        ],
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
            "souls/fixer-output-guide.md",
        ],
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
            "souls/coder-output-guide.md",
        ],
    },
    {
        role: "reviewer",
        phases: [null],
        outputTool: REVIEWER_OUTPUT_TOOL_NAME,
        inputFlag: undefined,
        phaseFlag: undefined,
        activationStage: "load-and-install",
        sessionMaterials: [
            "CLAUDE.md",
            "souls/reviewer.md",
            "souls/audit-law.md",
            "souls/quality-law.md",
        ],
    },
    // ak-collector-repo is GitHub owner/repo identity, not a local material path (#438).
    {
        role: "collector",
        phases: [null],
        outputTool: COLLECTOR_OUTPUT_TOOL,
        inputFlag: undefined,
        phaseFlag: undefined,
        activationStage: "load-and-install",
        sessionMaterials: ["CLAUDE.md", "souls/collector.md"],
    },
    {
        role: "doctor",
        phases: [null],
        outputTool: DOCTOR_OUTPUT_TOOL_NAME,
        inputFlag: "ak-doctor-case",
        phaseFlag: undefined,
        activationStage: "load-and-install",
        sessionMaterials: ["CLAUDE.md", "souls/doctor.md"],
    },
    {
        role: "merger",
        phases: [null],
        outputTool: MERGER_OUTPUT_TOOL_NAME,
        inputFlag: "ak-merger-input",
        phaseFlag: undefined,
        activationStage: "prepare-git-and-install",
        sessionMaterials: ["CLAUDE.md", "souls/merger.md"],
    },
    {
        role: "notary",
        phases: [null],
        outputTool: NOTARY_OUTPUT_TOOL_NAME,
        inputFlag: "ak-notary-source-run",
        phaseFlag: undefined,
        activationStage: "load-and-install",
        sessionMaterials: NOTARY_SESSION_MATERIALS,
    },
    {
        role: "countersign",
        phases: [null],
        outputTool: COUNTERSIGN_OUTPUT_TOOL_NAME,
        inputFlag: undefined,
        phaseFlag: undefined,
        activationStage: "load-and-install",
        sessionMaterials: ["CLAUDE.md", "souls/countersign.md"],
    },
];
/** One-shot seats: runs terminate and refuse resume — single typed owner (#572 判词送修 5). */
export const ONE_SHOT_ROLES = [
    "collector",
    "doctor",
    "notary",
    "countersign",
];
/** Historical symbol — derived from PUBLIC_ROLE_RECORDS. */
export const PACKAGED_ROLE_REGISTRY = PUBLIC_ROLE_RECORDS.map(({ sessionMaterials: _omit, ...metadata }) => metadata);
export function packagedRoleMetadata(role) {
    return PACKAGED_ROLE_REGISTRY.find((entry) => entry.role === role);
}
export function packagedRoleInputFlag(role) {
    return packagedRoleMetadata(role)?.inputFlag;
}
export function packagedRolePhaseFlag(role) {
    return packagedRoleMetadata(role)?.phaseFlag;
}
export function packagedRoleOutputTool(role) {
    return packagedRoleMetadata(role)?.outputTool;
}
