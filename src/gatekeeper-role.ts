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

export type GatekeeperSubject =
  | { readonly kind: "worker_completion"; readonly material: string }
  | { readonly kind: "judge_draft"; readonly material: string };

export type GatekeeperResult =
  | { readonly status: "pass"; readonly officer: "inspector" | "notary"; readonly findings: readonly string[] }
  | {
      readonly status: "bounce";
      readonly officer: "inspector" | "notary";
      readonly disposition: "rewrite";
      readonly findings: readonly string[];
      readonly submission: unknown;
    }
  | { readonly status: "no_receipt"; readonly stage: "gatekeeper" | "inspector" | "notary"; readonly reason: string; readonly facts: NoReceiptLifecycleFacts }
  | {
      readonly status: "transport_failure";
      readonly stage: "gatekeeper" | "inspector" | "notary";
      readonly reason: string;
      /** Original unusable submission retained for the failure channel. */
      readonly submission?: unknown;
    };

export type GatekeeperNonPassResult = Extract<
  GatekeeperResult,
  { status: "bounce" | "no_receipt" }
>;

function gateSeatLabel(stage: "gatekeeper" | "inspector" | "notary"): string {
  switch (stage) {
    case "gatekeeper":
      return "门下省";
    case "inspector":
      return "给事中";
    case "notary":
      return "符宝郎";
  }
}

function nonPassMessage(result: GatekeeperNonPassResult): string {
  // Message text is what pi-agent-core createErrorToolResult exposes to the model.
  if (result.status === "bounce") {
    const findings = result.findings.length === 0 ? "（无 findings）" : result.findings.join("; ");
    return `门下省打回重写，findings：${findings}`;
  }
  return `门下省 ${result.status}（${result.stage}）：${result.reason}`;
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

export type RunGatekeeperOptions = {
  readonly context: ExtensionContext;
  readonly subject: GatekeeperSubject;
  readonly signal?: AbortSignal;
  readonly runCompletion?: AuditorCompletion;
  readonly loadSoul?: (role: "gatekeeper" | "inspector" | "notary") => Promise<string>;
  /** Run directory carrying the institutional resolution page (#518). Derives
   * from context when absent. */
  readonly runDirectory?: string;
};

export type GatekeeperPassHostActions = {
  failInfrastructure(error: unknown, ctx: ExtensionContext, toolCallId?: string): never;
  /** Envelope-owned execute→tool_result bridge (role-runtime); role module only throws typed error. */
  bindGatekeeperNonPass(toolCallId: string, result: GatekeeperNonPassResult): void;
};

// Unknown fields so wrong types/spellings still reach projection (ADR 0055/0057; 仓第 0 条).
// Opening goes through the sole openToolObject owner — no parallel transport helper.
const officerDecisionSchema = openToolObject(Type.Object({
  status: Type.Unknown({ description: "pass | bounce — 形状指引，非 schema 闸" }),
  findings: Type.Unknown({ description: "string[] findings，随 pass 或 bounce 留存" }),
}));

const gatekeeperDecisionSchema = openToolObject(Type.Object({
  status: Type.Unknown({ description: "dispatch — 形状指引，非 schema 闸" }),
  officer: Type.Unknown({ description: "status 为 dispatch 时为 inspector | notary" }),
}));

function result(content: string, details: unknown) {
  return { content: [{ type: "text" as const, text: content }], details };
}

function subjectTool(subject: GatekeeperSubject): AuditorDecisionTool {
  return {
    name: SUBJECT_TOOL,
    description: "读取已受理卷宗；只供取阅，不评判不改动。",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() { return result(JSON.stringify(subject), subject); },
  };
}

/** Shared officer decision tool — open transport; projection owns legality. */
export function createOfficerDecisionTool(name: string): AuditorDecisionTool {
  return {
    name,
    description: "提交一份 typed pass/bounce 决议。",
    parameters: officerDecisionSchema,
    async execute(_id, args) { return result(`已收 ${String((args as { status?: unknown })?.status)}`, args); },
  };
}

/** Gatekeeper province decision tool — open transport; projection owns legality. */
export function createGatekeeperOutputTool(): AuditorDecisionTool {
  return {
    name: GATEKEEPER_OUTPUT_TOOL,
    description: "提交门下省派官决定。",
    parameters: gatekeeperDecisionSchema,
    async execute(_id, args) { return result(`已收 ${String((args as { status?: unknown })?.status)}`, args); },
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

/** Serializable stand-in when the child tool call had no arguments object. */
export const MISSING_ARGUMENTS_SUBMISSION = Object.freeze({ missing: "arguments" as const });

/** Keep original decision bytes for the next reader; undefined becomes a serializable missing-args fact. */
function retainedSubmission(decision: unknown): unknown {
  // undefined must not be stored: JSON drops it and the missing-args fact vanishes.
  return decision === undefined ? MISSING_ARGUMENTS_SUBMISSION : decision;
}

/**
 * No usable explicit release is infrastructure failure, not a judgment status.
 * Original submission is retained for the failure channel (#475).
 */
function noUsableReleaseFailure(
  stage: "gatekeeper" | "inspector" | "notary",
  decision: unknown,
): Extract<GatekeeperResult, { status: "transport_failure" }> {
  return {
    status: "transport_failure",
    stage,
    reason: stage === "gatekeeper" ? "decision 无显式 dispatch" : "decision 无显式 pass/bounce",
    submission: retainedSubmission(decision),
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function projectProvinceDecision(decision: unknown): GatekeeperResult | { status: "dispatch"; officer: "inspector" | "notary" } {
  const record = readRecord(decision);
  if (record === undefined) return noUsableReleaseFailure("gatekeeper", decision);
  if (record.status === "dispatch" && (record.officer === "inspector" || record.officer === "notary")) {
    return { status: "dispatch", officer: record.officer };
  }
  return noUsableReleaseFailure("gatekeeper", decision);
}

function projectOfficerDecision(
  officer: "inspector" | "notary",
  decision: unknown,
): GatekeeperResult {
  const record = readRecord(decision);
  if (record === undefined) return noUsableReleaseFailure(officer, decision);
  if (record.status === "bounce") {
    return {
      status: "bounce",
      officer,
      disposition: "rewrite",
      findings: asStringArray(record.findings),
      submission: retainedSubmission(decision),
    };
  }
  if (record.status === "pass") {
    return {
      status: "pass",
      officer,
      findings: asStringArray(record.findings),
    };
  }
  return noUsableReleaseFailure(officer, decision);
}

export async function runGatekeeper(options: RunGatekeeperOptions): Promise<GatekeeperResult> {
  const loadSoul = options.loadSoul ?? defaultLoadSoul;
  let provinceRun: Awaited<ReturnType<typeof executeAuditorChild>>;
  try {
    // Seat identity only — shared executor owns model config/registry/auth (#453 / ADR 0018).
    provinceRun = await executeAuditorChild({
      context: options.context,
      roleLabel: "Gatekeeper",
      gateSeat: "gatekeeper",
      systemPrompt: await loadSoul("gatekeeper"),
      prompt: "卷宗已受理。",
      tool: createGatekeeperOutputTool(),
      dossierTool: subjectTool(options.subject),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
      ...(options.runDirectory === undefined ? {} : { runDirectory: options.runDirectory }),
    });
  } catch (error) {
    return { status: "transport_failure", stage: "gatekeeper", reason: failureReason(error) };
  }
  if (provinceRun.noReceiptLifecycle !== undefined) {
    return { status: "no_receipt", stage: "gatekeeper", reason: `${gateSeatLabel("gatekeeper")}未产生已接受回执即散局`, facts: provinceRun.noReceiptLifecycle };
  }
  const province = projectProvinceDecision(provinceRun.decision);
  if (province.status !== "dispatch") return province;

  const officer = province.officer;
  try {
    const roleLabel = officer === "inspector" ? "Inspector" : "Notary";
    const officerRun = await executeAuditorChild({
      context: options.context,
      roleLabel,
      gateSeat: officer,
      systemPrompt: await loadSoul(officer),
      prompt: "卷宗已受理。",
      tool: createOfficerDecisionTool(officer === "inspector" ? INSPECTOR_OUTPUT_TOOL : NOTARY_OUTPUT_TOOL),
      dossierTool: subjectTool(options.subject),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
      ...(options.runDirectory === undefined ? {} : { runDirectory: options.runDirectory }),
    });
    if (officerRun.noReceiptLifecycle !== undefined) {
      return { status: "no_receipt", stage: officer, reason: `${gateSeatLabel(officer)}未产生已接受回执即散局`, facts: officerRun.noReceiptLifecycle };
    }
    return projectOfficerDecision(officer, officerRun.decision);
  } catch (error) {
    return { status: "transport_failure", stage: officer, reason: failureReason(error) };
  }
}

/** Project GatekeeperResult onto a submit path: transport→failInfrastructure; bounce/no_receipt→typed throw; pass silent. */
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
    ...((options.context as any)?.runCompletion !== undefined ? { runCompletion: (options.context as any).runCompletion } : {}),
  });
  if (gatekeeper.status === "pass") return;
  if (gatekeeper.status === "transport_failure") {
    // Typed stage/reason/submission ride failInfrastructure → durable tool_result (#475).
    const error = new Error(`门下省 transport_failure（${gatekeeper.stage}）：${gatekeeper.reason}`) as Error & {
      stage: typeof gatekeeper.stage;
      reason: string;
      submission?: unknown;
    };
    error.stage = gatekeeper.stage;
    error.reason = gatekeeper.reason;
    if (gatekeeper.submission !== undefined) error.submission = gatekeeper.submission;
    options.hostActions.failInfrastructure(error, options.context, options.toolCallId);
  }
  // Envelope owns the execute→tool_result bridge; this module only projects + throws.
  options.hostActions.bindGatekeeperNonPass(options.toolCallId, gatekeeper);
  throw new GatekeeperDecisionError(gatekeeper);
}
