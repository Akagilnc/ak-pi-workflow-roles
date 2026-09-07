/**
 * Reviewer Standards/Spec axis sub-session (#744).
 * Pi host: identity-less in-process child via shared open seam (openPiInProcessSession).
 * Adapter keeps only: materials, engine detour, parent model, nest booking, failure projection.
 * Scratch / abort / usage / close lifecycle stay on the shared envelope (ADR 0018).
 * Other hosts' subagent capability is out of this ticket (principle frozen).
 */
import type { Usage } from "@earendil-works/pi-ai";

import type { HostContext, RoleTurnModelConfig } from "./host-contracts.ts";
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
import { hasUpstreamErrorTestimony, isNonSuccessHttpStatus } from "./upstream-error-testimony.ts";

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

function classifiedError(error: unknown, evidenceChildFailure: AxisFailureClassification): ClassifiedAxisError {
  const diagnostic = typeof error === "object" && error !== null && typeof (error as { errorMessage?: unknown }).errorMessage === "string"
    ? (error as { errorMessage: string }).errorMessage
    : error === undefined ? "" : String(error);
  const wrapped = error instanceof Error
    ? error
    : Object.assign(new Error(diagnostic, { cause: error }), { evidenceChildOriginal: error });
  const classification = "evidenceChildFailure" in wrapped
    ? (wrapped as ClassifiedAxisError).evidenceChildFailure
    : evidenceChildFailure;
  return Object.assign(wrapped, { evidenceChildFailure: classification });
}

/** Read envelope-projected testimony on an assistant/stop node — no private walker copy. */
function nodeHasUpstreamTestimony(node: unknown): boolean {
  if (typeof node !== "object" || node === null) return false;
  const record = node as Record<string, unknown>;
  const httpStatus = isNonSuccessHttpStatus(record.statusCode)
    ? record.statusCode
    : isNonSuccessHttpStatus(record.status)
      ? record.status
      : isNonSuccessHttpStatus(record.httpStatus)
        ? record.httpStatus
        : undefined;
  const diagnostics = Array.isArray(record.diagnostics) && record.diagnostics.length > 0
    ? record.diagnostics
    : undefined;
  return hasUpstreamErrorTestimony({
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(diagnostics === undefined ? {} : { diagnostics }),
  });
}

/** Parent seat model for the axis sub-session (pre-#675 parent-effective inheritance). Pi only. */
async function parentSelection(context: HostContext): Promise<RoleTurnModelConfig> {
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
  /** Parent directory for envelope-owned credential/config scratch. */
  credentialScratchParent?: string;
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
    const selection = await parentSelection(context);
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
      // No agentDir: envelope owns scratch via credentialScratchParent (ADR 0018).
      opened = await openPiInProcessSession({
        cwd: workspace,
        selection,
        systemPrompt: await buildAxisSystemPrompt(engineMaterial),
        ...(options.credentialScratchParent === undefined
          ? {}
          : { credentialScratchParent: options.credentialScratchParent }),
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
    try {
      const delivered = leg.prompt;
      let turnResult;
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
        )
        : undefined;
      if (
        turnResult.stopReason === "error" || turnResult.stopReason === "aborted"
        || (typeof lastAssistant === "object" && lastAssistant !== null
          && ((lastAssistant as { stopReason?: unknown }).stopReason === "error"
            || (lastAssistant as { stopReason?: unknown }).stopReason === "aborted"))
      ) {
        const errMsg = turnResult.errorMessage
          ?? (typeof lastAssistant === "object" && lastAssistant !== null
            ? String((lastAssistant as { errorMessage?: unknown }).errorMessage ?? "")
            : "");
        // Envelope already attaches observed HTTP status onto error/aborted assistants.
        const hasTestimony = nodeHasUpstreamTestimony(lastAssistant)
          || nodeHasUpstreamTestimony(opened.streamFailure);
        throw classifiedError(
          new Error(errMsg, { cause: lastAssistant }),
          hasTestimony ? "provider" : "unknown",
        );
      }
      const report = turnResult.text;
      if (report.trim().length === 0) {
        throw new Error("Reviewer axis sub-session returned a blank report");
      }
      const usage = (turnResult.usage as Usage | undefined) ?? emptyUsage();
      return { report, usage, prompt: delivered };
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw projectSharedChildFailure(error);
  }
}
