/**
 * #102 package-owned tool idle backstop.
 *
 * Fixed 183000ms silence clock on package-owned tool execute only.
 * Real producing onUpdate resets; final resolve/reject clears; timeout throws so
 * Pi settles the current call as an LLM-visible isError tool result. No retry,
 * role failure, process termination, config, or Pi built-in coverage.
 *
 * #339: do not name-exempt whole terminating tools. Outer idle stays armed for
 * pre/post-audit work. Only the real compliance-audit await suspends this single
 * layer (ADR 0059 owns that interval); resume re-arms the same outer backstop.
 *
 * #380: on idle, abort a derived tool signal (not the caller signal) so detour
 * spawn cleanup and softFail can run through the existing AbortSignal path.
 * Cooperative soft-settle may win; non-listeners still hard-reject after a
 * microtask drain (no second timer).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  createStreamIdleGuard,
  type StreamIdleGuard,
} from "./stream-idle-guard.ts";
import { isProducingToolUpdate } from "./tool-execution-observation.ts";

export const PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS = DEFAULT_STREAM_IDLE_TIMEOUT_MS;
export const PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE = "AK_PACKAGE_OWNED_TOOL_IDLE_TIMEOUT" as const;

const WRAPPED = Symbol.for("ak.packageOwnedToolIdleWrapped");

type PackageOwnedToolIdleSuspension = {
  suspend(): void;
  resume(): void;
};

/**
 * Active outer package-owned execute idle, if any. Nested tool executes install
 * their own store; compliance audit only suspends the store visible at await time.
 */
const packageOwnedToolIdleScope = new AsyncLocalStorage<PackageOwnedToolIdleSuspension>();

export class PackageOwnedToolIdleTimeoutError extends Error {
  readonly code = PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE;
  readonly idleTimeoutMs = PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS;

  constructor() {
    super(`package-owned tool idle timeout after ${PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS}ms`);
    this.name = "PackageOwnedToolIdleTimeoutError";
  }
}

export function isPackageOwnedToolIdleTimeoutError(
  value: unknown,
): value is PackageOwnedToolIdleTimeoutError {
  return (
    value instanceof PackageOwnedToolIdleTimeoutError ||
    (
      typeof value === "object" &&
      value !== null &&
      (value as { name?: unknown }).name === "PackageOwnedToolIdleTimeoutError" &&
      (value as { code?: unknown }).code === PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE
    )
  );
}

/** Minimal executable tool shape accepted by the shared idle wrapper. */
export type PackageOwnedToolLike = {
  readonly name: string;
  execute: (...args: never[]) => Promise<unknown>;
};

/**
 * Package-tool activity includes content production and host-only details
 * progress. Keep the observation-plane oracle separate: its stderr heartbeat
 * contract remains content-driven. Pi's known execute-entry placeholder
 * (`content: [], details: undefined`) is not activity.
 */
function isPackageOwnedToolActivityUpdate(partialResult: unknown): boolean {
  if (isProducingToolUpdate(partialResult)) return true;
  if (typeof partialResult !== "object" || partialResult === null) return false;
  const details = (partialResult as { details?: unknown }).details;
  if (details === undefined || details === null) return false;
  if (typeof details === "string") return details.length > 0;
  if (Array.isArray(details)) return details.length > 0;
  if (typeof details === "object") return Reflect.ownKeys(details).length > 0;
  return true;
}

/**
 * #339: suspend the active package-owned execute idle for one real compliance
 * audit await. Single-layer only — production has one runComplianceAudit seam.
 * No-op outside a wrapped package-owned execute. No second timeout or retry.
 */
export async function withPackageOwnedToolIdleSuspended<T>(
  run: () => Promise<T>,
): Promise<T> {
  const scope = packageOwnedToolIdleScope.getStore();
  if (scope === undefined) return run();
  scope.suspend();
  try {
    return await run();
  } finally {
    scope.resume();
  }
}

/**
 * Single shared execute wrapper for package-owned tool definitions.
 * Idempotent: wrapping twice returns the same protected definition.
 */
export function wrapPackageOwnedToolDefinition<T extends PackageOwnedToolLike>(tool: T): T {
  // Mark the execute function, not the tool object — callers may spread tool fields
  // onto a new definition with a different execute (e.g. auditor customTools).
  if ((tool.execute as { [WRAPPED]?: boolean })[WRAPPED] === true) return tool;

  const originalExecute = tool.execute.bind(tool) as (
    ...args: unknown[]
  ) => Promise<unknown>;

  const wrappedExecute = function packageOwnedToolIdleExecute(
    ...args: unknown[]
  ): Promise<unknown> {
    const parentSignal = args[2] as AbortSignal | undefined;
    const onUpdate = args[3] as ((partialResult: unknown) => void) | undefined;
    return new Promise((resolve, reject) => {
      let settled = false;
      let suspended = false;
      let idle: StreamIdleGuard = createStreamIdleGuard({
        idleTimeoutMs: PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS,
      });

      // Derived tool signal: caller cancel forwards; idle aborts this only (not parent).
      const toolController = new AbortController();
      const onParentAbort = (): void => {
        if (toolController.signal.aborted) return;
        toolController.abort(parentSignal?.reason);
      };
      if (parentSignal !== undefined) {
        if (parentSignal.aborted) {
          toolController.abort(parentSignal.reason);
        } else {
          parentSignal.addEventListener("abort", onParentAbort);
        }
      }

      const cleanup = (): void => {
        idle.signal.removeEventListener("abort", onIdle);
        idle.dispose();
        parentSignal?.removeEventListener("abort", onParentAbort);
      };

      const settle = (deliver: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        deliver();
      };
      const onIdle = (): void => {
        const idleError = new PackageOwnedToolIdleTimeoutError();
        if (!toolController.signal.aborted) {
          toolController.abort(idleError);
        }
        // Cooperative tools (detour) soft-settle via the aborted signal in the
        // next microtasks. Non-listeners still hard-reject after a short drain
        // of those microtasks — no second wall-clock timer.
        void Promise.resolve()
          .then(() => {})
          .then(() => {})
          .then(() => {
            settle(() => reject(idleError));
          });
      };
      idle.signal.addEventListener("abort", onIdle, { once: true });

      const suspension: PackageOwnedToolIdleSuspension = {
        suspend(): void {
          if (settled || suspended) return;
          suspended = true;
          // ADR 0059 owns the audit interval — drop this layer until audit returns.
          idle.signal.removeEventListener("abort", onIdle);
          idle.dispose();
        },
        resume(): void {
          if (settled || !suspended) return;
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
        : (partialResult: unknown) => {
            if (settled) return;
            if (isPackageOwnedToolActivityUpdate(partialResult)) idle.poke();
            onUpdate(partialResult);
          };

      const callArgs = args.slice();
      // Pass derived signal so idle/cancel can clean up subprocesses without
      // aborting the caller/parent agent signal identity.
      callArgs[2] = toolController.signal;
      callArgs[3] = guardedOnUpdate;

      void packageOwnedToolIdleScope.run(suspension, async () => {
        try {
          const result = await originalExecute(...callArgs);
          settle(() => resolve(result));
        } catch (error) {
          settle(() => reject(error));
        }
      });
    });
  };
  (wrappedExecute as { [WRAPPED]?: boolean })[WRAPPED] = true;

  return {
    ...tool,
    execute: wrappedExecute as T["execute"],
  };
}

/**
 * Install the shared registration surface on an ExtensionAPI once.
 * All subsequent pi.registerTool calls for package-owned tools are wrapped.
 */
export function installPackageOwnedToolRegistration(pi: ExtensionAPI): void {
  const current = pi.registerTool;
  if ((current as { [WRAPPED]?: boolean })[WRAPPED] === true) return;

  const original = current.bind(pi);
  const installed = ((tool: ToolDefinition<any, any, any>) => {
    original(wrapPackageOwnedToolDefinition(tool) as ToolDefinition<any, any, any>);
  }) as typeof pi.registerTool;
  (installed as { [WRAPPED]?: boolean })[WRAPPED] = true;
  pi.registerTool = installed;
}
