/**
 * #102 package-owned tool idle backstop.
 *
 * Fixed 183000ms silence clock on package-owned tool execute only.
 * Real producing onUpdate resets; final resolve/reject clears; timeout throws so
 * Pi settles the current call as an LLM-visible isError tool result. No retry,
 * role failure, process termination, signal abort, config, or Pi built-in coverage.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { isProducingToolUpdate } from "./tool-execution-observation.ts";

export const PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS = 183_000;
export const PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE = "AK_PACKAGE_OWNED_TOOL_IDLE_TIMEOUT" as const;

const WRAPPED = Symbol.for("ak.packageOwnedToolIdleWrapped");

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
  return value instanceof PackageOwnedToolIdleTimeoutError
    || (
      typeof value === "object"
      && value !== null
      && (value as { name?: unknown }).name === "PackageOwnedToolIdleTimeoutError"
      && (value as { code?: unknown }).code === PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE
    );
}

/** Minimal executable tool shape accepted by the shared idle wrapper. */
export type PackageOwnedToolLike = {
  readonly name: string;
  execute: (...args: never[]) => Promise<unknown>;
};

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
    const signal = args[2] as AbortSignal | undefined;
    const onUpdate = args[3] as ((partialResult: unknown) => void) | undefined;
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const clear = (): void => {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
      };

      const settle = (deliver: () => void): void => {
        if (settled) return;
        settled = true;
        clear();
        deliver();
      };

      const arm = (): void => {
        if (settled) return;
        clear();
        timer = setTimeout(() => {
          timer = undefined;
          settle(() => reject(new PackageOwnedToolIdleTimeoutError()));
        }, PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS);
      };

      const guardedOnUpdate = onUpdate === undefined
        ? undefined
        : (partialResult: unknown) => {
            if (settled) return;
            if (isProducingToolUpdate(partialResult)) arm();
            onUpdate(partialResult);
          };

      arm();

      const callArgs = args.slice();
      // Preserve the original signal at args[2]; timeout must not abort it.
      callArgs[2] = signal;
      callArgs[3] = guardedOnUpdate;

      void Promise.resolve()
        .then(() => originalExecute(...callArgs))
        .then(
          (result) => settle(() => resolve(result)),
          (error: unknown) => settle(() => reject(error)),
        );
    });
  };
  (wrappedExecute as { [WRAPPED]?: boolean })[WRAPPED] = true;

  return {
    ...tool,
    execute: wrappedExecute as T["execute"],
  };
}

/** Register one package-owned tool definition through the shared idle wrapper. */
export function registerPackageOwnedTool(
  pi: Pick<ExtensionAPI, "registerTool">,
  tool: ToolDefinition<any, any, any>,
): void {
  pi.registerTool(wrapPackageOwnedToolDefinition(tool) as ToolDefinition<any, any, any>);
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
