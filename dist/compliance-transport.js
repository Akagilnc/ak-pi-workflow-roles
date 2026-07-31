import { StringEnum, uuidv7, } from "@earendil-works/pi-ai";
import { Type } from "typebox";
export function createComplianceDecisionTool(name, description) {
    return {
        name,
        description,
        parameters: Type.Object({
            status: StringEnum(["pass", "revise"]),
            violations: Type.Array(Type.String({ minLength: 1 })),
        }, { additionalProperties: false }),
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
    const decision = arguments_;
    const keys = Object.keys(decision);
    if (keys.length !== 2 ||
        !keys.includes("status") ||
        !keys.includes("violations")) {
        throw new Error(`${invalidLabel}: arguments must have exact keys`);
    }
    const status = decision["status"];
    const violations = decision["violations"];
    if (!Array.isArray(violations) ||
        !violations.every((value) => typeof value === "string" && value.trim().length > 0)) {
        throw new Error(`${invalidLabel}: violations must be non-blank strings`);
    }
    if (status === "pass" && violations.length === 0) {
        return { status: "pass", usage: response.usage };
    }
    if (status === "revise" && violations.length > 0) {
        return { status: "revise", violations, usage: response.usage };
    }
    throw new Error(`${invalidLabel}: pass requires no violations and revise requires violations`);
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
