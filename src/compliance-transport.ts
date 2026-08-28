import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  executeAuditorChild,
  type AuditorCompletion,
} from "./evidence-child-executor.ts";
import { createAuditorDossierTool } from "./auditor-dossier-tool.ts";
import type { DossierObservation } from "./dossier-resolution.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";

export type ComplianceCompletion = AuditorCompletion;
export type ComplianceArgumentRootType = "null" | "array" | "undefined" | "string" | "number" | "boolean" | "bigint" | "symbol" | "function";
export type ComplianceAuditObservation =
  | { kind: "non-object-arguments"; type: ComplianceArgumentRootType }
  | { kind: "object-status-unreadable"; status: "missing" | "unknown" }
  | DossierObservation;
export type ComplianceNoReceipt = NoReceiptLifecycleFacts & { status: "no-receipt"; usage?: Usage };
export type ComplianceDecision = { status: "pass"; usage?: Usage } | { status: "revise"; violations: readonly unknown[]; usage?: Usage } | { status: "escalate"; conflicts?: unknown; decisionGate?: unknown; usage?: Usage } | ComplianceNoReceipt;

/** Unreadable compliance candidate — infrastructure failure, not a judgment status (#475). */
export class ComplianceCandidateUnreadableError extends Error {
  readonly observation: ComplianceAuditObservation;
  readonly candidate: unknown;
  readonly usage?: Usage;
  constructor(observation: ComplianceAuditObservation, candidate: unknown, usage?: Usage) {
    const detail =
      observation.kind === "non-object-arguments"
        ? `${observation.kind}:${observation.type}`
        : observation.kind === "object-status-unreadable"
          ? `${observation.kind}:${observation.status}`
          : observation.kind === "missing-subject"
            ? `${observation.kind}:${observation.subject}`
            : observation.kind;
    super(`Compliance candidate unreadable: ${detail}`);
    this.name = "ComplianceCandidateUnreadableError";
    this.observation = observation;
    this.candidate = candidate;
    if (usage !== undefined) this.usage = usage;
  }
}
/** Zero-projection kickoff — soul already carries dossier-fetch duty; no hand-delivered materials. */
export const AUDITOR_DOSSIER_PROMPT = "本 run 卷宗已就绪。" as const;

const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({ question: nonblank, options: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false });
// Transport retains malformed candidates on ComplianceCandidateUnreadableError so
// the existing failure channel can publish observation + candidate (#475).
// Status values are guidance, not a schema gate.
export const complianceDecisionSchema = Type.Object({ status: Type.Unknown({ description: "pass | revise | escalate — 形状指引，非 schema 闸" }), violations: Type.Array(nonblank, { description: "观察到的合规违规" }), conflicts: Type.Array(nonblank, { description: "未决权威或执行冲突" }), decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "升级问题与可选选项" }) }, { additionalProperties: true, required: [] });

export function createComplianceDecisionTool(name: string, description: string) {
  return { name, description, parameters: complianceDecisionSchema, async execute(_id: string, params: unknown): Promise<AgentToolResult<unknown>> { return { content: [{ type: "text", text: "审计决议已收" }], details: params, terminate: true }; } };
}

export const COMPLIANCE_RESPONSE_ENTRY_TYPE = "ak_compliance_response" as const;
export const AUDITOR_PARENT_ATTEMPT_BINDING_ENTRY_TYPE = "ak_auditor_parent_attempt_binding" as const;
export const AUDITOR_COMPLIANCE_FAILURE_ENTRY_TYPE = "ak_auditor_compliance_failure" as const;

export type AuditorParentAttemptBinding = {
  readonly version: 1;
  readonly parent: {
    readonly sessionId?: string;
    readonly sessionFile?: string;
    readonly attemptEntryId?: string;
  };
};
export class ComplianceResponseRetentionError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "ComplianceResponseRetentionError"; }
}
export type ActiveSessionResponseAppender = { appendCustomEntry(customType: string, data?: unknown): string };
/** Unique owner for session custom-entry append with availability check and typed failure. */
export function appendActiveSessionCustomEntry(
  context: ExtensionContext,
  customType: string,
  data?: unknown,
  labels: { unavailable?: string; failed?: string } = {},
): string {
  const manager = context.sessionManager as unknown as Partial<ActiveSessionResponseAppender> | undefined;
  if (typeof manager?.appendCustomEntry !== "function") {
    throw new ComplianceResponseRetentionError(
      labels.unavailable ?? "session custom entry append is unavailable",
    );
  }
  try {
    return manager.appendCustomEntry(customType, data);
  } catch (error) {
    throw new ComplianceResponseRetentionError(
      labels.failed ?? "session custom entry append failed",
      { cause: error },
    );
  }
}
function retainComplianceResponse(context: ExtensionContext, response: AssistantMessage): void {
  appendActiveSessionCustomEntry(
    context,
    COMPLIANCE_RESPONSE_ENTRY_TYPE,
    { version: 1, response },
    {
      unavailable: "compliance response retention is unavailable",
      failed: "compliance response retention failed",
    },
  );
}
function readListField(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : value === undefined ? [] : [value]; }
export function readComplianceCandidate(arguments_: unknown, usage?: Usage): ComplianceDecision {
  if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) {
    throw new ComplianceCandidateUnreadableError(
      { kind: "non-object-arguments", type: arguments_ === null ? "null" : Array.isArray(arguments_) ? "array" : typeof arguments_ as ComplianceArgumentRootType },
      arguments_,
      usage,
    );
  }
  const args = arguments_ as Record<string, unknown>; const status = args.status;
  if (status === "pass") return { status, ...(usage === undefined ? {} : { usage }) };
  if (status === "revise") return { status, violations: readListField(args.violations), ...(usage === undefined ? {} : { usage }) };
  if (status === "escalate") return { status, ...(Object.hasOwn(args, "conflicts") ? { conflicts: args.conflicts } : {}), ...(Object.hasOwn(args, "decisionGate") ? { decisionGate: args.decisionGate } : {}), ...(usage === undefined ? {} : { usage }) };
  throw new ComplianceCandidateUnreadableError(
    { kind: "object-status-unreadable", status: status === undefined ? "missing" : "unknown" },
    arguments_,
    usage,
  );
}

export type RunComplianceAuditOptions = {
  tool: ReturnType<typeof createComplianceDecisionTool>;
  systemPrompt: string;
  /** @deprecated Fixer-lane hand-delivery only (#242 retires). Prefer omitting for zero-projection auditors. */
  serializedInput?: string;
  roleLabel: string;
  invalidDecisionLabel: string;
  runCompletion?: ComplianceCompletion;
  context: ExtensionContext;
  /** Exact machine-owned run binding; never sourced from AK_ROLE_RUN_DIR. */
  runDirectory?: string | undefined;
  signal?: AbortSignal;
};

export async function runComplianceAudit(options: RunComplianceAuditOptions): Promise<ComplianceDecision> {
  const prompt = options.serializedInput ?? AUDITOR_DOSSIER_PROMPT;
  const receipt = await executeAuditorChild({
    tool: options.tool,
    dossierTool: createAuditorDossierTool(options.runDirectory),
    systemPrompt: options.systemPrompt,
    prompt,
    roleLabel: options.roleLabel,
    context: options.context,
    retainResponse: (response) => retainComplianceResponse(options.context, response),
    ...(options.runDirectory === undefined ? {} : { runDirectory: options.runDirectory }),
    ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (receipt.noReceiptLifecycle !== undefined) {
    return {
      status: "no-receipt",
      ...receipt.noReceiptLifecycle,
      ...(receipt.response.usage === undefined ? {} : { usage: receipt.response.usage }),
    };
  }
  return readComplianceCandidate(receipt.decision, receipt.response.usage);
}
