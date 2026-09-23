import type { RoleHost, HostContext, HostToolResult, HostGatekeeperActions } from "./host-contracts.ts";
import type { Static } from "typebox";
import { reviewSubmissionSchema } from "./review-submission.ts";
import { GatekeeperDecisionError, ParentQueueReaskError } from "./submission-errors.ts";
import { projectGatekeeperEscalation } from "./audit-escalation.ts";

import { readableGateItem } from "./readable-gate-item.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedJudgeDetails,
  type JudgeVerdict,
} from "./package-contracts/judge-output.ts";

const JUDGE_QUEUE_STATUSES = new Set(["converged", "continue", "escalate"]);
const JUDGE_STATUS_REASK =
  "status 不是 converged、continue、escalate 三态之一。请重新交卷，status 写明其一。" as const;

export { JUDGE_OUTPUT_TOOL_NAME };
export type { JudgeVerdict };

// #836 r16 class 1: fix/classes/note/decisionGate are LLM/human-read narrative
// content — 符宝郎/审刑院 read the raw receipt, no code branches on their length
// or nested presence. `status` alone is the machine discriminator the
// queue reads to pick converged/continue/escalate (below).
// The shared open schema preserves role-specific prose without adding another contract.
export const judgeVerdictSchema = reviewSubmissionSchema;

type JudgeVerdictParameters = Static<typeof judgeVerdictSchema>;

export type JudgeRoleDependencies = {
  loadSoul(): Promise<string>;
};

export type JudgeRoleHostActions = HostGatekeeperActions & {
  /** Preserve the first officer's pass as a separate model-visible result item if the second gate fails. */
  bindPriorGatePass(toolCallId: string, receipt: unknown): void;
};

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
            // #756 queue: read shared status only — escalate skips gates;
            // unreadable status returns to judge; else 符宝郎内闸 then 审刑院合规.
            const rawStatus =
              parameters !== null && typeof parameters === "object" && !Array.isArray(parameters)
              && typeof (parameters as Record<string, unknown>).status === "string"
                ? (parameters as Record<string, unknown>).status as string
                : undefined;
            if (rawStatus === undefined || !JUDGE_QUEUE_STATUSES.has(rawStatus)) {
              throw new ParentQueueReaskError(JUDGE_STATUS_REASK);
            }
            if (rawStatus === "escalate") {
              // Parent escalate → throw to caller as-is; officers do not attend (#753 / #756).
              const verdict = validateVerdict(parameters);
              return {
                content: [],
                details: verdict,
                terminate: true as const,
              };
            }
            const verdict = validateVerdict(parameters);
            // Candidate verdict is already on the parent session books as this
            // tool-call leaf (first-record-then-audit; run 019fea05 L61/L62).
            // #753: 符宝郎内闸 — continue returns the raw receipt as a nonterminal tool result.
            let draftPass: { status: "converged" | "continue"; receipt: unknown } | undefined;
            try {
              const obtainedDraftPass = await pi.requireSubmissionGate!({
                context: ctx,
                subject: { kind: "judge_draft" },
                ...(signal === undefined ? {} : { signal }),
                hostActions,
                toolCallId,
                // #879: this-turn typed payload — identity-bound at submit site.
                submission: parameters,
              });
              draftPass = obtainedDraftPass || undefined;
              if (draftPass?.status === "continue") {
                return {
                  content: [{ type: "text" as const, text: readableGateItem(draftPass.receipt) }],
                  details: verdict,
                  terminate: false,
                };
              }
              if (draftPass !== undefined) hostActions.bindPriorGatePass(toolCallId, draftPass.receipt);
              // #756: 审刑院合规路径 — same review-queue law as 符宝郎/台院.
              // converged → accept; continue → raw auditor receipt; escalate → pause;
              // not three-state → resume auditor; no round cap; no disposeCompliance mapping.
              const compliancePass = await pi.requireSubmissionGate!({
                context: ctx,
                subject: { kind: "judge_compliance" },
                ...(signal === undefined ? {} : { signal }),
                hostActions,
                toolCallId,
                // #879: same parent payload for 审刑院; not recovered from session latest.
                submission: parameters,
              });
              if (compliancePass?.status === "continue") {
                return {
                  content: [{ type: "text" as const, text: readableGateItem(compliancePass.receipt) }],
                  details: verdict,
                  terminate: false,
                };
              }
              return {
                content: [draftPass, compliancePass].filter((pass) => pass !== undefined).map((pass) => ({ type: "text" as const, text: readableGateItem(pass.receipt) })),
                details: verdict,
                terminate: true as const,
              };
            } catch (error) {
              if (error instanceof GatekeeperDecisionError && error.result.status === "escalate") {
                return projectGatekeeperEscalation(error.result, verdict);
              }
              throw error;
            }
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
