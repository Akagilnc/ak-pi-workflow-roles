import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import { disposeComplianceDecision } from "./audit-escalation.ts";
import type { ComplianceDecision } from "./compliance-transport.ts";

import {
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedJudgeDetails,
  type JudgeVerdict,
} from "./package-contracts/judge-output.ts";

export { JUDGE_OUTPUT_TOOL_NAME };
export type { JudgeVerdict };

const judgeVerdictSchema = Type.Object(
  {
    judgeStatus: StringEnum(["converged", "continue", "escalate"] as const, { description: "Judge adjudication outcome discriminator." }),
    fix: Type.Optional(
      Type.Object(
        { summary: Type.String({ minLength: 1, description: "Required remediation summary." }) },
        { additionalProperties: false, description: "Remediation requested when adjudication must continue." },
      ),
    ),
    classes: Type.Optional(Type.Array(Type.Object({
      name: Type.String({ minLength: 1 }),
      owner: Type.String({ minLength: 1 }),
      boundary: Type.String({ minLength: 1 }),
      disposition: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }), { minItems: 1, description: "Adjudicated finding classes with owner and repair boundary." })),
    note: Type.Optional(Type.String({ minLength: 1, description: "Optional adjudication note." })),
    evidence: Type.Optional(Type.Unknown({ description: "Retained adjudication evidence." })),
    decisionGate: Type.Optional(
      Type.Object(
        {
          question: Type.String({ minLength: 1 }),
          options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        },
        { additionalProperties: false, description: "Question and options requiring human authority." },
      ),
    ),
  },
  { additionalProperties: true },
);
(judgeVerdictSchema as unknown as { required: string[] }).required = [];

type JudgeVerdictParameters = Static<typeof judgeVerdictSchema>;

export type SoulAuditResult = ComplianceDecision;

export type JudgeRoleDependencies = {
  loadSoul(): Promise<string>;
  auditSoulCompliance(
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<SoulAuditResult>;
};

export type JudgeRoleHostActions = {
  failInfrastructure(error: unknown, ctx: ExtensionContext, toolCallId?: string): never;
};

export function validateVerdict(verdict: JudgeVerdictParameters): JudgeVerdict {
  return validateAcceptedJudgeDetails(verdict);
}

function requireSingletonSubmissionCall(
  toolCallId: string,
  ctx: ExtensionContext,
): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") {
    throw new Error("Judge output must be the sole final tool call");
  }
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  const call = calls[0];
  if (
    calls.length !== 1 || call === undefined || call.id !== toolCallId ||
    call.name !== JUDGE_OUTPUT_TOOL_NAME
  ) {
    throw new Error("Judge output must be the sole final tool call");
  }
}

export function createJudgeRoleRuntime(
  pi: ExtensionAPI,
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
          label: "Judge Output",
          description:
            "Submit the final judge verdict. Soul compliance is audited before acceptance.",
          promptSnippet: "Submit the final judge verdict after adjudication",
          promptGuidelines: [
            `Use ${JUDGE_OUTPUT_TOOL_NAME} as the final action for the judge role.`,
          ],
          parameters: judgeVerdictSchema,
          async execute(toolCallId, parameters, signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
            if (soul === undefined) throw new Error("Judge soul was not loaded");
            requireSingletonSubmissionCall(toolCallId, ctx);
            const verdict = validateVerdict(parameters);
            // Candidate verdict is already on the parent session books as this
            // tool-call leaf (first-record-then-audit; run 019fea05 L61/L62).
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
            return disposeComplianceDecision<AgentToolResult<unknown>>(
              audit,
              {
                pass: (usage) => ({
                  content: [{ type: "text" as const, text: "Judge verdict accepted" }],
                  details: verdict,
                  terminate: true as const,
                  ...(usage === undefined ? {} : { usage }),
                }),
                noReceipt: (auditNoReceipt) => ({
                  content: [{ type: "text" as const, text: "Judge verdict accepted; compliance audit produced no receipt" }],
                  details: { ...verdict, auditNoReceipt },
                  terminate: true as const,
                  ...(auditNoReceipt.usage === undefined ? {} : { usage: auditNoReceipt.usage }),
                }),
                revise: (violations) => {
                  throw new Error(
                    `Judge verdict violates its soul: ${violations.join("; ")}`,
                  );
                },
                escalate: (result) => result,
                auditIncomplete: (result) => result,
              },
              verdict,
            );
          },
        });
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("Judge soul was not loaded");
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<judge_soul>\n${soul}\n</judge_soul>`,
          };
        });
      }
    },
  };
}
