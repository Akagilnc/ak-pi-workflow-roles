import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { executeAuditorChild, type AuditorCompletion, type AuditorDecisionTool } from "./evidence-child-executor.ts";
import { openToolObject } from "./open-tool-schema.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";
import { loadGatekeeperSessionMaterials } from "./session-opening-materials.ts";

export const GATEKEEPER_OUTPUT_TOOL = "ak_gatekeeper_output";
export const INSPECTOR_OUTPUT_TOOL = "ak_inspector_output";
export const NOTARY_OUTPUT_TOOL = "ak_notary_output";
const SUBJECT_TOOL = "ak_gatekeeper_subject";

const MALFORMED_ACCEPTED_SUBMISSION = "malformed accepted submission";

export type GatekeeperSubject =
  | { readonly kind: "worker_completion"; readonly material: string }
  | { readonly kind: "judge_draft"; readonly material: string };

export type GatekeeperResult =
  | { readonly status: "pass"; readonly officer: "inspector" | "notary"; readonly findings: readonly string[] }
  | { readonly status: "bounce"; readonly officer: "inspector" | "notary"; readonly disposition: "rewrite"; readonly findings: readonly string[] }
  | {
      readonly status: "incomplete";
      readonly stage: "gatekeeper" | "inspector" | "notary";
      readonly reason: string;
      readonly submission?: unknown;
    }
  | { readonly status: "no_receipt"; readonly stage: "gatekeeper" | "inspector" | "notary"; readonly reason: string; readonly facts: NoReceiptLifecycleFacts }
  | { readonly status: "transport_failure"; readonly stage: "gatekeeper" | "inspector" | "notary"; readonly reason: string };

export type GatekeeperNonPassResult = Extract<
  GatekeeperResult,
  { status: "bounce" | "incomplete" | "no_receipt" }
>;

function nonPassMessage(result: GatekeeperNonPassResult): string {
  // Message text is what pi-agent-core createErrorToolResult exposes to the model.
  if (result.status === "bounce") {
    const findings = result.findings.length === 0 ? "(no findings)" : result.findings.join("; ");
    return `Gatekeeper requires rewrite: ${findings}`;
  }
  return `Gatekeeper ${result.status} at ${result.stage}: ${result.reason}`;
}

/** Structured non-pass; `.result` is session-projected via tool_result, message feeds the model. */
export class GatekeeperDecisionError extends Error {
  readonly result: GatekeeperNonPassResult;
  constructor(result: GatekeeperNonPassResult) {
    super(nonPassMessage(result));
    this.name = "GatekeeperDecisionError";
    this.result = result;
  }
}

/** toolCallId → non-pass result until role-runtime tool_result projects it onto session details. */
const pendingNonPassByToolCallId = new Map<string, GatekeeperNonPassResult>();

/** Consume a pending non-pass for session details projection (sole owner: requireGatekeeperPass + role-runtime). */
export function takeGatekeeperNonPassDetails(toolCallId: string): GatekeeperNonPassResult | undefined {
  const result = pendingNonPassByToolCallId.get(toolCallId);
  if (result !== undefined) pendingNonPassByToolCallId.delete(toolCallId);
  return result;
}

export type RunGatekeeperOptions = {
  readonly context: ExtensionContext;
  readonly subject: GatekeeperSubject;
  readonly signal?: AbortSignal;
  readonly runCompletion?: AuditorCompletion;
  readonly loadSoul?: (role: "gatekeeper" | "inspector" | "notary") => Promise<string>;
};

export type GatekeeperPassHostActions = {
  failInfrastructure(error: unknown, ctx: ExtensionContext, toolCallId?: string): never;
};

// Unknown fields so wrong types/spellings still reach projection (ADR 0055/0057; 仓第 0 条).
// Opening goes through the sole openToolObject owner — no parallel transport helper.
const officerDecisionSchema = openToolObject(Type.Object({
  status: Type.Unknown({ description: "pass | bounce | incomplete — guidance, not a schema gate." }),
  findings: Type.Unknown({ description: "string[] findings retained with pass or bounce." }),
  reason: Type.Unknown({ description: "Why the officer decision is incomplete." }),
}));

const gatekeeperDecisionSchema = openToolObject(Type.Object({
  status: Type.Unknown({ description: "dispatch | incomplete — guidance, not a schema gate." }),
  officer: Type.Unknown({ description: "inspector | notary when status is dispatch." }),
  reason: Type.Unknown({ description: "Why Gatekeeper dispatch is incomplete." }),
}));

const INVOCATION_OVERLAY = "取证工具不受白名单限制；若取证产生临时副作用，取证结束后须自行恢复。";

function result(content: string, details: unknown) {
  return { content: [{ type: "text" as const, text: content }], details };
}

function subjectTool(subject: GatekeeperSubject): AuditorDecisionTool {
  return {
    name: SUBJECT_TOOL,
    description: "Read the admitted subject. Collection only: this tool never judges or mutates it.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() { return result(JSON.stringify(subject), subject); },
  };
}

/** Shared officer decision tool — open transport; projection owns legality. */
export function createOfficerDecisionTool(name: string): AuditorDecisionTool {
  return {
    name,
    description: "Submit one typed pass, bounce, or incomplete decision.",
    parameters: officerDecisionSchema,
    async execute(_id, args) { return result(`accepted ${String((args as { status?: unknown })?.status)}`, args); },
  };
}

/** Gatekeeper province decision tool — open transport; projection owns legality. */
export function createGatekeeperOutputTool(): AuditorDecisionTool {
  return {
    name: GATEKEEPER_OUTPUT_TOOL,
    description: "Dispatch the admitted subject to one officer, or report incomplete.",
    parameters: gatekeeperDecisionSchema,
    async execute(_id, args) { return result(`accepted ${String((args as { status?: unknown })?.status)}`, args); },
  };
}

async function defaultLoadSoul(role: "gatekeeper" | "inspector" | "notary"): Promise<string> {
  return loadGatekeeperSessionMaterials(role);
}

function failureReason(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(failureReason).join("; ");
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function malformedIncomplete(
  stage: "gatekeeper" | "inspector" | "notary",
  submission: unknown,
): Extract<GatekeeperResult, { status: "incomplete" }> {
  return {
    status: "incomplete",
    stage,
    reason: MALFORMED_ACCEPTED_SUBMISSION,
    submission,
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function projectProvinceDecision(decision: unknown): GatekeeperResult | { status: "dispatch"; officer: "inspector" | "notary" } {
  const record = readRecord(decision);
  if (record === undefined) return malformedIncomplete("gatekeeper", decision);
  if (record.status === "incomplete") {
    const reason = record.reason;
    if (typeof reason === "string" && reason.trim() !== "") {
      return { status: "incomplete", stage: "gatekeeper", reason };
    }
    return malformedIncomplete("gatekeeper", decision);
  }
  if (record.status === "dispatch" && (record.officer === "inspector" || record.officer === "notary")) {
    return { status: "dispatch", officer: record.officer };
  }
  return malformedIncomplete("gatekeeper", decision);
}

function projectOfficerDecision(
  officer: "inspector" | "notary",
  decision: unknown,
): GatekeeperResult {
  const record = readRecord(decision);
  if (record === undefined) return malformedIncomplete(officer, decision);
  if (record.status === "incomplete") {
    const reason = record.reason;
    if (typeof reason === "string" && reason.trim() !== "") {
      return { status: "incomplete", stage: officer, reason };
    }
    return malformedIncomplete(officer, decision);
  }
  if (record.status === "bounce") {
    return {
      status: "bounce",
      officer,
      disposition: "rewrite",
      findings: asStringArray(record.findings),
    };
  }
  if (record.status === "pass") {
    return {
      status: "pass",
      officer,
      findings: asStringArray(record.findings),
    };
  }
  return malformedIncomplete(officer, decision);
}

export async function runGatekeeper(options: RunGatekeeperOptions): Promise<GatekeeperResult> {
  const loadSoul = options.loadSoul ?? defaultLoadSoul;
  let provinceRun: Awaited<ReturnType<typeof executeAuditorChild>>;
  try {
    provinceRun = await executeAuditorChild({
      context: options.context,
      roleLabel: "Gatekeeper",
      systemPrompt: `${await loadSoul("gatekeeper")}\n\n${INVOCATION_OVERLAY}`,
      prompt: "Read the admitted subject with ak_gatekeeper_subject, then dispatch it or submit typed incomplete.",
      tool: createGatekeeperOutputTool(),
      dossierTool: subjectTool(options.subject),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
    });
  } catch (error) {
    return { status: "transport_failure", stage: "gatekeeper", reason: failureReason(error) };
  }
  if (provinceRun.noReceiptLifecycle !== undefined) {
    return { status: "no_receipt", stage: "gatekeeper", reason: "Gatekeeper settled without an accepted receipt", facts: provinceRun.noReceiptLifecycle };
  }
  const province = projectProvinceDecision(provinceRun.decision);
  if (province.status !== "dispatch") return province;

  const officer = province.officer;
  try {
    const officerRun = await executeAuditorChild({
      context: options.context,
      roleLabel: officer === "inspector" ? "Inspector" : "Notary",
      systemPrompt: `${await loadSoul(officer)}\n\n${INVOCATION_OVERLAY}`,
      prompt: "Read the admitted subject with ak_gatekeeper_subject, then submit one typed decision on only your assigned axes.",
      tool: createOfficerDecisionTool(officer === "inspector" ? INSPECTOR_OUTPUT_TOOL : NOTARY_OUTPUT_TOOL),
      dossierTool: subjectTool(options.subject),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
    });
    if (officerRun.noReceiptLifecycle !== undefined) {
      return { status: "no_receipt", stage: officer, reason: `${officer} settled without an accepted receipt`, facts: officerRun.noReceiptLifecycle };
    }
    return projectOfficerDecision(officer, officerRun.decision);
  } catch (error) {
    return { status: "transport_failure", stage: officer, reason: failureReason(error) };
  }
}

/** Project GatekeeperResult onto a submit path: transport→failInfrastructure; bounce/incomplete/no_receipt→typed throw; pass silent. */
export async function requireGatekeeperPass(options: {
  readonly context: ExtensionContext;
  readonly subject: GatekeeperSubject;
  readonly signal?: AbortSignal;
  readonly hostActions: GatekeeperPassHostActions;
  readonly toolCallId: string;
}): Promise<void> {
  const gatekeeper = await runGatekeeper({
    context: options.context,
    subject: options.subject,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (gatekeeper.status === "pass") return;
  if (gatekeeper.status === "transport_failure") {
    options.hostActions.failInfrastructure(
      new Error(`Gatekeeper transport failure at ${gatekeeper.stage}: ${gatekeeper.reason}`),
      options.context,
      options.toolCallId,
    );
  }
  // Bind structured result to this output call so tool_result can project details
  // (throw path alone only keeps error.message for the model).
  pendingNonPassByToolCallId.set(options.toolCallId, gatekeeper);
  throw new GatekeeperDecisionError(gatekeeper);
}
