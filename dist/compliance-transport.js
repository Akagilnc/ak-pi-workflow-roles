import { uuidv7, } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({
    question: nonblank,
    options: Type.Array(nonblank, { minItems: 1 }),
}, { additionalProperties: false });
/**
 * Codex requires the registered function parameters to be an object at the
 * root. Status-dependent field combinations are checked by the shared parser
 * below because JSON Schema cannot express this contract without a root union.
 */
export const complianceDecisionSchema = Type.Object({
    status: Type.Union([
        Type.Literal("pass"),
        Type.Literal("revise"),
        Type.Literal("escalate"),
    ]),
    violations: Type.Optional(Type.Array(nonblank)),
    conflicts: Type.Optional(Type.Array(nonblank)),
    decisionGate: Type.Optional(decisionGateSchema),
}, { additionalProperties: false });
function complianceToolChoice(model, toolName) {
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
function singleComplianceToolCallPayload(model, toolName) {
    switch (model.api) {
        case "azure-openai-responses":
        case "openai-completions":
        case "openai-codex-responses":
        case "openai-responses":
            return (payload) => {
                if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
                    return payload;
                }
                return {
                    ...payload,
                    parallel_tool_calls: false,
                    tool_choice: complianceToolChoice(model, toolName),
                };
            };
        default:
            return undefined;
    }
}
export function createComplianceDecisionTool(name, description) {
    return {
        name,
        description,
        parameters: complianceDecisionSchema,
        constrainedSampling: {
            type: "json_schema",
            strict: "prefer",
        },
    };
}
export async function prepareComplianceDispatch(model, context, label) {
    const resolution = await context.modelRegistry
        .getProviderAuth(model.provider)
        .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${label} authentication failed: ${message}`, {
            cause: error,
        });
    });
    if (resolution === undefined) {
        throw new Error(`${label} authentication failed: provider is not configured: ${model.provider}`);
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
function complianceDecisionFacts(response, toolName, calls) {
    return {
        expectedDecisionToolName: toolName,
        observedToolCallCount: calls.length,
        observedToolNames: calls.map((call) => call.name),
        responseStopReason: response.stopReason,
        errorMessageOrDiagnosticPresent: response.errorMessage !== undefined ||
            (response.diagnostics?.length ?? 0) > 0,
    };
}
function malformedComplianceDecision(response, toolName, invalidLabel, reason, calls) {
    return new Error(`${invalidLabel}: ${reason}; ${JSON.stringify(complianceDecisionFacts(response, toolName, calls))}`);
}
function hasOwn(value, key) {
    return Object.prototype.hasOwnProperty.call(value, key);
}
function isArrayOfStrings(value) {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}
function validateStatusDependentDecision(decision, response, toolName, invalidLabel, calls) {
    const reject = (reason) => {
        throw malformedComplianceDecision(response, toolName, invalidLabel, reason, calls);
    };
    switch (decision.status) {
        case "pass": {
            const violations = decision.violations;
            if (!hasOwn(decision, "violations") || !isArrayOfStrings(violations)) {
                reject("arguments do not match the pass decision contract");
            }
            const validViolations = violations ?? reject("arguments do not match the pass decision contract");
            if (validViolations.length !== 0 ||
                hasOwn(decision, "conflicts") ||
                hasOwn(decision, "decisionGate")) {
                reject("arguments do not match the pass decision contract");
            }
            return { status: "pass", violations: validViolations };
        }
        case "revise": {
            const violations = decision.violations;
            if (!hasOwn(decision, "violations") || !isArrayOfStrings(violations)) {
                reject("arguments do not match the revise decision contract");
            }
            const validViolations = violations ?? reject("arguments do not match the revise decision contract");
            if (validViolations.length === 0 ||
                hasOwn(decision, "conflicts") ||
                hasOwn(decision, "decisionGate")) {
                reject("arguments do not match the revise decision contract");
            }
            return { status: "revise", violations: validViolations };
        }
        case "escalate": {
            const conflicts = decision.conflicts;
            const decisionGate = decision.decisionGate;
            if (!hasOwn(decision, "conflicts") || !isArrayOfStrings(conflicts)) {
                reject("arguments do not match the escalate decision contract");
            }
            const validConflicts = conflicts ?? reject("arguments do not match the escalate decision contract");
            const validDecisionGate = decisionGate ?? reject("arguments do not match the escalate decision contract");
            if (validConflicts.length === 0 ||
                !hasOwn(decision, "decisionGate") ||
                hasOwn(decision, "violations")) {
                reject("arguments do not match the escalate decision contract");
            }
            return { status: "escalate", conflicts: validConflicts, decisionGate: validDecisionGate };
        }
    }
}
/**
 * Retain the provider's structured response verbatim in the active Pi session.
 * ExtensionContext exposes this manager as read-only, but the live manager still
 * owns the append operation used by the active session runtime.
 */
function retainComplianceResponse(context, response) {
    const sessionManager = context.sessionManager;
    if (typeof sessionManager?.appendMessage !== "function")
        return;
    sessionManager.appendMessage(response);
}
export function readComplianceDecision(response, toolName, invalidLabel) {
    const calls = response.content.filter((part) => part.type === "toolCall");
    const call = calls[0];
    if (calls.length !== 1 ||
        call?.type !== "toolCall" ||
        call.name !== toolName) {
        throw malformedComplianceDecision(response, toolName, invalidLabel, "expected exactly one decision tool call", calls);
    }
    const arguments_ = call.arguments;
    if (typeof arguments_ !== "object" ||
        arguments_ === null ||
        Array.isArray(arguments_)) {
        throw malformedComplianceDecision(response, toolName, invalidLabel, "arguments must be an object", calls);
    }
    if (!Value.Check(complianceDecisionSchema, arguments_)) {
        throw malformedComplianceDecision(response, toolName, invalidLabel, "arguments do not match the decision schema", calls);
    }
    const decision = validateStatusDependentDecision(arguments_, response, toolName, invalidLabel, calls);
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
export async function runComplianceAudit(options) {
    const model = options.context.model;
    if (model === undefined) {
        throw new Error(`${options.roleLabel} requires an active model`);
    }
    const dispatch = await prepareComplianceDispatch(model, options.context, options.roleLabel);
    const complete = options.runCompletion ??
        ((auditModel, context, request) => {
            const provider = options.context.modelRegistry.getProvider(auditModel.provider);
            if (provider === undefined) {
                throw new Error(`${options.roleLabel} provider not found: ${auditModel.provider}`);
            }
            return provider.stream(auditModel, context, request).result();
        });
    const onPayload = singleComplianceToolCallPayload(dispatch.model, options.tool.name);
    const response = await complete(dispatch.model, {
        systemPrompt: options.systemPrompt,
        messages: [
            {
                role: "user",
                content: [{ type: "text", text: options.serializedInput }],
                timestamp: Date.now(),
            },
        ],
        tools: [options.tool],
    }, {
        ...dispatch.auth,
        maxTokens: 2048,
        cacheRetention: "none",
        sessionId: uuidv7(),
        toolChoice: complianceToolChoice(dispatch.model, options.tool.name),
        ...(onPayload === undefined ? {} : { onPayload }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    retainComplianceResponse(options.context, response);
    return readComplianceDecision(response, options.tool.name, options.invalidDecisionLabel);
}
