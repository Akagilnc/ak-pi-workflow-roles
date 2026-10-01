/**
 * Field guidance for each public seat's submission tool (#1031).
 * The tool name is the role registry's outputTool. This module does not restate it.
 * Review seats keep the #1028 schema. Other seats keep their own field guidance.
 * Execute lives in filed-submission.ts.
 */
import { packagedRoleOutputTool, type PackagedRole } from "./packaged-role-registry.ts";
import { reviewSubmissionSchema } from "./review-submission.ts";
import { collectorOutputArgsSchema } from "./collector-tool-schemas.ts";
import { diaristOutputSchema } from "./diarist-contracts.ts";
import { doctorSubmissionSchema, DOCTOR_OUTPUT_TOOL_DESCRIPTION } from "./doctor-contracts.ts";
import { fixerOutputSchema } from "./package-contracts/fixer-output.ts";
import { gatekeeperOutputSchema } from "./package-contracts/gatekeeper-output.ts";
import { gleanerLeftOutputSchema } from "./gleaner-left-contracts.ts";
import { mergerOutputSchema } from "./merger-contracts.ts";
import { navigatorOutputSchema } from "./package-contracts/navigator-output.ts";
import { reviewerOutputSchema } from "./package-contracts/reviewer-output.ts";
import { secretariatVerdictSchema } from "./secretariat-contracts.ts";
import { coderOutputSchema } from "./package-contracts/worker-output.ts";

export type RoleSubmissionDeclaration = {
  readonly role: PackagedRole;
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly parameters: unknown;
};

type SubmissionFace = Omit<RoleSubmissionDeclaration, "role" | "name">;

const SUBMISSION_FACE = {
  judge: {
    label: "大理寺输出",
    description: "提交大理寺终局判词；交卷调用结束后，由公开调用接缝按判词状态执行适用审核。",
    promptSnippet: "提交大理寺终局判词",
    parameters: reviewSubmissionSchema,
  },
  fixer: {
    label: "修内司输出",
    description: "提交修内司终局回执。",
    promptSnippet: "提交修内司终局回执",
    parameters: fixerOutputSchema,
  },
  coder: {
    label: "将作监输出",
    description: "提交将作监终局回执。",
    promptSnippet: "提交将作监终局回执",
    parameters: coderOutputSchema,
  },
  reviewer: {
    label: "御史台输出",
    description: "提交御史台终局回执。",
    promptSnippet: "提交御史台终局回执",
    parameters: reviewerOutputSchema,
  },
  collector: {
    label: "通进司输出",
    description: "提交通进司回执。",
    promptSnippet: "提交通进司回执",
    parameters: collectorOutputArgsSchema,
  },
  doctor: {
    label: "太医署输出",
    description: DOCTOR_OUTPUT_TOOL_DESCRIPTION,
    parameters: doctorSubmissionSchema,
  },
  merger: {
    label: "合并输出",
    description: "提交合并结果；输出分支为 completed 与 escalate。",
    promptSnippet: "提交合并结果",
    parameters: mergerOutputSchema,
  },
  notary: {
    label: "符宝郎输出",
    description: "提交引文保真与票面对齐的 converged/continue/escalate 决议。",
    promptSnippet: "提交符宝郎决议",
    parameters: reviewSubmissionSchema,
  },
  countersign: {
    label: "给事中输出",
    description: "给事中决议。",
    promptSnippet: "给事中决议",
    parameters: reviewSubmissionSchema,
  },
  secretariat: {
    label: "中书省输出",
    description: "中书省终局回执。",
    promptSnippet: "中书省终局回执",
    parameters: secretariatVerdictSchema,
  },
  "gleaner-left": {
    label: "左拾遗输出",
    description: "左拾遗弹章。",
    promptSnippet: "左拾遗弹章",
    parameters: gleanerLeftOutputSchema,
  },
  inspector: {
    label: "台院输出",
    description: "台院终局回执，状态为 converged、continue 或 escalate。",
    promptSnippet: "台院终局回执",
    parameters: reviewSubmissionSchema,
  },
  gatekeeper: {
    label: "门下省决议",
    description: "门下省终局决议。status 为 dispatch 或 pass。",
    promptSnippet: "门下省决议",
    parameters: gatekeeperOutputSchema,
  },
  navigator: {
    label: "游奕使建议",
    description: "游奕使终局回执：散文建议，原样呈现。",
    promptSnippet: "游奕使建议",
    parameters: navigatorOutputSchema,
  },
  auditor: {
    label: "审刑院输出",
    description: "审刑院终局回执，status 为 converged、continue 或 escalate。",
    promptSnippet: "审刑院终局回执",
    parameters: reviewSubmissionSchema,
  },
  diarist: {
    label: "起居郎输出",
    description: "起居郎交单票 sessions 或多票逐票 ticketSessions 边界；认不出本庭对象则 escalate。",
    promptSnippet: "起居郎交边界",
    parameters: diaristOutputSchema,
  },
} as const satisfies Record<PackagedRole, SubmissionFace>;

/** Tool name comes from the registry record. Label and schema stay on this face. */
export function roleSubmissionDeclaration(role: PackagedRole): RoleSubmissionDeclaration {
  const name = packagedRoleOutputTool(role);
  if (name === undefined) throw new Error(`${role} output tool is not declared`);
  const face = SUBMISSION_FACE[role];
  return {
    role,
    name,
    label: face.label,
    description: face.description,
    ...("promptSnippet" in face ? { promptSnippet: face.promptSnippet } : {}),
    parameters: face.parameters,
  };
}
