/**
 * Role-registry submission declarations (#1031).
 * Each public seat names its tool, field schema, and status words here.
 * Review seats keep the #1028 schema. Other seats keep their own field guidance.
 * Execute lives in filed-submission.ts; this module is data only.
 */
import type { PackagedRole } from "./packaged-role-registry.ts";
import { REVIEW_QUEUE_WORDS, REVIEW_SUBMISSION_OUTPUT_TOOL_NAME, reviewSubmissionSchema } from "./review-submission.ts";
import { AUDITOR_OUTPUT_TOOL_NAME } from "./package-contracts/auditor-output.ts";
import { collectorOutputArgsSchema } from "./collector-tool-schemas.ts";
import { COLLECTOR_OUTPUT_TOOL } from "./package-contracts/collector-output.ts";
import { COUNTERSIGN_OUTPUT_TOOL_NAME } from "./countersign-contracts.ts";
import { diaristOutputSchema, DIARIST_OUTPUT_TOOL_NAME } from "./diarist-contracts.ts";
import { doctorSubmissionSchema, DOCTOR_OUTPUT_TOOL_DESCRIPTION, DOCTOR_OUTPUT_TOOL_NAME } from "./doctor-contracts.ts";
import { fixerOutputSchema, FIXER_OUTPUT_TOOL_NAME } from "./package-contracts/fixer-output.ts";
import { GATEKEEPER_OUTPUT_TOOL_NAME, gatekeeperOutputSchema } from "./package-contracts/gatekeeper-output.ts";
import { gleanerLeftOutputSchema, GLEANER_LEFT_OUTPUT_TOOL_NAME } from "./gleaner-left-contracts.ts";
import { INSPECTOR_OUTPUT_TOOL_NAME } from "./inspector-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "./package-contracts/judge-output.ts";
import { mergerOutputSchema, MERGER_OUTPUT_TOOL_NAME } from "./merger-contracts.ts";
import { NAVIGATOR_OUTPUT_TOOL_NAME, navigatorOutputSchema } from "./package-contracts/navigator-output.ts";
import { NOTARY_OUTPUT_TOOL_NAME } from "./notary-contracts.ts";
import { reviewerOutputSchema, REVIEWER_OUTPUT_TOOL_NAME } from "./package-contracts/reviewer-output.ts";
import { SECRETARIAT_OUTPUT_TOOL_NAME, secretariatVerdictSchema } from "./secretariat-contracts.ts";
import { coderOutputSchema, CODER_OUTPUT_TOOL_NAME } from "./package-contracts/worker-output.ts";

export type RoleSubmissionDeclaration = {
  readonly role: PackagedRole;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly parameters: unknown;
  readonly statusWords: readonly string[];
};

const WORKER_STATUS_WORDS = [
  "planned",
  "completed",
  "refused",
  "unfinished",
  "partially_completed",
] as const;

const DECLARATIONS = {
  judge: {
    role: "judge",
    name: JUDGE_OUTPUT_TOOL_NAME,
    label: "大理寺输出",
    description: "提交大理寺终局判词；交卷调用结束后，由公开调用接缝按判词状态执行适用审核。",
    promptSnippet: "提交大理寺终局判词",
    parameters: reviewSubmissionSchema,
    statusWords: REVIEW_QUEUE_WORDS,
  },
  fixer: {
    role: "fixer",
    name: FIXER_OUTPUT_TOOL_NAME,
    label: "修内司输出",
    description: "提交修内司终局回执。",
    promptSnippet: "提交修内司终局回执",
    parameters: fixerOutputSchema,
    statusWords: WORKER_STATUS_WORDS,
  },
  coder: {
    role: "coder",
    name: CODER_OUTPUT_TOOL_NAME,
    label: "将作监输出",
    description: "提交将作监终局回执。",
    promptSnippet: "提交将作监终局回执",
    parameters: coderOutputSchema,
    statusWords: WORKER_STATUS_WORDS,
  },
  reviewer: {
    role: "reviewer",
    name: REVIEWER_OUTPUT_TOOL_NAME,
    label: "御史台输出",
    description: "提交御史台终局回执。",
    promptSnippet: "提交御史台终局回执",
    parameters: reviewerOutputSchema,
    statusWords: ["completed", "refused"],
  },
  collector: {
    role: "collector",
    name: COLLECTOR_OUTPUT_TOOL,
    label: "通进司输出",
    description: "提交通进司回执。",
    promptSnippet: "提交通进司回执",
    parameters: collectorOutputArgsSchema,
    statusWords: [],
  },
  doctor: {
    role: "doctor",
    name: DOCTOR_OUTPUT_TOOL_NAME,
    label: "太医署输出",
    description: DOCTOR_OUTPUT_TOOL_DESCRIPTION,
    parameters: doctorSubmissionSchema,
    statusWords: ["completed", "refused"],
  },
  merger: {
    role: "merger",
    name: MERGER_OUTPUT_TOOL_NAME,
    label: "合并输出",
    description: "提交合并结果；输出分支为 completed 与 escalate。",
    promptSnippet: "提交合并结果",
    parameters: mergerOutputSchema,
    statusWords: ["completed", "escalate"],
  },
  notary: {
    role: "notary",
    name: NOTARY_OUTPUT_TOOL_NAME,
    label: "符宝郎输出",
    description: "提交引文保真与票面对齐的 converged/continue/escalate 决议。",
    promptSnippet: "提交符宝郎决议",
    parameters: reviewSubmissionSchema,
    statusWords: REVIEW_QUEUE_WORDS,
  },
  countersign: {
    role: "countersign",
    name: COUNTERSIGN_OUTPUT_TOOL_NAME,
    label: "给事中输出",
    description: "给事中决议。",
    promptSnippet: "给事中决议",
    parameters: reviewSubmissionSchema,
    statusWords: REVIEW_QUEUE_WORDS,
  },
  secretariat: {
    role: "secretariat",
    name: SECRETARIAT_OUTPUT_TOOL_NAME,
    label: "中书省输出",
    description: "中书省终局回执。",
    promptSnippet: "中书省终局回执",
    parameters: secretariatVerdictSchema,
    statusWords: ["converged", "escalate"],
  },
  "gleaner-left": {
    role: "gleaner-left",
    name: GLEANER_LEFT_OUTPUT_TOOL_NAME,
    label: "左拾遗输出",
    description: "左拾遗弹章。",
    promptSnippet: "左拾遗弹章",
    parameters: gleanerLeftOutputSchema,
    statusWords: ["completed"],
  },
  inspector: {
    role: "inspector",
    name: INSPECTOR_OUTPUT_TOOL_NAME,
    label: "台院输出",
    description: "台院终局回执，状态为 converged、continue 或 escalate。",
    promptSnippet: "台院终局回执",
    parameters: reviewSubmissionSchema,
    statusWords: REVIEW_QUEUE_WORDS,
  },
  gatekeeper: {
    role: "gatekeeper",
    name: GATEKEEPER_OUTPUT_TOOL_NAME,
    label: "门下省决议",
    description: "门下省终局决议。status 为 dispatch 或 pass。",
    promptSnippet: "门下省决议",
    parameters: gatekeeperOutputSchema,
    statusWords: ["dispatch", "pass"],
  },
  navigator: {
    role: "navigator",
    name: NAVIGATOR_OUTPUT_TOOL_NAME,
    label: "游奕使建议",
    description: "游奕使终局回执：散文建议，原样呈现。",
    promptSnippet: "游奕使建议",
    parameters: navigatorOutputSchema,
    statusWords: [],
  },
  auditor: {
    role: "auditor",
    name: AUDITOR_OUTPUT_TOOL_NAME,
    label: "审刑院输出",
    description: "审刑院终局回执，status 为 converged、continue 或 escalate。",
    promptSnippet: "审刑院终局回执",
    parameters: reviewSubmissionSchema,
    statusWords: REVIEW_QUEUE_WORDS,
  },
  diarist: {
    role: "diarist",
    name: DIARIST_OUTPUT_TOOL_NAME,
    label: "起居郎输出",
    description: "起居郎交单票 sessions 或多票逐票 ticketSessions 边界；认不出本庭对象则 escalate。",
    promptSnippet: "起居郎交边界",
    parameters: diaristOutputSchema,
    statusWords: ["completed", "escalate"],
  },
} as const satisfies Record<PackagedRole, RoleSubmissionDeclaration>;

export function roleSubmissionRoles(): readonly PackagedRole[] {
  return Object.keys(DECLARATIONS) as PackagedRole[];
}

export function roleSubmissionDeclaration(role: PackagedRole): RoleSubmissionDeclaration {
  return DECLARATIONS[role];
}

/** Review-officer tool name stays the #1028 shared name. */
export const REVIEW_OFFICER_SUBMISSION_TOOL_NAME = REVIEW_SUBMISSION_OUTPUT_TOOL_NAME;
