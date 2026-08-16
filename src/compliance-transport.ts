import type { Api, AssistantMessage, Model, Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  executeAuditorChild,
  type AuditorCompletion,
} from "./evidence-child-executor.ts";
import { createAuditorDossierTool } from "./auditor-dossier-tool.ts";
import type { DossierObservation } from "./dossier-resolution.ts";
import { withPackageOwnedToolIdleSuspended } from "./package-owned-tool-idle.ts";
import type { NoReceiptLifecycleFacts } from "./receipt-delivery-policy.ts";

export type ComplianceCompletion = AuditorCompletion;
export type ComplianceArgumentRootType = "null" | "array" | "undefined" | "string" | "number" | "boolean" | "bigint" | "symbol" | "function";
export type ComplianceAuditObservation =
  | { kind: "non-object-arguments"; type: ComplianceArgumentRootType }
  | { kind: "object-status-unreadable"; status: "missing" | "unknown" }
  | DossierObservation;
export type ComplianceAuditIncomplete = { status: "audit-incomplete"; observation: ComplianceAuditObservation; candidate: unknown; usage?: Usage };
export type ComplianceNoReceipt = NoReceiptLifecycleFacts & { status: "no-receipt"; usage?: Usage };
export type ComplianceDecision = { status: "pass"; usage?: Usage } | { status: "revise"; violations: readonly unknown[]; usage?: Usage } | { status: "escalate"; conflicts?: unknown; decisionGate?: unknown; usage?: Usage } | ComplianceNoReceipt | ComplianceAuditIncomplete;
export type ComplianceDispatch = { model: Model<Api>; auth: { apiKey?: string; headers?: Record<string, string | null>; env?: Record<string, string> } };

/** Zero-projection kickoff — soul already carries dossier-fetch duty; no hand-delivered materials. */
export const AUDITOR_DOSSIER_PROMPT = "Audit the current run dossier." as const;

const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({ question: nonblank, options: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false });
// Transport must retain malformed candidates so they can settle as typed
// audit-incomplete outcomes; status values are guidance, not a schema gate.
export const complianceDecisionSchema = Type.Object({ status: Type.Unknown({ description: "Auditor decision status." }), violations: Type.Array(nonblank, { description: "Observed compliance violations." }), conflicts: Type.Array(nonblank, { description: "Unresolved authority or execution conflicts." }), decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "Escalation question and available options." }) }, { additionalProperties: true, required: [] });

export function createComplianceDecisionTool(name: string, description: string) {
  return { name, description, parameters: complianceDecisionSchema, async execute(_id: string, params: unknown): Promise<AgentToolResult<unknown>> { return { content: [{ type: "text", text: "Compliance decision received" }], details: params, terminate: true }; } };
}

export async function prepareComplianceDispatch(model: Model<Api>, context: ExtensionContext, label: string): Promise<ComplianceDispatch> {
  const resolution = await context.modelRegistry.getProviderAuth(model.provider).catch((error: unknown) => { throw new Error(`${label} authentication failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); });
  if (resolution === undefined) throw new Error(`${label} authentication failed: provider is not configured: ${model.provider}`);
  const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`${label} authentication failed: ${auth.error}`);
  const env = auth.env ?? resolution.env;
  return { model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model, auth: { ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }), ...(auth.headers === undefined ? {} : { headers: auth.headers }), ...(env === undefined ? {} : { env }) } };
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
  if (typeof arguments_ !== "object" || arguments_ === null || Array.isArray(arguments_)) return { status: "audit-incomplete", observation: { kind: "non-object-arguments", type: arguments_ === null ? "null" : Array.isArray(arguments_) ? "array" : typeof arguments_ as ComplianceArgumentRootType }, candidate: arguments_, ...(usage === undefined ? {} : { usage }) };
  const args = arguments_ as Record<string, unknown>; const status = args.status;
  if (status === "pass") return { status, ...(usage === undefined ? {} : { usage }) };
  if (status === "revise") return { status, violations: readListField(args.violations), ...(usage === undefined ? {} : { usage }) };
  if (status === "escalate") return { status, ...(Object.hasOwn(args, "conflicts") ? { conflicts: args.conflicts } : {}), ...(Object.hasOwn(args, "decisionGate") ? { decisionGate: args.decisionGate } : {}), ...(usage === undefined ? {} : { usage }) };
  return { status: "audit-incomplete", observation: { kind: "object-status-unreadable", status: status === undefined ? "missing" : "unknown" }, candidate: arguments_, ...(usage === undefined ? {} : { usage }) };
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
  // #339: only the real compliance-audit await leaves the outer package-owned
  // idle owner. Pre/post-audit work stays under the single outer backstop.
  return withPackageOwnedToolIdleSuspended(async () => {
    const prompt = options.serializedInput ?? AUDITOR_DOSSIER_PROMPT;
    const receipt = await executeAuditorChild({
      tool: options.tool,
      dossierTool: createAuditorDossierTool(options.runDirectory),
      systemPrompt: options.systemPrompt,
      prompt,
      roleLabel: options.roleLabel,
      context: options.context,
      retainResponse: (response) => retainComplianceResponse(options.context, response),
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
  });
}
