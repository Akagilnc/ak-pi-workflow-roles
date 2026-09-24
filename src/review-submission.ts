/** One shared terminating receipt contract for review officers (#1028 / #1055). */
import { Type } from "typebox";

import { infrastructureFailureDiagnostic, withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";
import { readableGateItem } from "./readable-gate-item.ts";

export const REVIEW_SUBMISSION_OUTPUT_TOOL_NAME = "ak_submission_output" as const;

/** Single schema copy of the review queue words. Runtime membership reads this set. */
export const REVIEW_QUEUE_WORDS = ["converged", "continue", "escalate"] as const;
export type ReviewQueueWord = (typeof REVIEW_QUEUE_WORDS)[number];
export const REVIEW_QUEUE_STATUSES: ReadonlySet<string> = new Set(REVIEW_QUEUE_WORDS);

/** Seats that share this receipt. Non-review tools keep the host-failure declaration path. */
export const REVIEW_QUEUE_ROLES = ["judge", "countersign", "notary", "auditor", "inspector"] as const;

export function isReviewQueueRole(role: string): boolean {
  return (REVIEW_QUEUE_ROLES as readonly string[]).includes(role);
}

/**
 * One object root. Codex structured output rejects a root anyOf, and status
 * stays a required three-state enum with no omitted-status failure branch.
 * A review seat that can still submit records a real external-dependency
 * failure as escalate plus the existing infrastructureFailure field.
 */
export const reviewSubmissionSchema = withTerminatingOutputDeclarations(
  Type.Object({
      status: Type.Union(
        [
          Type.Literal(REVIEW_QUEUE_WORDS[0]),
          Type.Literal(REVIEW_QUEUE_WORDS[1]),
          Type.Literal(REVIEW_QUEUE_WORDS[2]),
        ],
        {
          description: "审核队列三态枚举，必填。审核席仍能交卷而完成审核所需的外部依赖发生真实基础设施失败时，status 取 escalate，细节写入 infrastructureFailure。不得省略 status，不得用另两个枚举值充当放行或封驳。包侧不因格式拒收。",
        },
      ),
      findings: Type.Optional(Type.Unknown({ description: "审核发现，原样留存" })),
      reason: Type.Optional(Type.Unknown({ description: "上呈理由" })),
      violations: Type.Optional(Type.Unknown({ description: "违规条目" })),
      conflicts: Type.Optional(Type.Unknown({ description: "待决冲突" })),
      fix: Type.Optional(Type.Unknown({ description: "continue 时的补救说明；可写 summary 摘要，其余内容原样留存" })),
      classes: Type.Optional(Type.Unknown({ description: "已裁决 finding 类；可说明 name、owner、boundary、disposition，原样留存" })),
      note: Type.Optional(Type.Unknown({ description: "裁决附注" })),
      evidence: Type.Optional(Type.Unknown({ description: "留存证据" })),
      decisionGate: Type.Optional(Type.Unknown({ description: "需人权威处置的问题与选项；可说明 question、options，原样留存" })),
    }, { additionalProperties: true }),
);

export type ReviewInfrastructureRoute =
  | { readonly kind: "none" }
  | { readonly kind: "escalate" }
  | { readonly kind: "reask"; readonly receivedStatus: unknown };

/** Real failure declaration on a review receipt. Escalate keeps it; any other status is not a pass or reject. */
export function reviewInfrastructureRoute(parameters: unknown): ReviewInfrastructureRoute {
  if (infrastructureFailureDiagnostic(parameters) === undefined) return { kind: "none" };
  const record = parameters !== null && typeof parameters === "object" && !Array.isArray(parameters)
    ? parameters as Record<string, unknown>
    : undefined;
  if (record?.status === "escalate") return { kind: "escalate" };
  return {
    kind: "reask",
    receivedStatus: record !== undefined && Object.hasOwn(record, "status") ? record.status : undefined,
  };
}

/** Reask the same seat. Carries the received status and does not name the enum. */
export function reviewInfrastructureReask(receivedStatus: unknown): string {
  const received = receivedStatus === undefined
    ? "读不出 status"
    : `收到的 status：${readableGateItem(receivedStatus)}`;
  return `有基础设施失败声明，不能按放行或封驳收卷。${received}`;
}

export type ReviewSubmission = { readonly status?: unknown; readonly [key: string]: unknown };
