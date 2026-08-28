/** Composition-root unique authoritative public-role records (#509 / #524). */
import { COLLECTOR_OUTPUT_TOOL } from "./package-contracts/collector-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "./package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "./package-contracts/reviewer-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "./package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "./doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "./merger-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "./notary-contracts.ts";

/**
 * Shared notary session materials — one definition for public notary and
 * gatekeeper-province notary (#524; eliminates the prior dual path arrays).
 */
export const NOTARY_SESSION_MATERIALS = [
  "CLAUDE.md",
  "souls/notary.md",
  "souls/gate-output-guide.md",
] as const;

/**
 * One record per public callable role: attendance/settlement metadata plus
 * ordered main-session materials. Navigator is intentionally absent (name-only
 * materials live in the session-opening projection).
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
] as const;

export type PublicRoleRecord = (typeof PUBLIC_ROLE_RECORDS)[number];
export type PackagedRole = PublicRoleRecord["role"];

/** Read-only metadata projection of PUBLIC_ROLE_RECORDS (no sessionMaterials). */
export type PackagedRoleMetadata = {
  readonly role: PublicRoleRecord["role"];
  readonly phases: PublicRoleRecord["phases"];
  readonly outputTool: PublicRoleRecord["outputTool"];
  readonly inputFlag: PublicRoleRecord["inputFlag"];
  readonly phaseFlag: PublicRoleRecord["phaseFlag"];
  readonly activationStage: PublicRoleRecord["activationStage"];
};

function metadataProjection(record: PublicRoleRecord): PackagedRoleMetadata {
  return {
    role: record.role,
    phases: record.phases,
    outputTool: record.outputTool,
    inputFlag: record.inputFlag,
    phaseFlag: record.phaseFlag,
    activationStage: record.activationStage,
  };
}

/** Read-only derived projection — consumers keep the historical symbol. */
export const PACKAGED_ROLE_REGISTRY: readonly PackagedRoleMetadata[] =
  PUBLIC_ROLE_RECORDS.map(metadataProjection);

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

export function publicRoleSessionMaterials(
  role: PackagedRole,
): PublicRoleRecord["sessionMaterials"] {
  const record = PUBLIC_ROLE_RECORDS.find((entry) => entry.role === role);
  if (!record) {
    throw new Error(`unknown public role: ${role}`);
  }
  return record.sessionMaterials;
}
