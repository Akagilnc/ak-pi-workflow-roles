import { Type } from "typebox";
import { ENGINE_DETOUR_TOOL_NAME, engineDetourFailureDiagnostic, engineNameFromEnv, isEngineDetourFailure, runEngineDetourOnce, } from "./engine-detour.js";
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
 * Build one detour tool definition for a configured engine name.
 * `fail` owns host abort (parent) vs throw (evidence child) for tool misuse only.
 * Engine process failures (nonzero/empty/spawn) stop via `fail` with their cause.
 * Caller AbortSignal cancellation propagates unchanged.
 */
export function createEngineDetourToolDefinition(input) {
    const engineName = input.engineName;
    return {
        name: ENGINE_DETOUR_TOOL_NAME,
        label: "劳务引擎",
        description: `运行一次劳务引擎子进程（engine=${engineName}），stdout 返回本 session。`,
        promptSnippet: "运行配置的劳务引擎一次并返回 stdout",
        parameters: engineDetourArgsSchema,
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
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
                    stderr: result.stderr,
                },
            };
        },
    };
}
/**
 * Register the engine-generic detour tool once for this process when any role has
 * an engine activation signal. Returns whether registration occurred.
 */
export function registerEngineDetourTool(pi, hostActions) {
    const engineName = engineNameFromEnv();
    if (engineName === undefined) {
        return false;
    }
    const definition = createEngineDetourToolDefinition({
        engineName,
        fail(error, toolCallId, ctx) {
            hostActions.failInfrastructure(error, ctx, toolCallId);
        },
    });
    pi.registerTool(definition);
    return true;
}
