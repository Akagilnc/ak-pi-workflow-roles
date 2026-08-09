import {
  uuidv7,
  type Api,
  type AssistantMessage,
  type Context,
  type Model,
  type ProviderStreamOptions,
  type ToolResultMessage,
  type Usage,
} from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  StreamIdleTimeoutError,
  createStreamIdleGuard,
  isStreamIdleTimeoutError,
} from "./stream-idle-guard.ts";

export {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  STREAM_IDLE_TIMEOUT_CODE,
  StreamIdleTimeoutError,
  createStreamIdleGuard,
  isStreamIdleTimeoutError,
} from "./stream-idle-guard.ts";
export type {
  StreamIdleGuard,
  StreamIdleGuardOptions,
} from "./stream-idle-guard.ts";

const COMPLIANCE_REQUEST_TIMEOUT_MS = 183000;

/**
 * Package-side idle retries after StreamIdleTimeoutError (fresh guard/signal per attempt).
 * Frozen at the OpenAI/Anthropic SDK default maxRetries (2 retries = 3 total attempts).
 * Provider HTTP maxRetries stay on the error path; do not stack a second idle-retry loop.
 */
export const DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES = 2;

export type ComplianceCompletion = (
  model: Model<Api>,
  context: Context,
  options: ProviderStreamOptions,
) => Promise<AssistantMessage>;

export type ComplianceArgumentRootType =
  | "null"
  | "array"
  | "undefined"
  | "string"
  | "number"
  | "boolean"
  | "bigint"
  | "symbol"
  | "function";

export type ComplianceAuditObservation =
  | {
    kind: "non-object-arguments";
    type: ComplianceArgumentRootType;
  }
  | {
    kind: "object-status-unreadable";
    status: "missing" | "unknown";
  }

export type ComplianceAuditIncomplete = {
  status: "audit-incomplete";
  observation: ComplianceAuditObservation;
  candidate: unknown;
  usage?: Usage;
};

export type ComplianceDecision =
  | { status: "pass"; usage?: Usage }
  | { status: "revise"; violations: readonly unknown[]; usage?: Usage }
  | {
    status: "escalate";
    /** Ancillary auditor fields are retained exactly when present. */
    conflicts?: unknown;
    decisionGate?: unknown;
    usage?: Usage;
  }
  | ComplianceAuditIncomplete;

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
 * The one provider-facing compliance schema. It deliberately remains an open,
 * zero-required object: the auditor owns decision meaning, while transport
 * retains the provider response and only enforces dispatch facts.
 */
export const complianceDecisionSchema = Type.Object(
  {
    status: Type.Union([
      Type.Literal("pass"),
      Type.Literal("revise"),
      Type.Literal("escalate"),
    ], { description: "Auditor decision status." }),
    violations: Type.Array(nonblank, { description: "Observed compliance violations." }),
    conflicts: Type.Array(nonblank, { description: "Unresolved authority or execution conflicts." }),
    decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "Escalation question and available options." }),
  },
  {
    additionalProperties: true,
    required: [],
  },
);

export function createComplianceDecisionTool(
  name: string,
  description: string,
) {
  return {
    name,
    description,
    parameters: complianceDecisionSchema,
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

const COMPLIANCE_AUDIT_TURN_LIMIT = 8;

export type ComplianceAuditTurnExhaustedFacts = ComplianceDecisionFacts & {
  turnLimit: number;
  observedTurns: number;
};

export class ComplianceAuditTurnExhaustedError extends Error {
  constructor(
    message: string,
    readonly details: ComplianceAuditTurnExhaustedFacts,
  ) {
    super(message);
    this.name = "ComplianceAuditTurnExhaustedError";
  }
}

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

/**
 * Read a compliance list field without dropping or inventing entries.
 * Array → as-is (including non-string elements). Otherwise present the whole
 * value as one entry; no JSON.parse guess and no silent filter.
 */
function readListField(value: unknown): readonly unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined) return [];
  return [value];
}

/**
 * Interpret one retained compliance candidate. This is the single owner for
 * escalation material semantics; settlement reuses it rather than making a
 * second, weaker kind/status recognizer.
 */
export function readComplianceCandidate(
  arguments_: unknown,
  usage?: Usage,
): ComplianceDecision {
  if (
    typeof arguments_ !== "object" ||
    arguments_ === null ||
    Array.isArray(arguments_)
  ) {
    const type: ComplianceArgumentRootType = arguments_ === null
      ? "null"
      : Array.isArray(arguments_)
        ? "array"
        : typeof arguments_ as ComplianceArgumentRootType;
    return {
      status: "audit-incomplete",
      observation: { kind: "non-object-arguments", type },
      candidate: arguments_,
      ...(usage === undefined ? {} : { usage }),
    };
  }

  const args = arguments_ as Record<string, unknown>;
  const status = args.status;
  if (status === "pass") {
    return { status: "pass", ...(usage === undefined ? {} : { usage }) };
  }
  if (status === "revise") {
    return {
      status: "revise",
      violations: readListField(args.violations),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  if (status === "escalate") {
    return {
      status: "escalate",
      ...(Object.hasOwn(args, "conflicts") ? { conflicts: args.conflicts } : {}),
      ...(Object.hasOwn(args, "decisionGate") ? { decisionGate: args.decisionGate } : {}),
      ...(usage === undefined ? {} : { usage }),
    };
  }
  return {
    status: "audit-incomplete",
    observation: {
      kind: "object-status-unreadable",
      status: status === undefined ? "missing" : "unknown",
    },
    candidate: arguments_,
    ...(usage === undefined ? {} : { usage }),
  };
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
  const decisionCalls = calls.filter((candidate) => candidate.name === toolName);
  const call = decisionCalls[decisionCalls.length - 1];
  if (call === undefined) {
    throw malformedComplianceDecision(
      response,
      toolName,
      invalidLabel,
      "expected a decision tool call",
      calls,
    );
  }
  const arguments_: unknown = call.arguments;
  // ADR 0055/0057: shape is guidance, not a reject gate. Read what arrived;
  // known status owns disposition even when ancillary fields are unusable.
  return readComplianceCandidate(arguments_, response.usage);
}

function throwIfStreamIdleTimedOut(reason: unknown): void {
  if (isStreamIdleTimeoutError(reason)) throw reason;
}

function abortRejectionReason(signal: AbortSignal): unknown {
  if (isStreamIdleTimeoutError(signal.reason)) return signal.reason;
  if (signal.reason instanceof Error) return signal.reason;
  return new Error(String(signal.reason ?? "aborted"));
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
  /** Idle silence budget (first wait + between events). Default 183s (#102 owner-final). */
  idleTimeoutMs?: number;
  /**
   * Package-side retries after StreamIdleTimeoutError only.
   * Default {@link DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES} (2 → 3 attempts).
   */
  idleMaxRetries?: number;
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
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
  const idleMaxRetries = options.idleMaxRetries ?? DEFAULT_COMPLIANCE_IDLE_MAX_RETRIES;
  // Silence clock starts with each attempt and resets only on real AssistantMessageEvent
  // yields from provider.stream — not on outbound payload transform or response headers.
  // Keep Pi's workspace-tool implementation behind the audit execution seam.
  // Eager value imports make the standalone public CLI bundle initialize Pi's
  // CommonJS process helpers even for discovery-only commands such as --help.
  const {
    createBashTool,
    createEditTool,
    createFindTool,
    createGrepTool,
    createLsTool,
    createReadTool,
    createWriteTool,
  } = await import("@earendil-works/pi-coding-agent");
  const workspaceTools = [
    createReadTool(options.context.cwd),
    createWriteTool(options.context.cwd),
    createEditTool(options.context.cwd),
    createBashTool(options.context.cwd),
    createGrepTool(options.context.cwd),
    createFindTool(options.context.cwd),
    createLsTool(options.context.cwd),
  ];
  const requestContext: Context = {
    systemPrompt: options.systemPrompt,
    messages: [
      {
        role: "user",
        content: [{
          type: "text",
          text: options.serializedInput,
        }],
        timestamp: Date.now(),
      },
    ],
    tools: [...workspaceTools, options.tool],
  };

  let lastIdleError: StreamIdleTimeoutError | undefined;
  let observedTurns = 0;
  for (let attempt = 0; attempt <= idleMaxRetries; attempt += 1) {
    if (options.signal?.aborted) {
      throw abortRejectionReason(options.signal);
    }
    const idle = createStreamIdleGuard({
      idleTimeoutMs,
      ...(options.signal === undefined ? {} : { parentSignal: options.signal }),
    });
    try {
      const complete =
        options.runCompletion ??
        (async (auditModel: Model<Api>, context: Context, request: ProviderStreamOptions) => {
          const provider = options.context.modelRegistry.getProvider(
            auditModel.provider,
          );
          if (provider === undefined) {
            throw new Error(
              `${options.roleLabel} provider not found: ${auditModel.provider}`,
            );
          }
          const stream = provider.stream(auditModel, context, request);
          for await (const _event of stream) {
            idle.poke();
          }
          return stream.result();
        });

      let response: AssistantMessage;
      try {
        const completeTurn = () => new Promise<AssistantMessage>((resolve, reject) => {
          const onAbort = (): void => {
            reject(abortRejectionReason(idle.signal));
          };
          if (idle.signal.aborted) {
            onAbort();
            return;
          }
          idle.signal.addEventListener("abort", onAbort, { once: true });
          void complete(
            dispatch.model,
            requestContext,
            {
              ...dispatch.auth,
              timeoutMs: COMPLIANCE_REQUEST_TIMEOUT_MS,
              maxTokens: 2048,
              cacheRetention: "none",
              sessionId: uuidv7(),
              signal: idle.signal,
            },
          ).then(
            (value) => {
              idle.signal.removeEventListener("abort", onAbort);
              resolve(value);
            },
            (error: unknown) => {
              idle.signal.removeEventListener("abort", onAbort);
              if (isStreamIdleTimeoutError(idle.signal.reason)) {
                reject(idle.signal.reason);
                return;
              }
              reject(error);
            },
          );
        });
        while (true) {
          response = await completeTurn();
          observedTurns += 1;
          throwIfStreamIdleTimedOut(idle.signal.reason);
          retainComplianceResponse(options.context, response);
          const calls = response.content.filter(
            (part): part is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
              part.type === "toolCall",
          );
          if (calls.some((call) => call.name === options.tool.name)) break;

          if (calls.length === 0) {
            return readComplianceDecision(
              response,
              options.tool.name,
              options.invalidDecisionLabel,
            );
          }
          requestContext.messages.push(response);
          for (const call of calls) {
            const tool = workspaceTools.find((candidate) => candidate.name === call.name);
            if (tool === undefined) {
              requestContext.messages.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [{
                  type: "text",
                  text: `Unknown compliance audit tool: ${call.name}`,
                }],
                isError: true,
                timestamp: Date.now(),
              });
              continue;
            }
            try {
              const result = await (tool.execute as (
                id: string,
                arguments_: Record<string, unknown>,
                signal?: AbortSignal,
              ) => Promise<{ content: ToolResultMessage["content"]; details?: unknown }>)(
                call.id,
                call.arguments,
                idle.signal,
              );
              requestContext.messages.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: result.content,
                details: result.details,
                isError: false,
                timestamp: Date.now(),
              });
            } catch (error) {
              if (idle.signal.aborted) {
                throw abortRejectionReason(idle.signal);
              }
              requestContext.messages.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [{
                  type: "text",
                  text: error instanceof Error ? error.message : String(error),
                }],
                isError: true,
                timestamp: Date.now(),
              });
            }
          }
          // Tool execution can be the operation that observes parent/idle abort.
          // Preserve that cancellation identity instead of converting it into
          // either a tool error result or turn-budget exhaustion.
          if (idle.signal.aborted) {
            throw abortRejectionReason(idle.signal);
          }
          if (observedTurns >= COMPLIANCE_AUDIT_TURN_LIMIT) {
            throw new ComplianceAuditTurnExhaustedError(
              `compliance audit exhausted its ${COMPLIANCE_AUDIT_TURN_LIMIT}-turn limit`,
              {
                turnLimit: COMPLIANCE_AUDIT_TURN_LIMIT,
                observedTurns,
                ...complianceDecisionFacts(response, options.tool.name, calls),
              },
            );
          }
        }
      } catch (error) {
        throwIfStreamIdleTimedOut(idle.signal.reason);
        throw error;
      }

      throwIfStreamIdleTimedOut(idle.signal.reason);
      return readComplianceDecision(
        response,
        options.tool.name,
        options.invalidDecisionLabel,
      );
    } catch (error) {
      if (
        isStreamIdleTimeoutError(error)
        && attempt < idleMaxRetries
        && options.signal?.aborted !== true
      ) {
        lastIdleError = error;
        continue;
      }
      throw error;
    } finally {
      idle.dispose();
    }
  }

  throw lastIdleError ?? new StreamIdleTimeoutError(idleTimeoutMs);
}
