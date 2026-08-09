import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runAuditorRole, type AuditorCompletion } from "./auditor-role.ts";
import { COMPLIANCE_RESPONSE_ENTRY_TYPE, readComplianceCandidate, type ComplianceDecision } from "./compliance-decision.ts";
export { COMPLIANCE_RESPONSE_ENTRY_TYPE, readComplianceCandidate } from "./compliance-decision.ts";
export type { ComplianceArgumentRootType, ComplianceAuditIncomplete, ComplianceAuditObservation, ComplianceDecision } from "./compliance-decision.ts";

export type ComplianceCompletion = AuditorCompletion;
export type ComplianceDispatch = { model: Model<Api>; auth: { apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> } };

const nonblank = Type.String({ minLength: 1, pattern: "\\S" });
const decisionGateSchema = Type.Object({ question: nonblank, options: Type.Array(nonblank, { minItems: 1 }) }, { additionalProperties: false });
export const complianceDecisionSchema = Type.Object({ status: Type.Union([Type.Literal("pass"), Type.Literal("revise"), Type.Literal("escalate")], { description: "Auditor decision status." }), violations: Type.Array(nonblank, { description: "Observed compliance violations." }), conflicts: Type.Array(nonblank, { description: "Unresolved authority or execution conflicts." }), decisionGate: Type.Union([decisionGateSchema, Type.Null()], { description: "Escalation question and available options." }) }, { additionalProperties: true, required: [] });

export function createComplianceDecisionTool(name: string, description: string) {
  return { name, description, parameters: complianceDecisionSchema, async execute(_id: string, params: unknown): Promise<AgentToolResult<unknown>> { return { content: [{ type: "text", text: "Compliance decision received" }], details: params, terminate: true }; } };
}

export async function prepareComplianceDispatch(model: Model<Api>, context: ExtensionContext, label: string): Promise<ComplianceDispatch> {
  const resolution = await context.modelRegistry.getProviderAuth(model.provider).catch((error: unknown) => { throw new Error(`${label} authentication failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); });
  if (resolution === undefined) throw new Error(`${label} authentication failed: provider is not configured: ${model.provider}`);
  const auth = await context.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) throw new Error(`${label} authentication failed: ${auth.error}`);
  return { model: resolution.auth.baseUrl ? { ...model, baseUrl: resolution.auth.baseUrl } : model, auth: { ...(auth.apiKey === undefined ? {} : { apiKey: auth.apiKey }), ...(auth.headers === undefined ? {} : { headers: auth.headers }), ...(auth.env === undefined ? {} : { env: auth.env }) } };
}

export class ComplianceResponseRetentionError extends Error {
  constructor(message: string, options?: ErrorOptions) { super(message, options); this.name = "ComplianceResponseRetentionError"; }
}
type ActiveSessionResponseAppender = { appendCustomEntry(customType: string, data?: unknown): string };
function retainComplianceResponse(context: ExtensionContext, response: AssistantMessage): void {
  const manager = context.sessionManager as unknown as Partial<ActiveSessionResponseAppender> | undefined;
  if (typeof manager?.appendCustomEntry !== "function") throw new ComplianceResponseRetentionError("compliance response retention is unavailable");
  try { manager.appendCustomEntry(COMPLIANCE_RESPONSE_ENTRY_TYPE, { version: 1, response }); } catch (error) { throw new ComplianceResponseRetentionError("compliance response retention failed", { cause: error }); }
}
export async function runComplianceAudit(options: { tool: ReturnType<typeof createComplianceDecisionTool>; systemPrompt: string; serializedInput: string; roleLabel: string; invalidDecisionLabel: string; runCompletion?: ComplianceCompletion; context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision> {
  const receipt = await runAuditorRole({ tool: options.tool, systemPrompt: options.systemPrompt, serializedInput: options.serializedInput, roleLabel: options.roleLabel, context: options.context, ...(options.signal === undefined ? {} : { signal: options.signal }), ...(options.runCompletion === undefined ? {} : { runCompletion: options.runCompletion }) });
  retainComplianceResponse(options.context, receipt.response);
  return readComplianceCandidate(receipt.decision, receipt.response.usage);
}
