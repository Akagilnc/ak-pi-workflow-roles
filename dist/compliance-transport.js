import { uuidv7, } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Value } from "typebox/value";
const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({
    question: nonblank,
    options: Type.Array(nonblank, { minItems: 1 }),
}, { additionalProperties: false });
/** The registered audit tool is the single field/status-leaf schema owner. */
export const complianceDecisionSchema = Type.Union([
    Type.Object({
        status: Type.Literal("pass"),
        // Preserve the established pass shape: an explicitly empty violations list.
        violations: Type.Array(nonblank, { maxItems: 0 }),
    }, { additionalProperties: false }),
    Type.Object({
        status: Type.Literal("revise"),
        violations: Type.Array(nonblank, { minItems: 1 }),
    }, { additionalProperties: false }),
    Type.Object({
        status: Type.Literal("escalate"),
        conflicts: Type.Array(nonblank, { minItems: 1 }),
        decisionGate: decisionGateSchema,
    }, { additionalProperties: false }),
]);
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
export function readComplianceDecision(response, toolName, invalidLabel) {
    const calls = response.content.filter((part) => part.type === "toolCall");
    const call = calls[0];
    if (calls.length !== 1 ||
        call?.type !== "toolCall" ||
        call.name !== toolName) {
        throw new Error(`${invalidLabel}: expected exactly one decision tool call`);
    }
    const arguments_ = call.arguments;
    if (typeof arguments_ !== "object" ||
        arguments_ === null ||
        Array.isArray(arguments_)) {
        throw new Error(`${invalidLabel}: arguments must be an object`);
    }
    if (!Value.Check(complianceDecisionSchema, arguments_)) {
        throw new Error(`${invalidLabel}: arguments do not match the decision schema`);
    }
    const decision = arguments_;
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
        ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    return readComplianceDecision(response, options.tool.name, options.invalidDecisionLabel);
}
