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
} from "./compliance-transport.ts";
import type { SoulAuditInput, SoulAuditResult } from "./role-runtime.ts";

export const SOUL_AUDIT_TOOL_NAME = "ak_soul_audit_decision";

export type SoulAuditOptions = {
  context: ExtensionContext;
  signal?: AbortSignal;
};

const auditDecisionTool = {
  name: SOUL_AUDIT_TOOL_NAME,
  description:
    "Return whether the proposed verdict demonstrably follows the supplied judge soul.",
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

export function createPiSoulAuditor(
  runCompletion?: ComplianceCompletion,
): (input: SoulAuditInput, options: SoulAuditOptions) => Promise<SoulAuditResult> {
  return async (input, options) => {
    const model = options.context.model;
    if (model === undefined) {
      throw new Error("Soul compliance audit requires an active model");
    }
    const dispatch = await prepareComplianceDispatch(
      model,
      options.context,
      "Soul compliance audit",
    );
    const completeAudit =
      runCompletion ??
      ((auditModel: Model<Api>, auditContext: Context, auditOptions: ProviderStreamOptions) => {
        const provider = options.context.modelRegistry.getProvider(
          auditModel.provider,
        );
        if (provider === undefined) {
          throw new Error(
            `Soul compliance audit provider not found: ${auditModel.provider}`,
          );
        }
        return provider.stream(auditModel, auditContext, auditOptions).result();
      });
    const response = await completeAudit(
      dispatch.model,
      {
        systemPrompt: [
          "You are a procedural compliance auditor, not a second judge.",
          "Determine only whether the proposed verdict demonstrably applied the supplied judge soul to the adjudication record.",
          "Do not replace the judge's substantive finding decisions with your own.",
          `Call ${SOUL_AUDIT_TOOL_NAME} exactly once. Use pass only when the record demonstrates compliance; otherwise use revise and name each violated soul rule.`,
        ].join("\n"),
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: [
                  "<judge_soul>",
                  input.soul,
                  "</judge_soul>",
                  "<adjudication_record>",
                  input.transcript,
                  "</adjudication_record>",
                  "<proposed_verdict>",
                  JSON.stringify(input.verdict),
                  "</proposed_verdict>",
                ].join("\n"),
              },
            ],
            timestamp: Date.now(),
          },
        ],
        tools: [auditDecisionTool],
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
      SOUL_AUDIT_TOOL_NAME,
      "invalid soul audit decision",
    );
  };
}
