import type {
  Api,
  AssistantMessage,
  Context,
  Model,
  ProviderStreamOptions,
  Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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
