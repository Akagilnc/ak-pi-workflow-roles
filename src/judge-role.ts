import type { RoleHost, HostContext, HostToolResult, HostGatekeeperActions } from "./host-contracts.ts";
import { stringEnum } from "./host-contracts.ts";
import { Type, type Static } from "typebox";

import { disposeComplianceDecision } from "./audit-escalation.ts";
import type { ComplianceDecision } from "./compliance-transport.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

import {
  JUDGE_ACCEPTED_AUDIT_NO_RECEIPT_TEXT,
  JUDGE_ACCEPTED_TEXT,
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedJudgeDetails,
  type JudgeVerdict,
} from "./package-contracts/judge-output.ts";

export { JUDGE_OUTPUT_TOOL_NAME };
export type { JudgeVerdict };

export const judgeVerdictSchema = withInfrastructureFailureDeclaration(
  Type.Object(
    {
      judgeStatus: stringEnum(["converged", "continue", "escalate"] as const, { description: "converged | continue | escalate — 形状指引，非 schema 闸" }),
      fix: Type.Optional(
        Type.Object(
          { summary: Type.String({ minLength: 1, description: "continue 时的补救摘要" }) },
          { additionalProperties: false, description: "continue 时的补救说明" },
        ),
      ),
      classes: Type.Optional(Type.Array(Type.Object({
        name: Type.String({ minLength: 1 }),
        owner: Type.String({ minLength: 1 }),
        boundary: Type.String({ minLength: 1 }),
        disposition: Type.String({ minLength: 1 }),
      }, { additionalProperties: false }), { minItems: 1, description: "已裁决 finding 类及其 owner 与修理边界" })),
      note: Type.Optional(Type.String({ minLength: 1, description: "可选裁决附注" })),
      evidence: Type.Optional(Type.Unknown({ description: "留存的裁决证据" })),
      decisionGate: Type.Optional(
        Type.Object(
          {
            question: Type.String({ minLength: 1 }),
            options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
          },
          { additionalProperties: false, description: "需人权威处置的问题与选项" },
        ),
      ),
    },
    { additionalProperties: true },
  ),
);
(judgeVerdictSchema as unknown as { required: string[] }).required = [];

type JudgeVerdictParameters = Static<typeof judgeVerdictSchema>;

export type SoulAuditResult = ComplianceDecision;

export type JudgeRoleDependencies = {
  loadSoul(): Promise<string>;
  auditSoulCompliance(
    options: { context: HostContext; signal?: AbortSignal },
  ): Promise<SoulAuditResult>;
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
          description: "提交大理寺终局判词；受理前经审刑院审计。",
          promptSnippet: "提交大理寺终局判词",
          parameters: judgeVerdictSchema,
          async execute(toolCallId: string, parameters: Static<typeof judgeVerdictSchema>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext): Promise<HostToolResult<unknown>> {
            if (soul === undefined) throw new Error("大理寺职分未装载");
            const verdict = validateVerdict(parameters);
            // Candidate verdict is already on the parent session books as this
            // tool-call leaf (first-record-then-audit; run 019fea05 L61/L62).
            // Gatekeeper runs after the draft is booked and before existing auditor.
            await pi.requireGatekeeperPass!({
              context: ctx,
              subject: { kind: "judge_draft" },
              ...(signal === undefined ? {} : { signal }),
              hostActions,
              toolCallId,
            });
            let audit: SoulAuditResult;
            try {
              audit = await dependencies.auditSoulCompliance(
                signal === undefined
                  ? { context: ctx }
                  : { context: ctx, signal },
              );
            } catch (error) {
              hostActions.failInfrastructure(error, ctx, toolCallId);
            }
            const acceptedDetails = verdict;
            return disposeComplianceDecision<HostToolResult<unknown>>(
              audit,
              {
                pass: (usage) => ({
                  content: [{ type: "text" as const, text: JUDGE_ACCEPTED_TEXT }],
                  details: acceptedDetails,
                  terminate: true as const,
                  ...(usage === undefined ? {} : { usage }),
                }),
                noReceipt: (auditNoReceipt, usageProjection) => ({
                  content: [{ type: "text" as const, text: JUDGE_ACCEPTED_AUDIT_NO_RECEIPT_TEXT }],
                  details: { ...acceptedDetails, auditNoReceipt },
                  terminate: true as const,
                  ...usageProjection,
                }),
                revise: (violations) => {
                  throw new Error(
                    `大理寺回执违 soul：${violations.join("; ")}`,
                  );
                },
                escalate: (result) => result,
              },
              // #380: escalate deliveredOutput must carry the same mechanical projection.
              acceptedDetails,
            );
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
