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
    acceptedText: "大理寺回执已接受",
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
    acceptedText: "修内司回执已接受",
    activationFlags: [
      { field: "packetPath", flag: "ak-fix-packet", binds: "input" },
      { field: "phase", flag: "ak-fixer-phase", binds: "phase" },
      { field: "prerequisitesPath", flag: "ak-fixer-prerequisites" },
    ],
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
    acceptedText: "将作监回执已接受",
    activationFlags: [
      { field: "taskPath", flag: "ak-coder-task", binds: "input" },
      { field: "phase", flag: "ak-coder-phase", binds: "phase" },
    ],
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
    acceptedText: "御史台回执已接受",
    activationFlags: [
      { field: "baseRevision", flag: "ak-review-base" },
      { field: "lens", flag: "ak-review-lens" },
      { field: "authorityRefs", flag: "ak-review-authority-refs" },
      { field: "ticketNumber", flag: "ak-review-ticket-number" },
    ],
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
    acceptedText: "通进司回执已接受",
    activationFlags: [
      { field: "repo", from: "repository.display", flag: "ak-collector-repo" },
      { field: "pr", from: "prNumber", text: true, flag: "ak-collector-pr" },
      { field: "requestManifestPath", flag: "ak-collector-request-manifest" },
      { field: "waitMs", from: "waitWindowMs", text: true, flag: "ak-collector-wait-ms" },
    ],
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
    acceptedText: "太医署回执已接受",
    activationFlags: [
      { field: "casePath", from: "caseRunsPath", flag: "ak-doctor-case", binds: "input" },
    ],
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
    acceptedText: "合并回执已接受",
    activationFlags: [
      { field: "inputPath", from: "mergerInputPath", flag: "ak-merger-input", binds: "input" },
    ],
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
    settlement: "accepted",
    acceptedText: "符宝郎回执已接受",
    activationFlags: [
      { field: "sourceRun", from: "sourceRunPath", flag: "ak-notary-source-run", binds: "input" },
      { field: "ticketNumber", flag: "ak-notary-ticket-number" },
    ],
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
    acceptedText: "给事中回执已接受",
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
    acceptedText: "中书省回执已接受",
    activationFlags: [
      { field: "ticketNumber" },
    ],
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
    settlement: "accepted",
    acceptedText: "左拾遗回执已接受",
    activationFlags: [
      { field: "baseRevision", flag: "ak-gleaner-left-base" },
    ],
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
    settlement: "accepted",
    acceptedText: "台院回执已接受",
    activationFlags: [
      {
        field: "sourceRun",
        from: "sourceRunPath",
        fallback: "gate-pointer",
        flag: "ak-inspector-source-run",
        binds: "input",
      },
    ],
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
    settlement: "accepted",
    acceptedText: "门下省决议已受理",
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
    settlement: "accepted",
    acceptedText: "游奕使建议已受理",
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
    settlement: "accepted",
    acceptedText: "审刑院回执已接受",
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
    settlement: "accepted",
    acceptedText: "起居郎回执已接受",
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

/**
 * One seat's admitted → activation copy.
 * `field` is the activation key. `from` is the admitted path when it differs.
 * `text` writes a number as decimal text on the activation object.
 * `fallback: "gate-pointer"` is the inspector instruction pointer when sourceRunPath is blank.
 * `flag` omitted: the value stays on the activation object and is not a host flag
 * (secretariat ticketNumber).
 */
export type PackagedActivationFlag = {
  readonly field: string;
  readonly from?: string;
  readonly text?: true;
  readonly fallback?: "gate-pointer";
  readonly flag?: string;
  readonly binds?: "input" | "phase";
};

/**
 * Output tool for seats whose settlement is the shared accepted-tool scan.
 * Absent means this seat has its own settlement function.
 */
export function packagedRoleAcceptedOutputTool(role: string): string | undefined {
  const record = packagedRoleMetadata(role);
  if (record === undefined || !("settlement" in record) || record.settlement !== "accepted") {
    return undefined;
  }
  return record.outputTool;
}

/** Host flags for one seat. Absent means this seat publishes only `ak-role`. */
export function packagedRoleActivationFlags(role: string): readonly PackagedActivationFlag[] {
  const record = packagedRoleMetadata(role);
  if (record === undefined || !("activationFlags" in record)) return [];
  return record.activationFlags;
}

export function packagedRoleInputFlag(role: string): string | undefined {
  return packagedRoleActivationFlags(role).find((spec) => spec.binds === "input")?.flag;
}

export function packagedRolePhaseFlag(role: string): string | undefined {
  return packagedRoleActivationFlags(role).find((spec) => spec.binds === "phase")?.flag;
}

export function packagedRoleOutputTool(role: string): string | undefined {
  return packagedRoleMetadata(role)?.outputTool;
}

/** Accept-face text for a registered seat. One registry leaf; callers do not keep a copy. */
export function packagedRoleAcceptedText(role: string): string {
  const record = packagedRoleMetadata(role);
  if (record === undefined) {
    throw new Error(`Unsupported workflow role: ${String(role)}`);
  }
  return record.acceptedText;
}
