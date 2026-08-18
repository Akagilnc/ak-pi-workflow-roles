import { Type } from "typebox";
import { ENGINE_DETOUR_ALREADY_USED_DIAGNOSTIC, ENGINE_DETOUR_TOOL_NAME, engineDetourFailureDiagnostic, engineNameFromEnv, isEngineDetourFailure, runEngineDetourOnce, } from "./engine-detour.js";
import { activationEngineLaborFallbackLatch, recordEngineLaborFallback, } from "./engine-labor-fallback.js";
import { isPackageOwnedToolIdleTimeoutError, pokePackageOwnedToolIdle, wrapPackageOwnedToolDefinition, } from "./package-owned-tool-idle.js";
const engineDetourArgsSchema = Type.Object({
    argv: Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        description: "Executable argv for one engine subprocess. First element is the command (PATH lookup); remaining elements are arguments. Build argv from the host CLI actual interface for the configured engine name; when optional packaged notes are present in the session prompt, follow those bytes. Do not invent package flags.",
    }),
}, { additionalProperties: false });
function seatFallbackToolResult(field, failure) {
    return {
        content: [
            {
                type: "text",
                text: `Engine detour failed: ${failure}. Perform the labor in this session (seat main road) and submit via the existing typed path. A mechanical fallback declaration will attach to the typed receipt.`,
            },
        ],
        details: {
            tool: ENGINE_DETOUR_TOOL_NAME,
            detourFailed: true,
            ...field,
        },
    };
}
/** Caller/upper-layer cancel must propagate; idle backstop is seat-fallback, not cancel. */
function isCallerCancellation(error, signal) {
    if (isPackageOwnedToolIdleTimeoutError(error))
        return false;
    if (signal !== undefined &&
        isPackageOwnedToolIdleTimeoutError(signal.reason)) {
        return false;
    }
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
 * Engine process failure (nonzero/empty/spawn/idle-timeout) soft-returns seat fallback (#380).
 * Caller AbortSignal cancel propagates without writing fallback.
 */
export function createEngineDetourToolDefinition(input) {
    const latch = input.latch ?? { used: false };
    const engineName = input.engineName;
    return wrapPackageOwnedToolDefinition({
        name: ENGINE_DETOUR_TOOL_NAME,
        label: "Engine Detour",
        description: `Run one labor-engine subprocess (engine=${engineName}) and return its stdout to this session. Call at most once per activation. Build argv from the host CLI actual interface for this engine name; when optional packaged notes are present in the session prompt, follow those bytes too.`,
        promptSnippet: "Run the configured labor engine once and return its stdout",
        promptGuidelines: [
            `Use ${ENGINE_DETOUR_TOOL_NAME} exactly once for the configured engine (${engineName}). Optional packaged notes are guidance when present; a bare engine name alone is also a valid call path.`,
            "Pass argv for the host CLI of this engine name — first element is the executable name on PATH. Follow optional packaged notes when delivered; otherwise act from the engine name and the host CLI actual interface. Do not invent package flags.",
            "On success, use the returned stdout as labor content for the existing typed submission / report path.",
            "On engine failure the tool returns a soft failure: continue labor in this session and submit via the existing typed path. Do not treat engine failure as a reason to withhold the typed receipt.",
        ],
        parameters: engineDetourArgsSchema,
        async execute(toolCallId, params, signal, _onUpdate, ctx) {
            if (latch.used) {
                input.fail(new Error(ENGINE_DETOUR_ALREADY_USED_DIAGNOSTIC), toolCallId, ctx);
            }
            latch.used = true;
            const args = params;
            const argv = Array.isArray(args.argv) ? args.argv : [];
            if (argv.length === 0 || argv.some((part) => typeof part !== "string" || part.length === 0)) {
                input.fail(new Error("engine detour argv must be a non-empty string array"), toolCallId, ctx);
            }
            const softFail = (failure) => {
                // Activation-scoped latch is the sole shared recorder (parent seat + legs).
                const fallbackLatch = activationEngineLaborFallbackLatch() ?? { field: undefined };
                const field = recordEngineLaborFallback(fallbackLatch, {
                    engine: engineName,
                    failure,
                });
                return seatFallbackToolResult(field, failure);
            };
            let result;
            try {
                // Byte activity on stdout/stderr touches the outer package-owned idle clock
                // (183s silence law unchanged). True hangs still die; slow streaming engines live.
                result = await runEngineDetourOnce({
                    argv,
                    cwd: ctx.cwd,
                    ...(signal === undefined ? {} : { signal }),
                    onOutputActivity: pokePackageOwnedToolIdle,
                });
            }
            catch (error) {
                // Caller cancel: propagate. Idle backstop + spawn/engine failure: seat fallback.
                if (isCallerCancellation(error, signal)) {
                    throw error;
                }
                const failure = error instanceof Error ? error.message : String(error);
                return softFail(failure.trim() === "" ? "engine detour spawn failed" : failure);
            }
            if (isEngineDetourFailure(result)) {
                return softFail(engineDetourFailureDiagnostic(result));
            }
            return {
                content: [{ type: "text", text: result.stdout }],
                details: {
                    tool: ENGINE_DETOUR_TOOL_NAME,
                    code: result.code,
                },
            };
        },
    });
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
