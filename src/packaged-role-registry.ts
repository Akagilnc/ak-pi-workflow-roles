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
import { DIARIST_OUTPUT_TOOL_NAME } from "./diarist-contracts.ts";
import { SECRETARIAT_OUTPUT_TOOL_NAME } from "./secretariat-contracts.ts";

/** Shared by public notary and gatekeeper-province notary. */
export const NOTARY_SESSION_MATERIALS = [
  "CLAUDE.md",
  "souls/notary.md",
  "souls/audit-law.md",
  "souls/ticket-law.md",
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

/**
 * One record per public callable role (#639: includes gatekeeper and navigator).
 */
export const PUBLIC_ROLE_RECORDS = [
  {
    role: "judge",
    inCallAutoResume: true,
    presentSettled: "default",
    summonResume: false,
    admission: "instruction",
    sameParent: "none",
    phases: [null],
    outputTool: JUDGE_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    receiptStatusKey: "judgeStatus",
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
    inCallAutoResume: true,
    presentSettled: "default",
    summonResume: false,
    admission: "fixer",
    sameParent: "none",
    worker: true,
    methodSkills: ["diagnosing-bugs", "tdd"],
    settleMethod: "diagnosing-bugs",
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
    inCallAutoResume: true,
    presentSettled: "default",
    summonResume: false,
    admission: "coder",
    sameParent: "none",
    worker: true,
    applyMethod: "tdd",
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
    inCallAutoResume: true,
    presentSettled: "default",
    summonResume: false,
    admission: "reviewer",
    sameParent: "none",
    methodSkills: ["ak-cross-m-review"],
    settleMethod: "ak-cross-m-review",
    parallelLenses: true,
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
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "collector",
    sameParent: "none",
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
    inCallAutoResume: false,
    presentSettled: "typed",
    summonResume: false,
    admission: "doctor",
    sameParent: "none",
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
    inCallAutoResume: true,
    presentSettled: "typed",
    summonResume: false,
    admission: "merger",
    sameParent: "none",
    methodSkills: ["resolving-merge-conflicts"],
    settleMethod: "resolving-merge-conflicts",
    phases: [null],
    outputTool: MERGER_OUTPUT_TOOL_NAME,
    inputFlag: "ak-merger-input",
    phaseFlag: undefined,
    activationStage: "prepare-git-and-install",
    receiptCommitKey: "mergeCommitId",
    receiptCommitWhen: "completed",
    sessionMaterials: ["CLAUDE.md", "souls/merger.md"],
  },
  {
    role: "notary",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "notary",
    sameParent: "notary",
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
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "countersign",
    sameParent: "none",
    phases: [null],
    outputTool: COUNTERSIGN_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    receiptStatusKey: "countersignStatus",
    // #924: 公用《票面法》三席同装
    sessionMaterials: ["CLAUDE.md", "souls/countersign.md", "souls/ticket-law.md"],
  },
  {
    role: "secretariat",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "instruction",
    sameParent: "secretariat",
    phases: [null],
    outputTool: SECRETARIAT_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    receiptStatusKey: "secretariatStatus",
    // #924: owner-finalized Soul + 票面法 + 给事中/符宝郎行为指南
    sessionMaterials: [
      "CLAUDE.md",
      "souls/secretariat.md",
      "souls/ticket-law.md",
      "souls/countersign.md",
      "souls/notary.md",
    ],
  },
  {
    role: "gleaner-left",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "gleaner",
    sameParent: "none",
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
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "instruction",
    sameParent: "inspector",
    phases: [null],
    outputTool: INSPECTOR_OUTPUT_TOOL_NAME,
    inputFlag: "ak-inspector-source-run",
    phaseFlag: undefined,
    activationStage: "load-and-install",
    sessionMaterials: INSPECTOR_SESSION_MATERIALS,
  },
  // #639: gatekeeper and navigator are roles like any other — public ak-role
  // entries; automatic attendance (province dispatch, navigator sidecar) is
  // unchanged and orthogonal to callability.
  {
    role: "gatekeeper",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: true,
    admission: "instruction",
    sameParent: "none",
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
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: true,
    admission: "instruction",
    sameParent: "none",
    phases: [null],
    outputTool: NAVIGATOR_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    sessionMaterials: ["CLAUDE.md", "souls/navigator.md"],
  },
  // #675: 审刑院 is a role like any other — public ak-role entry. (#744: evidence-child deleted)
  {
    role: "auditor",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: true,
    admission: "instruction",
    sameParent: "auditor",
    phases: [null],
    outputTool: AUDITOR_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    sessionMaterials: AUDITOR_PUBLIC_SESSION_MATERIALS,
  },
  // #708 / ADR 0075（起居郎是 LLM 角色）/ #779: 起居郎 is a seat like any other.
  // No input flag — LLM finds materials itself (caller-transparent).
  {
    role: "diarist",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "instruction",
    sameParent: "diarist",
    phases: [null],
    outputTool: DIARIST_OUTPUT_TOOL_NAME,
    inputFlag: undefined,
    phaseFlag: undefined,
    activationStage: "load-and-install",
    sessionMaterials: [
      "CLAUDE.md",
      "souls/diarist.md",
      "resources/diarist-collect.md",
    ],
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
