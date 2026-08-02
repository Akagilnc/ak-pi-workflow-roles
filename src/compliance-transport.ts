import {
  uuidv7,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

export type ComplianceCompletion = (
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions,
) => Promise<AssistantMessage>;

export type ComplianceDecision =
  | { status: "pass"; usage?: Usage }
  | { status: "revise"; violations: readonly string[]; usage?: Usage }
  | {
    status: "escalate";
    conflicts: readonly string[];
    decisionGate: { question: string; options: readonly string[] };
    usage?: Usage;
  };

export type ComplianceDispatch = {
  model: Model<Api>;
  auth: {
    apiKey?: string;
    headers?: Record<string, string>;
    env?: Record<string, string>;
  };
};

const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object(
  {
    question: nonblank,
    options: Type.Array(nonblank, { minItems: 1 }),
  },
  { additionalProperties: false },
);

/** The registered audit tool is the single field/status-leaf schema owner. */
export const complianceDecisionSchema = Type.Union([
  Type.Object(
    {
      status: Type.Literal("pass"),
      // Preserve the established pass shape: an explicitly empty violations list.
      violations: Type.Array(nonblank, { maxItems: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("revise"),
      violations: Type.Array(nonblank, { minItems: 1 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      status: Type.Literal("escalate"),
      conflicts: Type.Array(nonblank, { minItems: 1 }),
      decisionGate: decisionGateSchema,
    },
    { additionalProperties: false },
  ),
]);

type ComplianceDecisionArguments = Static<typeof complianceDecisionSchema>;

type ComplianceToolChoice =
  | "any"
  | "required"
  | { type: "function"; name: string }
  | { type: "function"; function: { name: string } }
  | { type: "tool"; name: string };

function complianceToolChoice(model: Model<Api>, toolName: string): ComplianceToolChoice {
  switch (model.api) {
    case "anthropic-messages":
    case "bedrock-converse-stream":
      return { type: "tool", name: toolName };
    case "mistral-conversations":
    case "openai-completions":
    case "pi-messages":
      return { type: "function", function: { name: toolName } };
    case "azure-openai-responses":
    case "openai-responses":
      return { type: "function", name: toolName };
    case "google-generative-ai":
    case "google-vertex":
      return "any";
    case "openai-codex-responses":
      return "required";
    default:
      return "required";
  }
}

function singleComplianceToolCallPayload(
  model: Model<Api>,
  toolName: string,
): ProviderStreamOptions["onPayload"] | undefined {
  switch (model.api) {
    case "azure-openai-responses":
    case "openai-completions":
    case "openai-codex-responses":
    case "openai-responses":
      return (payload: unknown) => {
        if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
          return payload;
        }
        return {
          ...(payload as Record<string, unknown>),
          parallel_tool_calls: false,
          tool_choice: complianceToolChoice(model, toolName),
        };
      };
    default:
      return undefined;
  }
}

export function createComplianceDecisionTool(
  name: string,
  description: string,
) {
  return {
    name,
    description,
    parameters: complianceDecisionSchema,
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
  if (!Value.Check(complianceDecisionSchema, arguments_)) {
    throw new Error(`${invalidLabel}: arguments do not match the decision schema`);
  }
  const decision = arguments_ as ComplianceDecisionArguments;
  switch (decision.status) {
    case "pass":
      return { status: "pass", usage: response.usage };
    case "revise":
      return {
        status: "revise",
        violations: decision.violations,
        usage: response.usage,
      };
    case "escalate":
      return {
        status: "escalate",
        conflicts: decision.conflicts,
        decisionGate: decision.decisionGate,
        usage: response.usage,
      };
  }
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
  const onPayload = singleComplianceToolCallPayload(
    dispatch.model,
    options.tool.name,
  );
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
      toolChoice: complianceToolChoice(dispatch.model, options.tool.name),
      ...(onPayload === undefined ? {} : { onPayload }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
  );
  return readComplianceDecision(
    response,
    options.tool.name,
    options.invalidDecisionLabel,
  );
}
