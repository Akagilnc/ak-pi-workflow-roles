import {
  StringEnum,
  uuidv7,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions,
} from "@earendil-works/pi-ai";
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

type AuditDispatch = {
  model: Model<Api>;
  auth: {
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  };
};

async function prepareAuditDispatch(
  model: Model<Api>,
  context: ExtensionContext,
): Promise<AuditDispatch> {
  const resolution = await context.modelRegistry
    .getProviderAuth(model.provider)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Soul compliance audit authentication failed: ${message}`, {
        cause: error,
      });
    });
  if (resolution === undefined) {
    throw new Error(
      `Soul compliance audit authentication failed: provider is not configured: ${model.provider}`,
    );
  }

  const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`Soul compliance audit authentication failed: ${auth.error}`);
  }

  return {
    model: resolution.auth.baseUrl
      ? { ...model, baseUrl: resolution.auth.baseUrl }
      : model,
    auth: {
      ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }),
      ...(auth.headers === undefined ? {} : { headers: auth.headers }),
      ...(auth.env === undefined ? {} : { env: auth.env }),
    },
  };
}

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
  const calls = response.content.filter(
    (part) => part.type === "toolCall",
  );
  const call = calls[0];
  if (
    calls.length !== 1 ||
    call?.type !== "toolCall" ||
    call.name !== SOUL_AUDIT_TOOL_NAME
  ) {
    throw new Error(
      "invalid soul audit decision: expected exactly one decision tool call",
    );
  }

  const arguments_: unknown = call.arguments;
  if (
    typeof arguments_ !== "object" ||
    arguments_ === null ||
    Array.isArray(arguments_)
  ) {
    throw new Error("invalid soul audit decision: arguments must be an object");
  }
  const decision = arguments_ as Record<string, unknown>;
  const keys = Object.keys(decision);
  if (
    keys.length !== 2 ||
    !keys.includes("status") ||
    !keys.includes("violations")
  ) {
    throw new Error("invalid soul audit decision: arguments must have exact keys");
  }

  const status = decision["status"];
  const violations = decision["violations"];
  if (
    !Array.isArray(violations) ||
    !violations.every(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
  ) {
    throw new Error("invalid soul audit decision: violations must be non-blank strings");
  }
  if (status === "pass" && violations.length === 0) {
    return { status: "pass", usage: response.usage };
  }
  if (status === "revise" && violations.length > 0) {
    return { status: "revise", violations, usage: response.usage };
  }
  throw new Error(
    "invalid soul audit decision: pass requires no violations and revise requires violations",
  );
}

export function createPiSoulAuditor(
  runCompletion?: AuditCompletion,
): (input: SoulAuditInput, options: SoulAuditOptions) => Promise<SoulAuditResult> {
  return async (input, options) => {
    const model = options.context.model;
    if (model === undefined) {
      throw new Error("Soul compliance audit requires an active model");
    }
    const dispatch = await prepareAuditDispatch(model, options.context);

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

    return readAuditDecision(response);
  };
}
