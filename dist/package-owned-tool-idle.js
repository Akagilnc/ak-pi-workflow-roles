import { isProducingToolUpdate } from "./tool-execution-observation.js";
export const PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS = 183_000;
export const PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE = "AK_PACKAGE_OWNED_TOOL_IDLE_TIMEOUT";
const WRAPPED = Symbol.for("ak.packageOwnedToolIdleWrapped");
export class PackageOwnedToolIdleTimeoutError extends Error {
    code = PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE;
    idleTimeoutMs = PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS;
    constructor() {
        super(`package-owned tool idle timeout after ${PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS}ms`);
        this.name = "PackageOwnedToolIdleTimeoutError";
    }
}
export function isPackageOwnedToolIdleTimeoutError(value) {
    return value instanceof PackageOwnedToolIdleTimeoutError
        || (typeof value === "object"
            && value !== null
            && value.name === "PackageOwnedToolIdleTimeoutError"
            && value.code === PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE);
}
/**
 * Single shared execute wrapper for package-owned tool definitions.
 * Idempotent: wrapping twice returns the same protected definition.
 */
export function wrapPackageOwnedToolDefinition(tool) {
    // Mark the execute function, not the tool object — callers may spread tool fields
    // onto a new definition with a different execute (e.g. auditor customTools).
    if (tool.execute[WRAPPED] === true)
        return tool;
    const originalExecute = tool.execute.bind(tool);
    const wrappedExecute = function packageOwnedToolIdleExecute(...args) {
        const signal = args[2];
        const onUpdate = args[3];
        return new Promise((resolve, reject) => {
            let settled = false;
            let timer;
            const clear = () => {
                if (timer !== undefined) {
                    clearTimeout(timer);
                    timer = undefined;
                }
            };
            const settle = (deliver) => {
                if (settled)
                    return;
                settled = true;
                clear();
                deliver();
            };
            const arm = () => {
                if (settled)
                    return;
                clear();
                timer = setTimeout(() => {
                    timer = undefined;
                    settle(() => reject(new PackageOwnedToolIdleTimeoutError()));
                }, PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
            };
            const guardedOnUpdate = onUpdate === undefined
                ? undefined
                : (partialResult) => {
                    if (settled)
                        return;
                    if (isProducingToolUpdate(partialResult))
                        arm();
                    onUpdate(partialResult);
                };
            arm();
            const callArgs = args.slice();
            // Preserve the original signal at args[2]; timeout must not abort it.
            callArgs[2] = signal;
            callArgs[3] = guardedOnUpdate;
            void Promise.resolve()
                .then(() => originalExecute(...callArgs))
                .then((result) => settle(() => resolve(result)), (error) => settle(() => reject(error)));
        });
    };
    wrappedExecute[WRAPPED] = true;
    return {
        ...tool,
        execute: wrappedExecute,
    };
}
/** Register one package-owned tool definition through the shared idle wrapper. */
export function registerPackageOwnedTool(pi, tool) {
    pi.registerTool(wrapPackageOwnedToolDefinition(tool));
}
/**
 * Install the shared registration surface on an ExtensionAPI once.
 * All subsequent pi.registerTool calls for package-owned tools are wrapped.
 */
export function installPackageOwnedToolRegistration(pi) {
    const current = pi.registerTool;
    if (current[WRAPPED] === true)
        return;
    const original = current.bind(pi);
    const installed = ((tool) => {
        original(wrapPackageOwnedToolDefinition(tool));
    });
    installed[WRAPPED] = true;
    pi.registerTool = installed;
}
