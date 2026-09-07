/**
 * Reviewer Standards/Spec axis sub-session (#744).
 * Pi host: identity-less in-process child (pre-#675 evidence-child-executor shape).
 * Materials: quality-law + optional engine notes only — no seat, soul, public entry, or output tool.
 * Other hosts' subagent capability is out of this ticket (principle frozen).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";

import type { HostAssistantTurnResult, HostContext, RoleTurnModelConfig } from "./host-contracts.ts";
import { createEngineDetourToolDefinition } from "./engine-detour-tool.ts";
import { engineNameFromEnv } from "./engine-detour.ts";
import {
  appendEngineSessionMaterial,
  engineSessionMaterialFromOptions,
  type EngineSessionMaterial,
} from "./package-resources/engine-material.ts";
import { readPackageMaterial } from "./session-opening-materials.ts";
import type { AcceptedReviewerLeg } from "./reviewer-dispatch.ts";
import type { ReviewerPromptText } from "./reviewer-prompt-identity.ts";
import {
  hasUpstreamErrorTestimony,
  isNonSuccessHttpStatus,
  projectConfirmedRemotePayload,
} from "./upstream-error-testimony.ts";

/** Path roster only — cadence prose stays in owner material (ADR 0073). */
const AXIS_SUBSESSION_MATERIALS = ["souls/quality-law.md"] as const;

async function buildAxisSystemPrompt(engineMaterial?: EngineSessionMaterial): Promise<string> {
  const materials: string[] = [];
  for (const relativePath of AXIS_SUBSESSION_MATERIALS) {
    materials.push(await readPackageMaterial(relativePath));
  }
  return appendEngineSessionMaterial(materials, engineMaterial).join("\n");
}

type AxisFailureClassification = "provider" | "child" | "unknown";
type ClassifiedAxisError = Error & Readonly<{
  evidenceChildFailure: AxisFailureClassification;
  evidenceChildOriginal?: unknown;
}>;

function numericHttpStatus(value: unknown): number | undefined {
  return isNonSuccessHttpStatus(value) ? value : undefined;
}

type StructuredRemoteProjection = {
  readonly hasTestimony: boolean;
  readonly httpStatus?: number;
  readonly diagnostics?: unknown;
  readonly body?: unknown;
  readonly code?: unknown;
  readonly errno?: unknown;
};

function projectStructuredRemote(error: unknown): StructuredRemoteProjection {
  let httpStatus: number | undefined;
  let diagnostics: unknown;
  let body: unknown;
  let code: unknown;
  let errno: unknown;
  let cursor: unknown = error;
  const seen = new Set<unknown>();
  while (typeof cursor === "object" && cursor !== null && !seen.has(cursor)) {
    seen.add(cursor);
    const record = cursor as Record<string, unknown>;
    const nodeStatus = numericHttpStatus(record.statusCode)
      ?? numericHttpStatus(record.status)
      ?? numericHttpStatus(record.httpStatus);
    const nodeDiagnostics = Array.isArray(record.diagnostics) && record.diagnostics.length > 0
      ? record.diagnostics
      : undefined;
    const nodeHasTestimony = hasUpstreamErrorTestimony({
      ...(nodeStatus === undefined ? {} : { httpStatus: nodeStatus }),
      ...(nodeDiagnostics === undefined ? {} : { diagnostics: nodeDiagnostics }),
    });
    if (httpStatus === undefined && nodeStatus !== undefined) httpStatus = nodeStatus;
    if (diagnostics === undefined && nodeDiagnostics !== undefined) diagnostics = nodeDiagnostics;
    if (nodeHasTestimony) {
      const payload = projectConfirmedRemotePayload(record);
      if (body === undefined && payload.body !== undefined) body = payload.body;
      if (code === undefined && payload.code !== undefined) code = payload.code;
      if (errno === undefined && payload.errno !== undefined) errno = payload.errno;
    }
    cursor = record.cause;
  }
  return {
    hasTestimony: hasUpstreamErrorTestimony({
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(diagnostics === undefined ? {} : { diagnostics }),
    }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
    ...(body === undefined ? {} : { body }),
    ...(code === undefined ? {} : { code }),
    ...(errno === undefined ? {} : { errno }),
  };
}

function classifiedError(error: unknown, evidenceChildFailure: AxisFailureClassification): ClassifiedAxisError {
  const diagnostic = typeof error === "object" && error !== null && typeof (error as { errorMessage?: unknown }).errorMessage === "string"
    ? (error as { errorMessage: string }).errorMessage
    : error === undefined ? "" : String(error);
  const wrapped = error instanceof Error
    ? error
    : Object.assign(new Error(diagnostic, { cause: error }), { evidenceChildOriginal: error });
  const classification = "evidenceChildFailure" in wrapped
    ? (wrapped as ClassifiedAxisError).evidenceChildFailure
    : evidenceChildFailure === "provider" && !projectStructuredRemote(error).hasTestimony
      ? "unknown"
      : evidenceChildFailure;
  return Object.assign(wrapped, { evidenceChildFailure: classification });
}

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function addUsage(total: Usage, next: Usage): void {
  total.input += next.input;
  total.output += next.output;
  total.cacheRead += next.cacheRead;
  total.cacheWrite += next.cacheWrite;
  total.totalTokens += next.totalTokens;
  total.cost.input += next.cost.input;
  total.cost.output += next.cost.output;
  total.cost.cacheRead += next.cost.cacheRead;
  total.cost.cacheWrite += next.cost.cacheWrite;
  total.cost.total += next.cost.total;
}

async function withScratch<T>(
  options: { readonly prefix: string; readonly parentDirectory?: string },
  run: (scratch: string) => Promise<T>,
): Promise<T> {
  const scratch = await mkdtemp(join(options.parentDirectory ?? tmpdir(), options.prefix));
  let failure: unknown;
  try {
    return await run(scratch);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    try {
      await rm(scratch, { recursive: true, force: true });
    } catch (cleanupFailure) {
      if (failure !== undefined) {
        throw new AggregateError([failure, cleanupFailure], "in-process child scratch cleanup failed", { cause: failure });
      }
      throw cleanupFailure;
    }
  }
}

async function runChildCleanup(
  cleanups: ReadonlyArray<() => void | Promise<void>>,
  primaryFailure: unknown,
  label: string,
): Promise<void> {
  let cleanupFailure: unknown;
  for (const cleanup of cleanups) {
    try {
      await cleanup();
    } catch (failure) {
      cleanupFailure = cleanupFailure === undefined
        ? failure
        : new AggregateError([cleanupFailure, failure], `${label} cleanup failed`, {
          cause: cleanupFailure,
        });
    }
  }
  if (cleanupFailure === undefined) return;
  if (primaryFailure !== undefined) {
    throw new AggregateError(
      [primaryFailure, cleanupFailure],
      `${label} execution and cleanup failed`,
      { cause: primaryFailure },
    );
  }
  throw new AggregateError([cleanupFailure], `${label} cleanup failed`, {
    cause: cleanupFailure,
  });
}

/** Parent seat model for the axis sub-session (pre-#675 parent-effective inheritance). Pi only. */
async function parentSelectionAsync(context: HostContext): Promise<RoleTurnModelConfig> {
  const { toPiContext } = await import("./pi/adapter.ts");
  let pi;
  try {
    pi = toPiContext(context);
  } catch (error) {
    throw classifiedError(
      new Error(
        "Reviewer Standards/Spec sub-session requires pi host context (other hosts: subagent not in this ticket)",
        { cause: error },
      ),
      "child",
    );
  }
  if (pi.model === undefined) {
    throw classifiedError(new Error("Reviewer axis sub-session requires parent model"), "child");
  }
  return {
    provider: pi.model.provider,
    model: pi.model.id,
    ...(pi.thinkingLevel === undefined ? {} : { thinking: String(pi.thinkingLevel) }),
  };
}

export type ReviewerChildExecuteOptions = Readonly<{
  signal?: AbortSignal;
  credentialScratchParent?: string;
  /** @deprecated retained for call-site compatibility; nest books under parent session. */
  runDirectory?: string;
  /** Package root for optional engine method-material on legs (#378). */
  packageRoot?: string;
}>;

/**
 * Single conversion at the Reviewer adapter boundary: shared child classifications
 * become Reviewer failure classifications without a second error taxonomy.
 */
export function projectSharedChildFailure(error: unknown): unknown {
  if (typeof error === "object" && error !== null && "evidenceChildFailure" in error) {
    const classification = (error as { evidenceChildFailure?: unknown }).evidenceChildFailure;
    if (classification === "provider" || classification === "child" || classification === "unknown") {
      Object.assign(error, { reviewerFailure: classification });
    }
  }
  return error;
}

/** Reviewer Standards/Spec leg via pi in-process sub-session (#744). */
export async function executeReviewerChild(
  workspace: string,
  leg: AcceptedReviewerLeg,
  context: HostContext,
  options: ReviewerChildExecuteOptions = {},
): Promise<{ report: unknown; usage: Usage; prompt: ReviewerPromptText }> {
  try {
    if (options.signal?.aborted) {
      throw Object.assign(new DOMException("The operation was aborted.", "AbortError"), {
        evidenceChildFailure: "child" as const,
      });
    }
    const signal = options.signal;
    const selection = await parentSelectionAsync(context);
    return await withScratch(
      {
        prefix: "ak-reviewer-axis-",
        ...(options.credentialScratchParent === undefined
          ? {}
          : { parentDirectory: options.credentialScratchParent }),
      },
      async (childConfigDir) => {
        const { openPiInProcessSession } = await import("./pi/in-process-session.ts");
        const { createRecordSession } = await import("./archivist-record-entry.ts");
        const engineName = engineNameFromEnv();
        const engineMaterial =
          engineName === undefined
            ? undefined
            : options.packageRoot === undefined || options.packageRoot.trim() === ""
              ? Object.freeze({ name: engineName })
              : engineSessionMaterialFromOptions({
                  engine: engineName,
                  packageRoot: options.packageRoot,
                });
        let engineDetourFailure: Error | undefined;
        const engineDetourTool =
          engineName === undefined
            ? undefined
            : createEngineDetourToolDefinition({
                engineName,
                fail(error) {
                  engineDetourFailure ??= error instanceof Error ? error : new Error(String(error));
                  throw engineDetourFailure;
                },
              });
        let opened: Awaited<ReturnType<typeof openPiInProcessSession>>;
        try {
          opened = await openPiInProcessSession({
            cwd: workspace,
            agentDir: childConfigDir,
            selection,
            systemPrompt: await buildAxisSystemPrompt(engineMaterial),
            ...(engineDetourTool === undefined
              ? {}
              : { customTools: [engineDetourTool] }),
            sessionManager: createRecordSession({
              cwd: workspace,
              kind: "evidence-children",
              parent: context.sessionManager,
            }),
            ...(signal === undefined ? {} : { signal }),
            label: "Reviewer axis sub-session",
          });
        } catch (error) {
          throw classifiedError(error, "provider");
        }
        const { handle } = opened;
        const usage = emptyUsage();
        const unsubscribe = handle.subscribe((event) => {
          if (event.type === "message_end" && event.role === "assistant") {
            if (event.usage) addUsage(usage, event.usage as Usage);
          }
        });
        const abortChild = () => { handle.abort(); };
        if (signal?.aborted) abortChild();
        else signal?.addEventListener("abort", abortChild, { once: true });
        let primaryFailure: unknown;
        try {
          const delivered = leg.prompt;
          let turnResult: HostAssistantTurnResult;
          try {
            turnResult = await handle.prompt(String(delivered));
          } catch (error) {
            if (engineDetourFailure !== undefined) {
              throw classifiedError(engineDetourFailure, "child");
            }
            throw classifiedError(error, "provider");
          }
          if (engineDetourFailure !== undefined) {
            throw classifiedError(engineDetourFailure, "child");
          }
          if (signal?.aborted) throw new Error("Reviewer axis sub-session was cancelled");
          const lastAssistant = turnResult.messages !== undefined
            ? [...turnResult.messages].reverse().find((message: unknown) =>
              typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant"
            ) as AssistantMessage | undefined
            : undefined;
          if (
            turnResult.stopReason === "error" || turnResult.stopReason === "aborted"
            || (lastAssistant?.role === "assistant" && (lastAssistant.stopReason === "error" || lastAssistant.stopReason === "aborted"))
          ) {
            const errMsg = turnResult.errorMessage ?? lastAssistant?.errorMessage ?? "";
            throw classifiedError(
              new Error(errMsg, { cause: lastAssistant }),
              lastAssistant && projectStructuredRemote(lastAssistant).hasTestimony ? "provider" : "unknown",
            );
          }
          if (lastAssistant !== undefined && lastAssistant.role !== "assistant") {
            throw classifiedError(
              new Error("Reviewer axis sub-session terminated without a report", {
                cause: lastAssistant ?? turnResult.messages,
              }),
              "child",
            );
          }
          const report = turnResult.text;
          if (report.trim().length === 0) {
            throw new Error("Reviewer axis sub-session returned a blank report");
          }
          return { report, usage, prompt: delivered };
        } catch (error) {
          primaryFailure = classifiedError(error, "child");
          throw primaryFailure;
        } finally {
          signal?.removeEventListener("abort", abortChild);
          await runChildCleanup([() => unsubscribe(), () => handle.close()], primaryFailure, "Reviewer axis");
        }
      },
    );
  } catch (error) {
    throw projectSharedChildFailure(error);
  }
}
