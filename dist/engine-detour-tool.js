/**
 * Package-owned engine detour tool (#357 T2 / #378 / #380).
 * Registered by shared role-runtime when any role + engine activation signal is present.
 * Evidence-child legs install the same definition via customTools (no spawn in role modules).
 * Engine process failures stop through the host infrastructure-failure seam.
 * Caller AbortSignal cancellation propagates unchanged.
 */
import { Type } from "typebox";
import { ENGINE_DETOUR_ALREADY_USED_DIAGNOSTIC, ENGINE_DETOUR_TOOL_NAME, engineDetourFailureDiagnostic, engineNameFromEnv, isEngineDetourFailure, runEngineDetourOnce, } from "./engine-detour.js";
const engineDetourArgsSchema = Type.Object({
    argv: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "首项为 PATH 中的可执行文件，其余项为参数。",
    }),
}, { additionalProperties: false });
/** Caller/upper-layer cancellation must propagate unchanged. */
function isCallerCancellation(error, signal) {
    if (signal?.aborted === true)
        return true;
    if (typeof error === "object" &&
        error !== null &&
        error.name === "AbortError") {
        return true;
    }
    return false;
}
/**
 * Build one once-latch detour tool definition for a configured engine name.
 * `latch` is shared so parent registration can reset between activations.
 * `fail` owns host abort (parent) vs throw (evidence child) for tool misuse only.
 * Engine process failures (nonzero/empty/spawn) stop via `fail` with their cause.
 * Caller AbortSignal cancellation propagates unchanged.
 */
export function createEngineDetourToolDefinition(input) {
    const latch = input.latch ?? { used: false };
    const engineName = input.engineName;
    return {
        name: ENGINE_DETOUR_TOOL_NAME,
        label: "劳务引擎",
        description: `运行一次劳务引擎子进程（engine=${engineName}），stdout 返回本 session；每次激活至多一次。`,
        promptSnippet: "运行配置的劳务引擎一次并返回 stdout",
        parameters: engineDetourArgsSchema,
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
            if (latch.used) {
                input.fail(new Error(ENGINE_DETOUR_ALREADY_USED_DIAGNOSTIC), toolCallId, ctx);
            }
            latch.used = true;
            const args = params;
            const argv = Array.isArray(args.argv) ? args.argv : [];
            if (argv.length === 0 || argv.some((part) => typeof part !== "string" || part.length === 0)) {
                input.fail(new Error("劳务引擎 argv 须为非空字符串数组"), toolCallId, ctx);
            }
            let result;
            try {
                result = await runEngineDetourOnce({
                    argv,
                    cwd: ctx.cwd,
                    ...(signal === undefined ? {} : { signal }),
                });
            }
            catch (error) {
                if (isCallerCancellation(error, signal))
                    throw error;
                const cause = error instanceof Error
                    ? error
                    : new Error(String(error).trim() || "劳务引擎 spawn 失败");
                input.fail(cause, toolCallId, ctx);
            }
            if (isEngineDetourFailure(result)) {
                input.fail(new Error(engineDetourFailureDiagnostic(result)), toolCallId, ctx);
            }
            return {
                content: [{ type: "text", text: result.stdout }],
                details: {
                    tool: ENGINE_DETOUR_TOOL_NAME,
                    code: result.code,
                },
            };
        },
    };
}
/**
 * Register the engine-generic detour tool once for this process when any role has
 * an engine activation signal. Returns whether registration occurred.
 * Once-latch is activation-scoped via the returned reset handle.
 */
export function registerEngineDetourTool(pi, hostActions) {
    const engineName = engineNameFromEnv();
    if (engineName === undefined) {
        return {
            registered: false,
            resetLatch() {
                /* no-op when unregistered */
            },
        };
    }
    const latch = { used: false };
    const definition = createEngineDetourToolDefinition({
        engineName,
        latch,
        fail(error, toolCallId, ctx) {
            hostActions.failInfrastructure(error, ctx, toolCallId);
        },
    });
    pi.registerTool(definition);
    return {
        registered: true,
        resetLatch() {
            latch.used = false;
        },
    };
}
