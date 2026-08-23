import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { executeAuditorChild, type AuditorCompletion, type AuditorDecisionTool } from "./evidence-child-executor.ts";

export const MENXIA_OUTPUT_TOOL = "ak_menxia_output";
export const JISHIZHONG_OUTPUT_TOOL = "ak_jishizhong_output";
export const FUBAOLANG_OUTPUT_TOOL = "ak_fubaolang_output";
const SUBJECT_TOOL = "ak_menxia_subject";

export type MenxiaSubject =
  | { readonly kind: "worker_completion"; readonly material: string }
  | { readonly kind: "judge_draft"; readonly material: string };

export type MenxiaResult =
  | { readonly status: "pass"; readonly officer: "jishizhong" | "fubaolang"; readonly findings: readonly string[] }
  | { readonly status: "bounce"; readonly officer: "jishizhong" | "fubaolang"; readonly disposition: "rewrite"; readonly findings: readonly string[] }
  | { readonly status: "incomplete"; readonly stage: "menxia" | "jishizhong" | "fubaolang"; readonly reason: string }
  | { readonly status: "transport_failure"; readonly stage: "menxia" | "jishizhong" | "fubaolang"; readonly reason: string };

export type RunMenxiaOptions = {
  readonly context: ExtensionContext;
  readonly subject: MenxiaSubject;
  readonly signal?: AbortSignal;
  readonly runCompletion?: AuditorCompletion;
  readonly loadSoul?: (role: "menxia" | "jishizhong" | "fubaolang") => Promise<string>;
};

const decisionSchema = Type.Union([
  Type.Object({ status: Type.Literal("pass"), findings: Type.Array(Type.String()) }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal("bounce"), findings: Type.Array(Type.String()) }, { additionalProperties: false }),
  Type.Object({ status: Type.Literal("incomplete"), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

function result(content: string, details: unknown) {
  return { content: [{ type: "text" as const, text: content }], details };
}

function subjectTool(subject: MenxiaSubject): AuditorDecisionTool {
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

function menxiaTool(expected: "jishizhong" | "fubaolang"): AuditorDecisionTool {
  return {
    name: MENXIA_OUTPUT_TOOL,
    description: "Dispatch the admitted subject to one officer, or report incomplete.",
    parameters: Type.Union([
      Type.Object({ status: Type.Literal("dispatch"), officer: Type.Union([Type.Literal("jishizhong"), Type.Literal("fubaolang")]) }, { additionalProperties: false }),
      Type.Object({ status: Type.Literal("incomplete"), reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
    ]),
    async execute(_id, args) {
      if (args.status === "dispatch" && args.officer !== expected) {
        throw new Error(`admitted ${expected} subject cannot be dispatched to ${args.officer}`);
      }
      return result(`accepted ${String(args.status)}`, args);
    },
  };
}

async function defaultLoadSoul(role: "menxia" | "jishizhong" | "fubaolang"): Promise<string> {
  return readFile(fileURLToPath(new URL(`../souls/${role}.md`, import.meta.url)), "utf8");
}

function failureReason(error: unknown): string {
  if (error instanceof AggregateError) return error.errors.map(failureReason).join("; ");
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

export async function runMenxia(options: RunMenxiaOptions): Promise<MenxiaResult> {
  const expected = options.subject.kind === "worker_completion" ? "jishizhong" : "fubaolang";
  const loadSoul = options.loadSoul ?? defaultLoadSoul;
  let province: any;
  try {
    province = (await executeAuditorChild({
      context: options.context,
      roleLabel: "Menxia",
      systemPrompt: await loadSoul("menxia"),
      prompt: "Read the admitted subject with ak_menxia_subject, then dispatch it or submit typed incomplete.",
      tool: menxiaTool(expected),
      dossierTool: subjectTool(options.subject),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
    })).decision;
  } catch (error) {
    return { status: "transport_failure", stage: "menxia", reason: failureReason(error) };
  }
  if (province?.status === "incomplete") return { status: "incomplete", stage: "menxia", reason: province.reason };

  const officer = province?.officer as "jishizhong" | "fubaolang";
  try {
    const judged: any = (await executeAuditorChild({
      context: options.context,
      roleLabel: officer === "jishizhong" ? "Jishizhong" : "Fubaolang",
      systemPrompt: await loadSoul(officer),
      prompt: "Read the admitted subject with ak_menxia_subject, then submit one typed decision on only your assigned axes.",
      tool: decisionTool(officer === "jishizhong" ? JISHIZHONG_OUTPUT_TOOL : FUBAOLANG_OUTPUT_TOOL),
      dossierTool: subjectTool(options.subject),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
    })).decision;
    if (judged?.status === "incomplete") return { status: "incomplete", stage: officer, reason: judged.reason };
    if (judged?.status === "bounce") return { status: "bounce", officer, disposition: "rewrite", findings: judged.findings };
    return { status: "pass", officer, findings: judged.findings };
  } catch (error) {
    return { status: "transport_failure", stage: officer, reason: failureReason(error) };
  }
}
