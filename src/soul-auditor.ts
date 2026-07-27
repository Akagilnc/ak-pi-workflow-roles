import {
  StringEnum,
  uuidv7,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions,
} from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
  SoulAuditInput,
  SoulAuditResult,
} from "./role-runtime.ts";

export const SOUL_AUDIT_TOOL_NAME = "ak_soul_audit_decision";

type AuditCompletion = (
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions,
) => Promise<AssistantMessage>;

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

function readAuditDecision(response: AssistantMessage): SoulAuditResult {
  const call = response.content.find(
    (part) =>
      part.type === "toolCall" && part.name === SOUL_AUDIT_TOOL_NAME,
  );
  if (call === undefined || call.type !== "toolCall") {
    throw new Error("invalid soul audit decision: missing decision tool call");
  }
  const status = call.arguments["status"];
  const rawViolations = call.arguments["violations"];
  const violations = Array.isArray(rawViolations)
    ? rawViolations.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0,
      )
    : [];

  if (status === "pass") {
    return { status: "pass", usage: response.usage };
  }
  if (status === "revise" && violations.length > 0) {
    return { status: "revise", violations, usage: response.usage };
  }
  throw new Error("invalid soul audit decision: expected pass or non-empty revise");
}

export function createPiSoulAuditor(
  runCompletion: AuditCompletion = (model, context, options) =>
    complete(model, context, options),
): (input: SoulAuditInput, options: SoulAuditOptions) => Promise<SoulAuditResult> {
  return async (input, options) => {
    const model = options.context.model;
    if (model === undefined) {
      throw new Error("Soul compliance audit requires an active model");
    }
    const auth = await options.context.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok) {
      throw new Error(`Soul compliance audit authentication failed: ${auth.error}`);
    }
    if (!auth.apiKey) {
      throw new Error(
        `Soul compliance audit has no API key for ${model.provider}`,
      );
    }

    const response = await runCompletion(
      model,
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
        apiKey: auth.apiKey,
        ...(auth.headers === undefined ? {} : { headers: auth.headers }),
        ...(auth.env === undefined ? {} : { env: auth.env }),
        maxTokens: 2048,
        cacheRetention: "none",
        sessionId: uuidv7(),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
    );

    return readAuditDecision(response);
  };
}
