import type { RoleHost, HostContext, HostToolResult, HostGatekeeperActions } from "./host-contracts.ts";
import { Type, type Static } from "typebox";

import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";
import { ParentQueueReaskError } from "./submission-errors.ts";

import {
  JUDGE_ACCEPTED_TEXT,
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedJudgeDetails,
  type JudgeVerdict,
} from "./package-contracts/judge-output.ts";

const JUDGE_QUEUE_STATUSES = new Set(["converged", "continue", "escalate"]);
const JUDGE_STATUS_REASK =
  "judgeStatus 不是 converged、continue、escalate 三态之一。请重新交卷，status 写明其一。" as const;

export { JUDGE_OUTPUT_TOOL_NAME };
export type { JudgeVerdict };

// #836 r16 class 1: fix/classes/note/decisionGate are LLM/human-read narrative
// content — 符宝郎/审刑院 read the raw receipt, no code branches on their length
// or nested presence. `judgeStatus` alone is the machine discriminator the
// queue reads to pick pass/bounce/escalate (src/judge-role.ts:90-125).
// #836 (ADR 0003 Amendment): judgeStatus kept open like countersignStatus
// (src/countersign-role.ts) — a closed domain here would reject an unknown
// value before the rawStatus/ParentQueueReaskError check below ever runs.
export const judgeVerdictSchema = withInfrastructureFailureDeclaration(
  Type.Object(
    {
      judgeStatus: Type.Unknown({ description: "converged | continue | escalate — 形状指引，非 schema 闸" }),
      fix: Type.Optional(
        Type.Object(
          { summary: Type.Optional(Type.String({ description: "continue 时的补救摘要" })) },
          { additionalProperties: true, description: "continue 时的补救说明" },
        ),
      ),
      classes: Type.Optional(Type.Array(Type.Object({
        name: Type.Optional(Type.String()),
        owner: Type.Optional(Type.String()),
        boundary: Type.Optional(Type.String()),
        disposition: Type.Optional(Type.String()),
      }, { additionalProperties: true }), { description: "已裁决 finding 类及其 owner 与修理边界" })),
      note: Type.Optional(Type.String({ description: "可选裁决附注" })),
      evidence: Type.Optional(Type.Unknown({ description: "留存的裁决证据" })),
      decisionGate: Type.Optional(
        Type.Object(
          {
            question: Type.Optional(Type.String()),
            options: Type.Optional(Type.Array(Type.String())),
          },
          { additionalProperties: true, description: "需人权威处置的问题与选项" },
        ),
      ),
    },
    { additionalProperties: true },
  ),
);
(judgeVerdictSchema as unknown as { required: string[] }).required = [];

type JudgeVerdictParameters = Static<typeof judgeVerdictSchema>;

export type JudgeRoleDependencies = {
  loadSoul(): Promise<string>;
};

export type JudgeRoleHostActions = HostGatekeeperActions;

export function validateVerdict(verdict: JudgeVerdictParameters): JudgeVerdict {
  return validateAcceptedJudgeDetails(verdict);
}


export function createJudgeRoleRuntime(
  pi: RoleHost,
  dependencies: JudgeRoleDependencies,
  hostActions: JudgeRoleHostActions,
): { activate(): Promise<void> } {
  let soul: string | undefined;
  let lifecycleRegistered = false;

  return {
    async activate() {
      soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Judge soul is empty");
      if (!lifecycleRegistered) {
        lifecycleRegistered = true;
        pi.registerTool({
          name: JUDGE_OUTPUT_TOOL_NAME,
          label: "大理寺输出",
          description: "提交大理寺终局判词；受理前经符宝郎内闸与审刑院合规审核。",
          promptSnippet: "提交大理寺终局判词",
          parameters: judgeVerdictSchema,
          async execute(toolCallId: string, parameters: Static<typeof judgeVerdictSchema>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext): Promise<HostToolResult<unknown>> {
            if (soul === undefined) throw new Error("大理寺职分未装载");
            // #756 queue: read judgeStatus only — escalate skips gates (thrown to caller);
            // unreadable status returns to judge; else 符宝郎内闸 then 审刑院合规.
            const rawStatus =
              parameters !== null && typeof parameters === "object" && !Array.isArray(parameters)
              && typeof (parameters as Record<string, unknown>).judgeStatus === "string"
                ? (parameters as Record<string, unknown>).judgeStatus as string
                : undefined;
            if (rawStatus === undefined || !JUDGE_QUEUE_STATUSES.has(rawStatus)) {
              throw new ParentQueueReaskError(JUDGE_STATUS_REASK);
            }
            if (rawStatus === "escalate") {
              // Parent escalate → throw to caller as-is; officers do not attend (#753 / #756).
              const verdict = validateVerdict(parameters);
              return {
                content: [{ type: "text" as const, text: JUDGE_ACCEPTED_TEXT }],
                details: verdict,
                terminate: true as const,
              };
            }
            const verdict = validateVerdict(parameters);
            // Candidate verdict is already on the parent session books as this
            // tool-call leaf (first-record-then-audit; run 019fea05 L61/L62).
            // #753: 符宝郎内闸 — queue only, raw receipt on bounce/escalate.
            await pi.requireGatekeeperPass!({
              context: ctx,
              subject: { kind: "judge_draft" },
              ...(signal === undefined ? {} : { signal }),
              hostActions,
              toolCallId,
              // #879: this-turn typed payload — identity-bound at submit site.
              submission: parameters,
            });
            // #756: 审刑院合规路径 — same review-queue law as 符宝郎/察院.
            // pass → accept; bounce|escalate → raw auditor receipt back to judge;
            // not three-state → resume auditor; no round cap; no disposeCompliance mapping.
            await pi.requireGatekeeperPass!({
              context: ctx,
              subject: { kind: "judge_compliance" },
              ...(signal === undefined ? {} : { signal }),
              hostActions,
              toolCallId,
              // #879: same parent payload for 审刑院; not recovered from session latest.
              submission: parameters,
            });
            return {
              content: [{ type: "text" as const, text: JUDGE_ACCEPTED_TEXT }],
              details: verdict,
              terminate: true as const,
            };
          },
        });
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("大理寺职分未装载");
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<judge_soul>\n${soul}\n</judge_soul>`,
          };
        });
      }
    },
  };
}
