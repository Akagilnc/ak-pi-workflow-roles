/**
 * #102 package-owned tool idle backstop.
 *
 * Fixed 183000ms silence clock on package-owned tool execute only.
 * Real producing onUpdate resets; final resolve/reject clears; timeout throws so
 * Pi settles the current call as an LLM-visible isError tool result. No retry,
 * role failure, process termination, signal abort, config, or Pi built-in coverage.
 *
 * #339: do not name-exempt whole terminating tools. Outer idle stays armed for
 * pre/post-audit work. Only the real compliance-audit await suspends this single
 * layer (ADR 0059 owns that interval); resume re-arms the same outer backstop.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_STREAM_IDLE_TIMEOUT_MS, createStreamIdleGuard, } from "./stream-idle-guard.js";
import { isProducingToolUpdate } from "./tool-execution-observation.js";
export const PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS = DEFAULT_STREAM_IDLE_TIMEOUT_MS;
export const PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE = "AK_PACKAGE_OWNED_TOOL_IDLE_TIMEOUT";
const WRAPPED = Symbol.for("ak.packageOwnedToolIdleWrapped");
/**
 * Active outer package-owned execute idle, if any. Nested tool executes install
 * their own store; compliance audit only suspends the store visible at await time.
 */
const packageOwnedToolIdleScope = new AsyncLocalStorage();
export class PackageOwnedToolIdleTimeoutError extends Error {
    code = PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE;
    idleTimeoutMs = PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS;
    constructor() {
        super(`package-owned tool idle timeout after ${PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS}ms`);
        this.name = "PackageOwnedToolIdleTimeoutError";
    }
}
/**
 * Package-tool activity includes content production and host-only details
 * progress. Keep the observation-plane oracle separate: its stderr heartbeat
 * contract remains content-driven. Pi's known execute-entry placeholder
 * (`content: [], details: undefined`) is not activity.
 */
function isPackageOwnedToolActivityUpdate(partialResult) {
    if (isProducingToolUpdate(partialResult))
        return true;
    if (typeof partialResult !== "object" || partialResult === null)
        return false;
    const details = partialResult.details;
    if (details === undefined || details === null)
        return false;
    if (typeof details === "string")
        return details.length > 0;
    if (Array.isArray(details))
        return details.length > 0;
    if (typeof details === "object")
        return Reflect.ownKeys(details).length > 0;
    return true;
}
/**
 * #339: suspend the active package-owned execute idle for one real compliance
 * audit await. Single-layer only — production has one runComplianceAudit seam.
 * No-op outside a wrapped package-owned execute. No second timeout or retry.
 */
export async function withPackageOwnedToolIdleSuspended(run) {
    const scope = packageOwnedToolIdleScope.getStore();
    if (scope === undefined)
        return run();
    scope.suspend();
    try {
        return await run();
    }
    finally {
        scope.resume();
    }
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
            let suspended = false;
            let idle = createStreamIdleGuard({
                idleTimeoutMs: PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS,
            });
            const settle = (deliver) => {
                if (settled)
                    return;
                settled = true;
                idle.signal.removeEventListener("abort", onIdle);
                idle.dispose();
                deliver();
            };
            const onIdle = () => {
                settle(() => reject(new PackageOwnedToolIdleTimeoutError()));
            };
            idle.signal.addEventListener("abort", onIdle, { once: true });
            const suspension = {
                suspend() {
                    if (settled || suspended)
                        return;
                    suspended = true;
                    // ADR 0059 owns the audit interval — drop this layer until audit returns.
                    idle.signal.removeEventListener("abort", onIdle);
                    idle.dispose();
                },
                resume() {
                    if (settled || !suspended)
                        return;
                    suspended = false;
                    // Fresh single-layer silence window for post-audit work (e.g. cleanup).
                    idle = createStreamIdleGuard({
                        idleTimeoutMs: PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS,
                    });
                    idle.signal.addEventListener("abort", onIdle, { once: true });
                },
            };
            const guardedOnUpdate = onUpdate === undefined
                ? undefined
                : (partialResult) => {
                    if (settled)
                        return;
                    if (isPackageOwnedToolActivityUpdate(partialResult))
                        idle.poke();
                    onUpdate(partialResult);
                };
            const callArgs = args.slice();
            // Preserve the original signal at args[2]; timeout must not abort it.
            callArgs[2] = signal;
            callArgs[3] = guardedOnUpdate;
            void packageOwnedToolIdleScope.run(suspension, async () => {
                try {
                    const result = await originalExecute(...callArgs);
                    settle(() => resolve(result));
                }
                catch (error) {
                    settle(() => reject(error));
                }
            });
        });
    };
    wrappedExecute[WRAPPED] = true;
    return {
        ...tool,
        execute: wrappedExecute,
    };
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
