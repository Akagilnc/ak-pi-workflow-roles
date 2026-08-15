/**
 * #102 package-owned tool idle backstop.
 *
 * Fixed 183000ms silence clock on package-owned tool execute only.
 * Real producing onUpdate resets; final resolve/reject clears; timeout throws so
 * Pi settles the current call as an LLM-visible isError tool result. No retry,
 * role failure, process termination, signal abort, config, or Pi built-in coverage.
 */
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { DOCTOR_OUTPUT_TOOL_NAME } from "./doctor-contracts.ts";
import { JUDGE_OUTPUT_TOOL_NAME } from "./package-contracts/judge-output.ts";
import { REVIEWER_OUTPUT_TOOL_NAME } from "./package-contracts/reviewer-output.ts";
import {
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  createStreamIdleGuard,
} from "./stream-idle-guard.ts";
import { isProducingToolUpdate } from "./tool-execution-observation.ts";

export const PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS = DEFAULT_STREAM_IDLE_TIMEOUT_MS;
export const PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE = "AK_PACKAGE_OWNED_TOOL_IDLE_TIMEOUT" as const;

/**
 * #339 scan: package-owned terminating submission tools whose execute already
 * owns ADR 0059 compliance stream-idle (runComplianceAudit → executeAuditorChild
 * idleRetry). Outer 183s package-owned idle must not stack on these leaves.
 *
 * Inventory (terminating submission tools only):
 * - ak_judge_output / ak_reviewer_output / ak_doctor_output → yes (compliance child)
 * - ak_coder_output / ak_fixer_output / ak_collector_output / ak_merger_output → no
 */
export const PACKAGE_OWNED_TOOLS_WITH_COMPLIANCE_STREAM_IDLE_OWNER = Object.freeze([
  JUDGE_OUTPUT_TOOL_NAME,
  REVIEWER_OUTPUT_TOOL_NAME,
  DOCTOR_OUTPUT_TOOL_NAME,
] as const);

export function hasComplianceStreamIdleOwner(toolName: string): boolean {
  return (PACKAGE_OWNED_TOOLS_WITH_COMPLIANCE_STREAM_IDLE_OWNER as readonly string[])
    .includes(toolName);
}

const WRAPPED = Symbol.for("ak.packageOwnedToolIdleWrapped");

export class PackageOwnedToolIdleTimeoutError extends Error {
  readonly code = PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_CODE;
  readonly idleTimeoutMs = PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS;

  constructor() {
    super(`package-owned tool idle timeout after ${PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS}ms`);
    this.name = "PackageOwnedToolIdleTimeoutError";
  }
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
 * Single shared execute wrapper for package-owned tool definitions.
 * Idempotent: wrapping twice returns the same protected definition.
 */
export function wrapPackageOwnedToolDefinition<T extends PackageOwnedToolLike>(tool: T): T {
  // Mark the execute function, not the tool object — callers may spread tool fields
  // onto a new definition with a different execute (e.g. auditor customTools).
  if ((tool.execute as { [WRAPPED]?: boolean })[WRAPPED] === true) return tool;
  // #339: inner StreamIdleTimeoutError finite retry + exhaustion is the sole idle
  // owner for audit-type terminating submissions. Do not stack the outer 183s gate.
  if (hasComplianceStreamIdleOwner(tool.name)) return tool;

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
      const idle = createStreamIdleGuard({
        idleTimeoutMs: PACKAGE_OWNED_TOOL_IDLE_TIMEOUT_MS,
      });

      const settle = (deliver: () => void): void => {
        if (settled) return;
        settled = true;
        idle.signal.removeEventListener("abort", onIdle);
        idle.dispose();
        deliver();
      };
      const onIdle = (): void => {
        settle(() => reject(new PackageOwnedToolIdleTimeoutError()));
      };
      idle.signal.addEventListener("abort", onIdle, { once: true });

      const guardedOnUpdate = onUpdate === undefined
        ? undefined
        : (partialResult: unknown) => {
            if (settled) return;
            if (isPackageOwnedToolActivityUpdate(partialResult)) idle.poke();
            onUpdate(partialResult);
          };

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
