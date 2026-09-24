/** Composition-root unique authoritative public-role records (#509 / #524). */
import { COLLECTOR_OUTPUT_TOOL } from "./package-contracts/collector-output.ts";
import { COLLECTOR_WAIT_TOOL } from "./collector-ledger.ts";
import { GATEKEEPER_OUTPUT_TOOL_NAME } from "./package-contracts/gatekeeper-output.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME } from "./package-contracts/navigator-output.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "./package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "./package-contracts/reviewer-output.ts";
import { CODER_OUTPUT_TOOL_NAME, FIXER_OUTPUT_TOOL_NAME } from "./package-contracts/worker-output.ts";
import { DOCTOR_AUDIT_TOOL_NAME, DOCTOR_OUTPUT_TOOL_NAME } from "./doctor-contracts.ts";
import { MERGER_OUTPUT_TOOL_NAME } from "./merger-contracts.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "./notary-contracts.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "./countersign-contracts.ts";
import { GLEANER_LEFT_OUTPUT_TOOL_NAME } from "./gleaner-left-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "./inspector-contracts.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "./package-contracts/auditor-output.ts";
import { DIARIST_OUTPUT_TOOL_NAME } from "./diarist-contracts.ts";
import { SECRETARIAT_OUTPUT_TOOL_NAME } from "./secretariat-contracts.ts";
import { JUDGE_AUDIT_TOOL_NAME } from "./judge-auditor.ts";

/** Historical durable session names; these are read aliases, never registered tools. */
export const LEGACY_REVIEW_OUTPUT_ROLES = new Map<string, string>([
  ["ak_judge_output", "judge"],
  ["ak_notary_output", "notary"],
  ["ak_countersign_output", "countersign"],
  ["ak_inspector_output", "inspector"],
  ["ak_auditor_output", "auditor"],
]);

/**
 * Success-face fields that still differ by seat. Presence and omission match
 * the former per-seat publishers. Key order is not part of the contract.
 */
export type PackagedArtifactLeaf = {
  readonly key: string;
  readonly from?: string;
  readonly omitUndefined?: true;
  readonly copyArray?: true;
  readonly callerProvenance?: true;
};

export type PackagedArtifactFace = {
  readonly reportPhase?: true;
  readonly evidenceRole?: true;
  readonly leaves: readonly PackagedArtifactLeaf[];
  readonly method?: "optional" | "observed";
  readonly doctorReportFacts?: true;
};

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
    /** Public argv rejects a burden selector. */
    bareToken: "burden",
    sameParent: "none",
    phases: [null],
    outputTool: JUDGE_OUTPUT_TOOL_NAME,
    auditTool: JUDGE_AUDIT_TOOL_NAME,
    settlement: "sealed",
    runnerFailure: "engine-detour-known-first",
    /** Factory board: court until another station has started, then marshal. */
    boardPlacement: "judge-history",
    /** Navigator subject is the public admitted instruction when the run is bound. */
    navigatorSubject: "public-instruction",
    activationStage: "load-and-install",
    receiptStatusKey: "status",
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
    admission: "worker-packet",
    sameParent: "none",
    worker: true,
    methodSkills: ["diagnosing-bugs", "tdd"],
    settleMethod: "diagnosing-bugs",
    phases: ["plan", "apply"],
    outputTool: FIXER_OUTPUT_TOOL_NAME,
    settlement: "sealed",
    artifactFace: {
      reportPhase: true,
      evidenceRole: true,
      leaves: [
        { key: "phase" },
        { key: "packetPath" },
        { key: "prerequisitesPath", omitUndefined: true },
        { key: "prerequisites" },
      ],
      method: "observed",
    },
    boardPlacement: "marshal",
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
    admission: "worker-task",
    sameParent: "none",
    worker: true,
    applyMethod: "tdd",
    /** Method-material load failure keeps the activation cause (not reviewer/fixer). */
    methodLoadFailureCause: "activation",
    boardPlacement: "coder",
    phases: ["plan", "apply"],
    outputTool: CODER_OUTPUT_TOOL_NAME,
    settlement: "sealed",
    artifactFace: {
      reportPhase: true,
      evidenceRole: true,
      leaves: [
        { key: "phase" },
        { key: "taskPath" },
      ],
      method: "optional",
    },
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
    admission: "review-basis",
    /** --base is a single Skill-arg token, and authority refs are always emitted. */
    baseValue: "revision",
    emitAuthorityRefs: true,
    sameParent: "none",
    methodSkills: ["ak-cross-m-review"],
    settleMethod: "ak-cross-m-review",
    /** Omitted public lens starts two ordinary single-axis runs (ADR 0052). */
    parallelLenses: true,
    phases: [null],
    bareCommand: false,
    outputTool: REVIEWER_OUTPUT_TOOL_NAME,
    settlement: "sealed",
    /** Publish only an accepted ledger outcome; audit escalation stays unsettled here. */
    sealedAcceptedOnly: true,
    artifactFace: {
      evidenceRole: true,
      leaves: [
        { key: "baseRevision" },
        { key: "lens" },
        { key: "authorityRefs", copyArray: true },
        { key: "callerProvenance", callerProvenance: true },
      ],
      method: "observed",
    },
    /** Frozen base/lens/authority become the initial prompt; instruction follows. */
    transportPrompt: "skill-args",
    runnerFailure: "engine-detour-record-first",
    boardPlacement: "marshal",
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
    admission: "collect-target",
    /** Public no_receipt projects a durable bind-target rejection. */
    projectTargetBindRejection: true,
    sameParent: "none",
    phases: [null],
    bareCommand: false,
    outputTool: COLLECTOR_OUTPUT_TOOL,
    settlement: "residual",
    /** #633: a prior wait-tool residual must not mask this attempt. */
    residualScan: "current-attempt",
    residualTool: COLLECTOR_WAIT_TOOL,
    runnerFailure: "collector-known-first",
    artifactFace: {
      evidenceRole: true,
      leaves: [
        { key: "prNumber", omitUndefined: true },
        { key: "repository", from: "repository.canonical" },
        { key: "manifestDigest" },
      ],
    },
    boardPlacement: "collector",
    /** Taishi acceptance is a typed groups array, not a status leaf. */
    analystTerminal: "groups",
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
    admission: "case-identity",
    sameParent: "none",
    phases: [null],
    bareCommand: false,
    outputTool: DOCTOR_OUTPUT_TOOL_NAME,
    auditTool: DOCTOR_AUDIT_TOOL_NAME,
    settlement: "sealed",
    artifactFace: {
      evidenceRole: true,
      leaves: [
        { key: "issueNumber" },
        { key: "caseRunsPath" },
        { key: "caseIdentity" },
      ],
      doctorReportFacts: true,
    },
    /** Navigator subject is the doctor case, not the case-path file bytes. */
    navigatorSubject: "case",
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
    admission: "merge-envelope",
    /** Public argv rejects packet fields the adapter reads from Git. */
    bareToken: "packet",
    sameParent: "none",
    methodSkills: ["resolving-merge-conflicts"],
    settleMethod: "resolving-merge-conflicts",
    /** Method-material load failure keeps the activation cause (not reviewer/fixer). */
    methodLoadFailureCause: "activation",
    phases: [null],
    outputTool: MERGER_OUTPUT_TOOL_NAME,
    settlement: "residual",
    /** #836: residual scan stays on the whole host session. */
    residualScan: "session",
    residualTool: MERGER_OUTPUT_TOOL_NAME,
    artifactFace: {
      evidenceRole: true,
      leaves: [
        { key: "mergerInputPath" },
        { key: "derived" },
      ],
      method: "observed",
    },
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
    admission: "source-locator",
    /** Public argv is only the source-run locator; stored text is not trimmed. */
    bareToken: "instruction",
    sourceRunStored: "raw",
    argvResult: "source-run",
    sameParent: "source-locator",
    /** Infrastructure failure at this stage has no accepted gate cycle to project. */
    skipGateOnInfrastructureStage: true,
    /** 符宝郎 is a review officer and inherits the gatekeeper model. */
    reviewOfficer: true,
    provinceConfig: true,
    modelInheritsFrom: "gatekeeper",
    phases: [null],
    bareCommand: false,
    outputTool: NOTARY_OUTPUT_TOOL_NAME,
    settlement: "accepted",
    /** Court reask replaces the initial prompt. Otherwise the fixed kickoff. */
    reaskPrompt: true,
    transportPrompt: "fixed-kickoff",
    gateStageLabel: "符宝郎",
    /** Gate summon binds --source-run and keeps dialogue off the argv. */
    gateSummon: "source-run",
    /** Navigator subject is the source-run locator, not the path file bytes. */
    navigatorSubject: "source-run",
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
    admission: "court-materials",
    /** Durable custom entry names this officer. */
    durableOfficerEntry: true,
    sameParent: "none",
    phases: [null],
    outputTool: COUNTERSIGN_OUTPUT_TOOL_NAME,
    settlement: "accepted",
    gateStageLabel: "给事中",
    /** Gate summon carries the parent payload as the instruction and a parent run id. */
    gateSummon: "parent-instruction",
    activationFlags: [
      { field: "ticketNumber" },
    ],
    activationStage: "load-and-install",
    receiptStatusKey: "status",
    // #924: 公用《票面法》三席同装
    sessionMaterials: ["CLAUDE.md", "souls/countersign.md", "souls/ticket-law.md", "resources/countersign-ticket-issue.md"],
  },
  {
    role: "secretariat",
    inCallAutoResume: false,
    presentSettled: "always",
    summonResume: false,
    admission: "instruction",
    sameParent: "none",
    phases: [null],
    outputTool: SECRETARIAT_OUTPUT_TOOL_NAME,
    settlement: "accepted",
    /** Project the durable 给事中 officer entry onto the shared accepted-tool settlement. */
    projectCountersignTerminal: true,
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
      "resources/secretariat-ticket-identity.md",
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
    /** Public argv keeps the instruction and drops attachment paths. */
    argvResult: "instruction",
    sameParent: "none",
    phases: [null],
    bareCommand: false,
    outputTool: GLEANER_LEFT_OUTPUT_TOOL_NAME,
    settlement: "accepted",
    /** Bound comparison base is the initial prompt; instruction follows. */
    transportPrompt: "baseline",
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
    sameParent: "gate-pointer",
    /** Resume restores an optional source-run path onto the admitted face. */
    resumeSourcePath: true,
    /** Infrastructure failure at this stage has no accepted gate cycle to project. */
    skipGateOnInfrastructureStage: true,
    /** 台院 is a review officer and inherits the gatekeeper model. */
    reviewOfficer: true,
    provinceConfig: true,
    modelInheritsFrom: "gatekeeper",
    phases: [null],
    outputTool: INSPECTOR_OUTPUT_TOOL_NAME,
    settlement: "accepted",
    /** Court reask replaces the initial prompt. */
    reaskPrompt: true,
    gateStageLabel: "台院",
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
    /** Infrastructure failure at this stage has no accepted gate cycle to project. */
    skipGateOnInfrastructureStage: true,
    sameParent: "none",
    /** Province model root. Officers name this seat via modelInheritsFrom. */
    provinceConfig: true,
    phases: [null],
    outputTool: GATEKEEPER_OUTPUT_TOOL_NAME,
    settlement: "accepted",
    runnerFailure: "engine-detour-record-first",
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
    runnerFailure: "engine-detour-record-first",
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
    sameParent: "subject-source",
    /** --subject chooses which audited seat the soul comes from. */
    subjectChoices: ["judge", "doctor"],
    /** 审刑院 is a review officer. Model stays on its own seat row. */
    reviewOfficer: true,
    /** Subject input selects the soul. The public materials list is the ship roster. */
    soulSource: "subject",
    phases: [null],
    outputTool: AUDITOR_OUTPUT_TOOL_NAME,
    settlement: "accepted",
    /** Court reask replaces the initial prompt. */
    reaskPrompt: true,
    runnerFailure: "engine-detour-record-first",
    gateStageLabel: "审刑院",
    /** Gate summon binds --subject judge and --source-run. */
    gateSummon: "subject-source",
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
    sameParent: "board-ticket",
    phases: [null],
    outputTool: DIARIST_OUTPUT_TOOL_NAME,
    settlement: "accepted",
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

/** Review officers (台院 / 符宝郎 / 审刑院). Absent on every other seat. */
export function isOfficerReviewSeat(role: string): boolean {
  const record = packagedRoleMetadata(role);
  return record !== undefined && "reviewOfficer" in record && record.reviewOfficer === true;
}

/** Province seats that may carry a persistent model override. */
export function packagedProvinceConfig(role: string): boolean {
  const record = packagedRoleMetadata(role);
  return record !== undefined && "provinceConfig" in record && record.provinceConfig === true;
}

/**
 * Model parent for a subordinate province officer.
 * The province root has none and does not inherit from itself.
 */
export function packagedModelParent(role: string): PackagedRole | undefined {
  const record = packagedRoleMetadata(role);
  if (record === undefined || !("modelInheritsFrom" in record)) return undefined;
  return record.modelInheritsFrom;
}

/**
 * One seat's admitted → activation copy.
 * `field` is the activation key. `from` is the admitted path when it differs.
 * `text` writes a number as decimal text on the activation object.
 * `fallback: "gate-pointer"` is the inspector instruction pointer when sourceRunPath is blank.
 * `flag` omitted: the value stays on the activation object and is not a host flag
 * (secretariat and countersign ticketNumber).
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
 * Output tool for seats whose settlement leaf is the shared accepted-tool scan.
 * Any other settlement leaf names that seat's own reader.
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

/** Method-material load failure cause declared on the seat. Absent means no typed cause. */
export function packagedMethodLoadFailureCause(role: string): "activation" | undefined {
  const record = packagedRoleMetadata(role);
  if (record === undefined || !("methodLoadFailureCause" in record)) return undefined;
  return record.methodLoadFailureCause;
}

/** Diarist binds a board ticket onto its own run. Other seats do not. */
export function packagedBindsBoardTicket(role: string): boolean {
  const record = packagedRoleMetadata(role);
  return record?.sameParent === "board-ticket";
}

/** Notary resume may replace the stored source-run locator from the summons. */
export function packagedRebindSourceOnResume(role: string): boolean {
  return packagedRoleMetadata(role)?.admission === "source-locator";
}

/** Countersign admission keeps deferred court identity on the public entry. */
export function packagedAdmitsCountersign(role: string): boolean {
  return packagedRoleMetadata(role)?.admission === "court-materials";
}

export type PackagedBareToken = "burden" | "packet" | "instruction";

/** Public argv bare-token face. Absent means a bare token is instruction text. */
export function packagedBareToken(role: string): PackagedBareToken | undefined {
  const record = packagedRoleMetadata(role);
  if (record === undefined || !("bareToken" in record)) return undefined;
  return record.bareToken;
}

/** Public argv result shape. Absent means instruction plus attachment paths. */
export function packagedArgvResult(role: string): "source-run" | "instruction" | "material" {
  const record = packagedRoleMetadata(role);
  if (record !== undefined && "argvResult" in record) return record.argvResult;
  return "material";
}

/** Source-run text is stored without trim. Absent means trim. */
export function packagedStoresSourceRunRaw(role: string): boolean {
  const record = packagedRoleMetadata(role);
  return record !== undefined && "sourceRunStored" in record && record.sourceRunStored === "raw";
}

/** --base is a single Skill-arg token. Absent means a path. */
export function packagedBaseIsRevision(role: string): boolean {
  const record = packagedRoleMetadata(role);
  return record !== undefined && "baseValue" in record && record.baseValue === "revision";
}

/** Authority refs are present on the parse result even when empty. */
export function packagedEmitsAuthorityRefs(role: string): boolean {
  const record = packagedRoleMetadata(role);
  return record !== undefined && "emitAuthorityRefs" in record && record.emitAuthorityRefs === true;
}

/** Allowed --subject values. Absent means the seat has no subject option. */
export function packagedSubjectChoices(role: string): readonly string[] | undefined {
  const record = packagedRoleMetadata(role);
  if (record === undefined || !("subjectChoices" in record)) return undefined;
  return record.subjectChoices;
}

/** Admitted --subject when the value is one of the seat's declared choices. */
export function packagedAdmittedSubject(role: string, value: string): "judge" | "doctor" | undefined {
  const choices = packagedSubjectChoices(role);
  if (choices === undefined || !choices.includes(value)) return undefined;
  const match = choices.find((choice) => choice === value);
  if (match === "judge" || match === "doctor") return match;
  return undefined;
}

/** Audit decision tool declared on the audited seat. */
export function packagedAuditToolName(role: string): string | undefined {
  const record = packagedRoleMetadata(role);
  if (record === undefined || !("auditTool" in record)) return undefined;
  return record.auditTool;
}

/** Infrastructure-failure stage that must not be re-read as an accepted gate cycle. */
export function packagedSkipsGateOnInfrastructureStage(stage: unknown): boolean {
  return typeof stage === "string" && PUBLIC_ROLE_RECORDS.some((record) =>
    "skipGateOnInfrastructureStage" in record
    && record.skipGateOnInfrastructureStage === true
    && record.role === stage
  );
}

/** Durable officer entry whose name is the seat role. */
export function packagedDurableOfficerEntry(officer: unknown): boolean {
  return typeof officer === "string" && PUBLIC_ROLE_RECORDS.some((record) =>
    "durableOfficerEntry" in record
    && record.durableOfficerEntry === true
    && record.role === officer
  );
}

/** Admitted-request role whose navigator subject is the public instruction. */
export function packagedPublicInstructionSubject(role: unknown): boolean {
  return typeof role === "string" && PUBLIC_ROLE_RECORDS.some((record) =>
    "navigatorSubject" in record
    && record.navigatorSubject === "public-instruction"
    && record.role === role
  );
}

/** Resume restores an optional source-run path. */
export function packagedResumeSourcePath(role: string): boolean {
  const record = packagedRoleMetadata(role);
  return record !== undefined && "resumeSourcePath" in record && record.resumeSourcePath === true;
}

/** Public no_receipt projects a durable bind-target rejection. */
export function packagedProjectsTargetBindRejection(role: string): boolean {
  const record = packagedRoleMetadata(role);
  return record !== undefined
    && "projectTargetBindRejection" in record
    && record.projectTargetBindRejection === true;
}

export function packagedNavigatorSubject(
  role: string,
): "file" | "case" | "source-run" | "public-instruction" {
  const record = packagedRoleMetadata(role);
  if (record !== undefined && "navigatorSubject" in record) return record.navigatorSubject;
  return "file";
}

export type PackagedBoardPlacement = "judge-history" | "coder" | "marshal" | "collector";

/** Factory-board column for a packaged seat. Absent seats use the board's other bucket. */
export function packagedBoardPlacement(role: string): PackagedBoardPlacement | undefined {
  const record = packagedRoleMetadata(role);
  if (record === undefined || !("boardPlacement" in record)) return undefined;
  return record.boardPlacement;
}

/** Taishi terminal discriminator declared on the seat. Absent means the shared status leaf. */
export function packagedAnalystTerminal(role: string): "groups" | undefined {
  const record = packagedRoleMetadata(role);
  if (record === undefined || !("analystTerminal" in record)) return undefined;
  return record.analystTerminal;
}

export function packagedRoleSessionMaterials(role: string): readonly string[] | undefined {
  return PUBLIC_ROLE_RECORDS.find((entry) => entry.role === role)?.sessionMaterials;
}

export function isNavigatorSeat(role: string): boolean {
  return packagedRoleOutputTool(role) === NAVIGATOR_OUTPUT_TOOL_NAME;
}

/** Gate-province display label. Absent when the seat is not a gate stage. */
export function packagedGateStageLabel(role: string): string | undefined {
  const record = packagedRoleMetadata(role);
  if (record === undefined || !("gateStageLabel" in record)) return undefined;
  return record.gateStageLabel;
}

/** How the gate caller builds one officer summons. Pointer is the inspector face. */
export type PackagedGateSummon = "source-run" | "subject-source" | "parent-instruction" | "pointer";

/** How the gate caller builds one officer summons. Pointer is the inspector face. */
export function packagedGateSummon(role: string): PackagedGateSummon {
  const record = packagedRoleMetadata(role);
  if (record !== undefined && "gateSummon" in record) return record.gateSummon;
  return "pointer";
}
