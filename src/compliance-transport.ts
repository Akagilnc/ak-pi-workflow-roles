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

/**
 * Codex requires the registered function parameters to be an object at the
 * root. Status-dependent field combinations are checked by the shared parser
 * below because JSON Schema cannot express this contract without a root union.
 */
export const complianceDecisionSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("pass"),
      Type.Literal("revise"),
      Type.Literal("escalate"),
    ]),
    violations: Type.Array(nonblank),
    conflicts: Type.Array(nonblank),
    decisionGate: Type.Union([decisionGateSchema, Type.Null()]),
  },
  { additionalProperties: false },
);

const complianceDecisionArgumentInstructions = [
  "Call the supplied decision tool exactly once with all four required fields.",
  'pass: {"status":"pass","violations":[],"conflicts":[],"decisionGate":null}',
  'revise: {"status":"revise","violations":["non-blank violation"],"conflicts":[],"decisionGate":null}',
  'escalate: {"status":"escalate","violations":[],"conflicts":["non-blank conflict"],"decisionGate":{"question":"non-blank question","options":["non-blank option"]}}',
  "Use the neutral values shown for fields not used by the selected status.",
].join("\n");

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

export const COMPLIANCE_RESPONSE_ENTRY_TYPE = "ak_compliance_response" as const;

export type ComplianceDecisionFacts = {
  expectedDecisionToolName: string;
  observedToolCallCount: number;
  observedToolNames: string[];
  responseStopReason: AssistantMessage["stopReason"];
  provider: AssistantMessage["provider"];
  model: AssistantMessage["model"];
  responseModel: string | null;
  errorMessage: string | null;
  diagnostics: NonNullable<AssistantMessage["diagnostics"]>;
};

export class ComplianceDecisionContractError extends Error {
  constructor(
    message: string,
    readonly details: ComplianceDecisionFacts,
  ) {
    super(message);
    this.name = "ComplianceDecisionContractError";
  }
}

export class ComplianceResponseRetentionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ComplianceResponseRetentionError";
  }
}

type ActiveSessionResponseAppender = {
  appendCustomEntry(customType: string, data?: unknown): string;
};

function complianceDecisionFacts(
  response: AssistantMessage,
  toolName: string,
  calls: readonly Extract<AssistantMessage["content"][number], { type: "toolCall" }>[],
): ComplianceDecisionFacts {
  return {
    expectedDecisionToolName: toolName,
    observedToolCallCount: calls.length,
    observedToolNames: calls.map((call) => call.name),
    responseStopReason: response.stopReason,
    provider: response.provider,
    model: response.model,
    responseModel: response.responseModel ?? null,
    errorMessage: response.errorMessage ?? null,
    diagnostics: response.diagnostics ?? [],
  };
}

function malformedComplianceDecision(
  response: AssistantMessage,
  toolName: string,
  invalidLabel: string,
  reason: string,
  calls: readonly Extract<AssistantMessage["content"][number], { type: "toolCall" }>[],
): ComplianceDecisionContractError {
  return new ComplianceDecisionContractError(
    `${invalidLabel}: ${reason}`,
    complianceDecisionFacts(response, toolName, calls),
  );
}

function isArrayOfStrings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

type ValidComplianceDecisionArguments =
  | { status: "pass"; violations: readonly string[] }
  | { status: "revise"; violations: readonly string[] }
  | {
    status: "escalate";
    conflicts: readonly string[];
    decisionGate: { question: string; options: readonly string[] };
  };

function validateStatusDependentDecision(
  decision: ComplianceDecisionArguments,
  response: AssistantMessage,
  toolName: string,
  invalidLabel: string,
  calls: readonly Extract<AssistantMessage["content"][number], { type: "toolCall" }>[],
): ValidComplianceDecisionArguments {
  const reject = (reason: string): never => {
    throw malformedComplianceDecision(
      response,
      toolName,
      invalidLabel,
      reason,
      calls,
    );
  };

  switch (decision.status) {
    case "pass": {
      const { violations, conflicts, decisionGate } = decision;
      if (
        !isArrayOfStrings(violations) ||
        !isArrayOfStrings(conflicts) ||
        violations.length !== 0 ||
        conflicts.length !== 0 ||
        decisionGate !== null
      ) {
        reject("arguments do not match the pass decision contract");
      }
      return { status: "pass", violations };
    }
    case "revise": {
      const { violations, conflicts, decisionGate } = decision;
      if (
        !isArrayOfStrings(violations) ||
        !isArrayOfStrings(conflicts) ||
        violations.length === 0 ||
        conflicts.length !== 0 ||
        decisionGate !== null
      ) {
        reject("arguments do not match the revise decision contract");
      }
      return { status: "revise", violations };
    }
    case "escalate": {
      const { violations, conflicts, decisionGate } = decision;
      if (
        !isArrayOfStrings(violations) ||
        !isArrayOfStrings(conflicts) ||
        violations.length !== 0 ||
        conflicts.length === 0 ||
        decisionGate === null
      ) {
        reject("arguments do not match the escalate decision contract");
      }
      const validDecisionGate = decisionGate ?? reject("arguments do not match the escalate decision contract");
      return { status: "escalate", conflicts, decisionGate: validDecisionGate };
    }
  }
}

/**
 * Retain the provider's structured response as extension state, not a
 * conversational message. A missing or failed append is an infrastructure
 * failure because the nested response is mandatory audit evidence.
 */
function retainComplianceResponse(
  context: ExtensionContext,
  response: AssistantMessage,
): void {
  const sessionManager = context.sessionManager as unknown as
    | (Partial<ActiveSessionResponseAppender> & object)
    | undefined;
  if (typeof sessionManager?.appendCustomEntry !== "function") {
    throw new ComplianceResponseRetentionError(
      "compliance response retention is unavailable",
    );
  }
  try {
    sessionManager.appendCustomEntry(COMPLIANCE_RESPONSE_ENTRY_TYPE, {
      version: 1,
      response,
    });
  } catch (error) {
    throw new ComplianceResponseRetentionError(
      "compliance response retention failed",
      { cause: error },
    );
  }
}

export function readComplianceDecision(
  response: AssistantMessage,
  toolName: string,
  invalidLabel: string,
): ComplianceDecision {
  const calls = response.content.filter(
    (part): part is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
      part.type === "toolCall",
  );
  if (response.stopReason === "error" || response.stopReason === "aborted") {
    throw malformedComplianceDecision(
      response,
      toolName,
      invalidLabel,
      `provider response terminated with stopReason ${response.stopReason}`,
      calls,
    );
  }
  const call = calls[0];
  if (
    calls.length !== 1 ||
    call?.type !== "toolCall" ||
    call.name !== toolName
  ) {
    throw malformedComplianceDecision(
      response,
      toolName,
      invalidLabel,
      "expected exactly one decision tool call",
      calls,
    );
  }
  const arguments_: unknown = call.arguments;
  if (
    typeof arguments_ !== "object" ||
    arguments_ === null ||
    Array.isArray(arguments_)
  ) {
    throw malformedComplianceDecision(
      response,
      toolName,
      invalidLabel,
      "arguments must be an object",
      calls,
    );
  }
  if (!Value.Check(complianceDecisionSchema, arguments_)) {
    throw malformedComplianceDecision(
      response,
      toolName,
      invalidLabel,
      "arguments do not match the decision schema",
      calls,
    );
  }
  const decision = validateStatusDependentDecision(
    arguments_ as ComplianceDecisionArguments,
    response,
    toolName,
    invalidLabel,
    calls,
  );
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
          content: [{
            type: "text",
            text: `${options.serializedInput}\n<decision_tool_contract>\n${complianceDecisionArgumentInstructions}\n</decision_tool_contract>`,
          }],
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
  retainComplianceResponse(options.context, response);
  return readComplianceDecision(
    response,
    options.tool.name,
    options.invalidDecisionLabel,
  );
}
