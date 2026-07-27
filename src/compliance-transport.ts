import {
  StringEnum,
  uuidv7,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export type ComplianceCompletion = (
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions,
) => Promise<AssistantMessage>;

export type ComplianceDecision =
  | { status: "pass"; usage?: Usage }
  | { status: "revise"; violations: readonly string[]; usage?: Usage };

export type ComplianceDispatch = {
  model: Model<Api>;
  auth: {
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  };
};

export function createComplianceDecisionTool(
  name: string,
  description: string,
) {
  return {
    name,
    description,
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
}

export async function prepareComplianceDispatch(
  model: Model<Api>,
  context: ExtensionContext,
  label: string,
): Promise<ComplianceDispatch> {
  const resolution = await context.modelRegistry
    .getProviderAuth(model.provider)
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${label} authentication failed: ${message}`, {
        cause: error,
      });
    });
  if (resolution === undefined) {
    throw new Error(
      `${label} authentication failed: provider is not configured: ${model.provider}`,
    );
  }
  const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    throw new Error(`${label} authentication failed: ${auth.error}`);
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

export function readComplianceDecision(
  response: AssistantMessage,
  toolName: string,
  invalidLabel: string,
): ComplianceDecision {
  const calls = response.content.filter((part) => part.type === "toolCall");
  const call = calls[0];
  if (
    calls.length !== 1 ||
    call?.type !== "toolCall" ||
    call.name !== toolName
  ) {
    throw new Error(
      `${invalidLabel}: expected exactly one decision tool call`,
    );
  }
  const arguments_: unknown = call.arguments;
  if (
    typeof arguments_ !== "object" ||
    arguments_ === null ||
    Array.isArray(arguments_)
  ) {
    throw new Error(`${invalidLabel}: arguments must be an object`);
  }
  const decision = arguments_ as Record<string, unknown>;
  const keys = Object.keys(decision);
  if (
    keys.length !== 2 ||
    !keys.includes("status") ||
    !keys.includes("violations")
  ) {
    throw new Error(`${invalidLabel}: arguments must have exact keys`);
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
    throw new Error(`${invalidLabel}: violations must be non-blank strings`);
  }
  if (status === "pass" && violations.length === 0) {
    return { status: "pass", usage: response.usage };
  }
  if (status === "revise" && violations.length > 0) {
    return { status: "revise", violations, usage: response.usage };
  }
  throw new Error(
    `${invalidLabel}: pass requires no violations and revise requires violations`,
  );
}

export async function runComplianceAudit(options: {
  tool: ReturnType<typeof createComplianceDecisionTool>;
  systemPrompt: string;
  serializedInput: string;
  roleLabel: string;
  invalidDecisionLabel: string;
  runCompletion?: ComplianceCompletion;
  context: ExtensionContext;
  signal?: AbortSignal;
}): Promise<ComplianceDecision> {
  const model = options.context.model;
  if (model === undefined) {
    throw new Error(`${options.roleLabel} requires an active model`);
  }
  const dispatch = await prepareComplianceDispatch(
    model,
    options.context,
    options.roleLabel,
  );
  const complete =
    options.runCompletion ??
    ((auditModel: Model<Api>, context: Context, request: ProviderStreamOptions) => {
      const provider = options.context.modelRegistry.getProvider(
        auditModel.provider,
      );
      if (provider === undefined) {
        throw new Error(
          `${options.roleLabel} provider not found: ${auditModel.provider}`,
        );
      }
      return provider.stream(auditModel, context, request).result();
    });
  const response = await complete(
    dispatch.model,
    {
      systemPrompt: options.systemPrompt,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: options.serializedInput }],
          timestamp: Date.now(),
        },
      ],
      tools: [options.tool],
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
    options.tool.name,
    options.invalidDecisionLabel,
  );
}
