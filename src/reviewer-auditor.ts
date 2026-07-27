import {
  StringEnum,
  uuidv7,
  type Api,
  type Context,
  type Model,
  type ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  prepareComplianceDispatch,
  readComplianceDecision,
  type ComplianceCompletion,
  type ComplianceDecision,
} from "./compliance-transport.ts";
import type { ReviewerAuditInput } from "./role-runtime.ts";

export const REVIEWER_AUDIT_TOOL_NAME = "ak_reviewer_audit_decision";

export type ReviewerAuditOptions = {
  context: ExtensionContext;
  signal?: AbortSignal;
};

const reviewerDecisionTool = {
  name: REVIEWER_AUDIT_TOOL_NAME,
  description:
    "Decide whether the Reviewer receipt demonstrably followed its supplied method and boundaries.",
  parameters: Type.Object(
    {
      status: StringEnum(["pass", "revise"] as const),
      violations: Type.Array(Type.String({ minLength: 1 })),
    },
    { additionalProperties: false },
  ),
  constrainedSampling: {
    type: "json_schema" as const,
    strict: "prefer" as const,
  },
};

export function createPiReviewerAuditor(
  runCompletion?: ComplianceCompletion,
): (
  input: ReviewerAuditInput,
  options: ReviewerAuditOptions,
) => Promise<ComplianceDecision> {
  return async (input, options) => {
    const model = options.context.model;
    if (model === undefined) {
      throw new Error("Reviewer compliance audit requires an active model");
    }
    const dispatch = await prepareComplianceDispatch(
      model,
      options.context,
      "Reviewer compliance audit",
    );
    const complete =
      runCompletion ??
      ((auditModel: Model<Api>, context: Context, request: ProviderStreamOptions) => {
        const provider = options.context.modelRegistry.getProvider(
          auditModel.provider,
        );
        if (provider === undefined) {
          throw new Error(
            `Reviewer compliance audit provider not found: ${auditModel.provider}`,
          );
        }
        return provider.stream(auditModel, context, request).result();
      });
    const response = await complete(
      dispatch.model,
      {
        systemPrompt: [
          "You audit Reviewer method compliance; you are not a second substantive reviewer.",
          "Check only demonstrated method compliance, target traceability, honest refusal, Standards/Spec isolation and skip handling, faithful aggregation, scratch-versus-target distinction, and Reviewer role boundaries.",
          "Do not discover findings, rerank axes, redo the review, decide mergeability, route work, or adjudicate the product.",
          `Call ${REVIEWER_AUDIT_TOOL_NAME} exactly once. Use pass only when the supplied structured record demonstrates compliance; otherwise use revise with specific violations.`,
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [{
              type: "text",
              text: [
                "<reviewer_soul>", input.soul, "</reviewer_soul>",
                "<canonical_code_review_skill>", input.canonicalSkill,
                "</canonical_code_review_skill>",
                "<opaque_review_task>", input.task, "</opaque_review_task>",
                "<structured_execution_record>", JSON.stringify(input.record),
                "</structured_execution_record>",
                "<candidate_receipt>", JSON.stringify(input.candidate),
                "</candidate_receipt>",
              ].join("\n"),
            }],
            timestamp: Date.now(),
          },
        ],
        tools: [reviewerDecisionTool],
      },
      {
        ...dispatch.auth,
        maxTokens: 2048,
        cacheRetention: "none",
        sessionId: uuidv7(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );
    return readComplianceDecision(
      response,
      REVIEWER_AUDIT_TOOL_NAME,
      "invalid reviewer audit decision",
    );
  };
}
