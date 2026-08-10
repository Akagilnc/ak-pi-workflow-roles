import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runAuditorRole, type AuditorCompletion } from "./auditor-role.ts";

export type ComplianceCompletion = AuditorCompletion;
export type ComplianceArgumentRootType = "null" | "array" | "undefined" | "string" | "number" | "boolean" | "bigint" | "symbol" | "function";
export type ComplianceAuditObservation = { kind: "non-object-arguments"; type: ComplianceArgumentRootType } | { kind: "object-status-unreadable"; status: "missing" | "unknown" };
export type ComplianceAuditIncomplete = { status: "audit-incomplete"; observation: ComplianceAuditObservation; candidate: unknown; usage?: Usage };
export type ComplianceDecision = { status: "pass"; usage?: Usage } | { status: "revise"; violations: readonly unknown[]; usage?: Usage } | { status: "escalate"; conflicts?: unknown; decisionGate?: unknown; usage?: Usage } | ComplianceAuditIncomplete;
export type ComplianceDispatch = { model: Model<Api>; auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } };

const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({ question: nonblank, options: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false });
// Transport must retain malformed candidates so they can settle as typed
// audit-incomplete outcomes; status values are guidance, not a schema gate.
export const complianceDecisionSchema = Type.Object({ status: Type.Unknown({ description: "Auditor decision status." }), violations: Type.Array(nonblank, { description: "Observed compliance violations." }), conflicts: Type.Array(nonblank, { description: "Unresolved authority or execution conflicts." }), decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "Escalation question and available options." }) }, { additionalProperties: true, required: [] });

export function createComplianceDecisionTool(name: string, description: string) {
  return {
    name,
    description,
    parameters: complianceDecisionSchema,
    async execute(_id: string, params: unknown): Promise<AgentToolResult<unknown>> {
      return { content: [{ type: "text", text: "Compliance decision received" }], details: params, terminate: true };
    },
  };
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
type ActiveSessionResponseAppender = { appendCustomEntry(customType: string, data?: unknown): string };
function retainComplianceResponse(context: ExtensionContext, response: AssistantMessage): void {
  const manager = context.sessionManager as unknown as Partial<ActiveSessionResponseAppender> | undefined;
  if (typeof manager?.appendCustomEntry !== "function") throw new ComplianceResponseRetentionError("compliance response retention is unavailable");
  try { manager.appendCustomEntry(COMPLIANCE_RESPONSE_ENTRY_TYPE, { version: 1, response }); } catch (error) { throw new ComplianceResponseRetentionError("compliance response retention failed", { cause: error }); }
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

export async function runComplianceAudit(options: { tool: ReturnType<typeof createComplianceDecisionTool>; systemPrompt: string; serializedInput: string; roleLabel: string; invalidDecisionLabel: string; runCompletion?: ComplianceCompletion; context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision> {
  // The injected completion seam is deterministic unit infrastructure; the
  // ordinary provider path below still crosses the independent Pi role.
  if (options.runCompletion !== undefined) {
    const model = options.context.model;
    if (model === undefined) throw new Error(`${options.roleLabel} requires an active model`);
    const dispatch = await prepareComplianceDispatch(model, options.context, options.roleLabel);
    const context: Context = { systemPrompt: options.systemPrompt, messages: [{ role: "user", content: [{ type: "text", text: options.serializedInput }], timestamp: Date.now() }], tools: [options.tool] };
    const response = await options.runCompletion(dispatch.model, context, { ...dispatch.auth, ...(options.signal === undefined ? {} : { signal: options.signal }) });
    retainComplianceResponse(options.context, response);
    const call = [...response.content].reverse().find((part) => part.type === "toolCall" && part.name === options.tool.name);
    if (call === undefined || call.type !== "toolCall") throw new Error(`${options.roleLabel} exited without a readable decision receipt`);
    return readComplianceCandidate(call.arguments, response.usage);
  }
  const receipt = await runAuditorRole({ tool: options.tool, systemPrompt: options.systemPrompt, serializedInput: options.serializedInput, roleLabel: options.roleLabel, context: options.context, retainResponse: (response) => retainComplianceResponse(options.context, response), ...(options.signal === undefined ? {} : { signal: options.signal }) });
  return readComplianceCandidate(receipt.decision, receipt.response.usage);
}
