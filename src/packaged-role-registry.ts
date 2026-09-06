/** Composition-root unique authoritative public-role records (#509 / #524). */
import { COLLECTOR_OUTPUT_TOOL } from "./package-contracts/collector-output.ts";
import { GATEKEEPER_OUTPUT_TOOL_NAME } from "./package-contracts/gatekeeper-output.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "./package-contracts/navigator-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "./package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "./package-contracts/reviewer-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "./package-contracts/worker-output.ts";
import { DOCTOR_OUTPUT_TOOL_NAME } from "./doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "./merger-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "./notary-contracts.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "./countersign-contracts.ts";
import { GLEANER_LEFT_OUTPUT_TOOL_NAME } from "./gleaner-left-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "./inspector-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "./package-contracts/auditor-output.ts";
import { EVIDENCE_CHILD_OUTPUT_TOOL_NAME } from "./package-contracts/evidence-child-output.ts";

/** Shared by public notary and gatekeeper-province notary. */
export const NOTARY_SESSION_MATERIALS = [
  "CLAUDE.md",
  "souls/notary.md",
  "souls/audit-law.md",
  "souls/gate-output-guide.md",
] as const;

/** Shared by public inspector and gatekeeper-province inspector. */
export const INSPECTOR_SESSION_MATERIALS = [
  "CLAUDE.md",
  "souls/inspector.md",
  "souls/audit-law.md",
  "souls/quality-law.md",
  "souls/gate-output-guide.md",
] as const;

/**
 * Public 审刑院 shipping roster (#675 owner).
 * Runtime assembly is subject-selected via AUDITOR_SESSION_MATERIALS
 * (judge-auditor.md / doctor-auditor.md) — never a generic auditor.md.
 * This list is the union of files that must ship; load path is loadAuditorSoul(subject).
 */
export const AUDITOR_PUBLIC_SESSION_MATERIALS = [
  "CLAUDE.md",
  "souls/judge-auditor.md",
  "souls/doctor-auditor.md",
  "souls/audit-law.md",
  "souls/quality-law.md",
] as const;

/** Public evidence-child materials (#675). audit-law supplies lawful 取证授权; seat identity only in evidence-child.md. */
export const EVIDENCE_CHILD_SESSION_MATERIALS = [
  "CLAUDE.md",
  "souls/evidence-child.md",
  "souls/audit-law.md",
  "souls/quality-law.md",
] as const;

/**
 * One record per public callable role (#639: includes gatekeeper and navigator).
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
    bareCommand: false,
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
    bareCommand: false,
    outputTool: COLLECTOR_OUTPUT_TOOL,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    sessionMaterials: ["CLAUDE.md", "souls/collector.md"],
  },
  {
    role: "doctor",
    phases: [null],
    bareCommand: false,
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
    bareCommand: false,
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
  {
    role: "gleaner-left",
    phases: [null],
    bareCommand: false,
    outputTool: GLEANER_LEFT_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    sessionMaterials: [
      "CLAUDE.md",
      "souls/gleaner-left.md",
      "souls/quality-law.md",
    ],
  },
  {
    role: "inspector",
    phases: [null],
    outputTool: INSPECTOR_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    sessionMaterials: INSPECTOR_SESSION_MATERIALS,
  },
  // #639: gatekeeper and navigator are roles like any other — public ak-role
  // entries; automatic attendance (province dispatch, navigator sidecar) is
  // unchanged and orthogonal to callability.
  {
    role: "gatekeeper",
    phases: [null],
    outputTool: GATEKEEPER_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    // Province materials; officers reuse their own public records below.
    sessionMaterials: ["CLAUDE.md", "souls/gatekeeper.md", "souls/quality-law.md", "souls/gate-output-guide.md"],
  },
  {
    role: "navigator",
    phases: [null],
    outputTool: NAVIGATOR_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    sessionMaterials: ["CLAUDE.md", "souls/navigator.md"],
  },
  // #675: 审刑院 / evidence-child are roles like any other — public ak-role entries.
  {
    role: "auditor",
    phases: [null],
    outputTool: AUDITOR_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    sessionMaterials: AUDITOR_PUBLIC_SESSION_MATERIALS,
  },
  {
    role: "evidence-child",
    phases: [null],
    outputTool: EVIDENCE_CHILD_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    sessionMaterials: EVIDENCE_CHILD_SESSION_MATERIALS,
  },
] as const;

export type PublicRoleRecord = (typeof PUBLIC_ROLE_RECORDS)[number];
export type PackagedRole = PublicRoleRecord["role"];

/**
 * Read-only metadata projection (no sessionMaterials).
 * Distributed per PublicRoleRecord member so role↔field associations stay intact.
 */
export type PackagedRoleMetadata = PublicRoleRecord extends infer R
  ? R extends PublicRoleRecord
    ? Omit<R, "sessionMaterials">
    : never
  : never;

/** Historical symbol — derived from PUBLIC_ROLE_RECORDS. */
export const PACKAGED_ROLE_REGISTRY: readonly PackagedRoleMetadata[] =
  PUBLIC_ROLE_RECORDS.map(({ sessionMaterials: _omit, ...metadata }) => metadata);

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
