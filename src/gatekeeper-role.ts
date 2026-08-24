import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { executeAuditorChild, type AuditorCompletion, type AuditorDecisionTool } from "./evidence-child-executor.ts";
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
  | { readonly status: "bounce"; readonly officer: "inspector" | "notary"; readonly disposition: "rewrite"; readonly findings: readonly string[] }
  | { readonly status: "incomplete"; readonly stage: "gatekeeper" | "inspector" | "notary"; readonly reason: string }
  | { readonly status: "no_receipt"; readonly stage: "gatekeeper" | "inspector" | "notary"; readonly reason: string; readonly facts: NoReceiptLifecycleFacts }
  | { readonly status: "transport_failure"; readonly stage: "gatekeeper" | "inspector" | "notary"; readonly reason: string };

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

const decisionSchema = Type.Union([
  Type.Object({ status: Type.Literal("pass"), findings: Type.Array(Type.String()) }, { additionalProperties: false }),
  Type.Object({
    status: Type.Literal("bounce", { description: "Return for rewrite; this is not a failure of the invocation." }),
    findings: Type.Array(Type.String()),
  }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal("incomplete"), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

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

function decisionTool(name: string): AuditorDecisionTool {
  return {
    name,
    description: "Submit one typed pass, bounce, or incomplete decision.",
    parameters: decisionSchema,
    async execute(_id, args) { return result(`accepted ${String(args.status)}`, args); },
  };
}

function gatekeeperTool(): AuditorDecisionTool {
  return {
    name: GATEKEEPER_OUTPUT_TOOL,
    description: "Dispatch the admitted subject to one officer, or report incomplete.",
    parameters: Type.Union([
      Type.Object({ status: Type.Literal("dispatch"), officer: Type.Union([Type.Literal("inspector"), Type.Literal("notary")]) }, { additionalProperties: false }),
      Type.Object({ status: Type.Literal("incomplete"), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ]),
    async execute(_id, args) { return result(`accepted ${String(args.status)}`, args); },
  };
}

async function defaultLoadSoul(role: "gatekeeper" | "inspector" | "notary"): Promise<string> {
  return loadGatekeeperSessionMaterials(role);
}

function failureReason(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(failureReason).join("; ");
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
      tool: gatekeeperTool(),
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
  const province: any = provinceRun.decision;
  if (province?.status === "incomplete") return { status: "incomplete", stage: "gatekeeper", reason: province.reason };

  const officer = province?.officer as "inspector" | "notary";
  try {
    const officerRun = await executeAuditorChild({
      context: options.context,
      roleLabel: officer === "inspector" ? "Inspector" : "Notary",
      systemPrompt: `${await loadSoul(officer)}\n\n${INVOCATION_OVERLAY}`,
      prompt: "Read the admitted subject with ak_gatekeeper_subject, then submit one typed decision on only your assigned axes.",
      tool: decisionTool(officer === "inspector" ? INSPECTOR_OUTPUT_TOOL : NOTARY_OUTPUT_TOOL),
      dossierTool: subjectTool(options.subject),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
    });
    if (officerRun.noReceiptLifecycle !== undefined) {
      return { status: "no_receipt", stage: officer, reason: `${officer} settled without an accepted receipt`, facts: officerRun.noReceiptLifecycle };
    }
    const judged: any = officerRun.decision;
    if (judged?.status === "incomplete") return { status: "incomplete", stage: officer, reason: judged.reason };
    if (judged?.status === "bounce") return { status: "bounce", officer, disposition: "rewrite", findings: judged.findings };
    return { status: "pass", officer, findings: judged.findings };
  } catch (error) {
    return { status: "transport_failure", stage: officer, reason: failureReason(error) };
  }
}

/** Project GatekeeperResult onto a submit path: transport→failInfrastructure; bounce/incomplete/no_receipt→throw; pass silent. */
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
  if (gatekeeper.status === "transport_failure") {
    options.hostActions.failInfrastructure(
      new Error(`Gatekeeper transport failure at ${gatekeeper.stage}: ${gatekeeper.reason}`),
      options.context,
      options.toolCallId,
    );
  }
  if (gatekeeper.status === "bounce") {
    throw new Error(`Gatekeeper requires rewrite: ${gatekeeper.findings.join("; ")}`);
  }
  if (gatekeeper.status === "incomplete" || gatekeeper.status === "no_receipt") {
    throw new Error(`Gatekeeper ${gatekeeper.status} at ${gatekeeper.stage}: ${gatekeeper.reason}; ${JSON.stringify(gatekeeper)}`);
  }
}
