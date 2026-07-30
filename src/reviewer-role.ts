import { createHash } from "node:crypto";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { AnyCanonicalSkillBinding, CanonicalSkillBinding } from "./canonical-skill-binding.ts";
import type { ComplianceDecision } from "./compliance-transport.ts";
import { exactUtf8 } from "./exact-utf8.ts";
import {
  createReviewerDispatcher,
  parseReviewerCapabilities,
  REVIEWER_CHILD_TOOLS,
  REVIEWER_PREREQUISITES,
  type AcceptedReviewerDispatch,
  type ReviewerCapabilitiesV1,
  type ReviewerPinnedGitReader,
  type ReviewerProposalV1,
} from "./reviewer-dispatch.ts";
import { ReviewerDispatchExecutionError, type ReviewerDispatchRunResult, type ReviewerSuccessfulDispatchRunResult } from "./reviewer-agent.ts";
import { createReviewerExecutionLedger, projectAcceptedDispatch, type ReviewerExecutionRecord } from "./reviewer-execution-ledger.ts";
import { REVIEWER_OUTPUT_TOOL_NAME, validateAcceptedReviewerDetails, type ReviewerOutput } from "./package-contracts/reviewer-output.ts";

export { REVIEWER_OUTPUT_TOOL_NAME };
export type { ReviewerOutput };
export const AGENT_TOOL_NAME = "Agent";

const requestSchema = Type.Object({
  tools: Type.Array(StringEnum(REVIEWER_CHILD_TOOLS), { uniqueItems: true }),
  bashCommands: Type.Array(Type.String(), { uniqueItems: true }),
  prerequisiteOperations: Type.Array(StringEnum(REVIEWER_PREREQUISITES), { uniqueItems: true }),
}, { additionalProperties: false });
const materialSchema = Type.Object({ id: Type.String({ minLength: 1 }), repositoryPath: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const reviewerProposalSchema = Type.Object({
  version: Type.Literal(1),
  base: Type.Object({ revision: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  standardsMaterials: Type.Array(materialSchema, { minItems: 1 }),
  spec: Type.Union([
    Type.Object({ state: Type.Literal("established"), materials: Type.Array(materialSchema, { minItems: 1 }) }, { additionalProperties: false }),
    Type.Object({ state: Type.Literal("not-established"), evidence: Type.Array(materialSchema, { minItems: 1 }) }, { additionalProperties: false }),
  ]),
  required: Type.Object({ standards: requestSchema, spec: Type.Optional(requestSchema) }, { additionalProperties: false }),
}, { additionalProperties: false });
const reviewerOutputSchema = Type.Object({ status: StringEnum(["completed", "refused"] as const), report: Type.String({ minLength: 1 }) }, { additionalProperties: false });
type ReviewerOutputParameters = Static<typeof reviewerOutputSchema>;

export type ReviewerAuditInput = { soul: string; canonicalSkill: string; task: string; record: ReviewerExecutionRecord; candidate: ReviewerOutput };
export type ReviewerRoleDependencies = {
  loadSoul(): Promise<string>;
  loadTask(path: string): Promise<Uint8Array>;
  loadCapabilities(path: string): Promise<Uint8Array>;
  loadCanonicalSkillBinding(name: "code-review"): Promise<AnyCanonicalSkillBinding>;
  createPinnedGitReader(): Promise<ReviewerPinnedGitReader>;
  hostTools(): readonly string[];
  runDispatch(dispatch: AcceptedReviewerDispatch, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ReviewerDispatchRunResult>;
  shutdownAgent?(): Promise<void>;
  auditCompliance(input: ReviewerAuditInput, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision>;
};
export type ReviewerRoleHostActions = { failInfrastructure(error: unknown, ctx: ExtensionContext): never };

export function validateReviewerOutput(output: ReviewerOutputParameters): ReviewerOutput { return validateAcceptedReviewerDetails(output); }
function singleton(id: string, ctx: ExtensionContext): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") throw new Error("Reviewer output must be the sole final tool call");
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0]?.id !== id || calls[0]?.name !== REVIEWER_OUTPUT_TOOL_NAME) throw new Error("Reviewer output must be the sole final tool call");
}

export function createReviewerRoleRuntime(pi: ExtensionAPI, dependencies: ReviewerRoleDependencies, hostActions: ReviewerRoleHostActions): { activate(ctx?: ExtensionContext): Promise<void> } {
  let soul: string | undefined;
  let taskBytes: Uint8Array | undefined;
  let task: string | undefined;
  let capabilities: ReviewerCapabilitiesV1 | undefined;
  let binding: CanonicalSkillBinding<"code-review"> | undefined;
  let reader: ReviewerPinnedGitReader | undefined;
  let dispatcher: ReturnType<typeof createReviewerDispatcher> | undefined;
  let originalRequest: string | undefined;
  let expansionCaptured = false;
  let registered = false;
  const ledger = createReviewerExecutionLedger();
  const pendingTransport = new Map<string, string>();
  const admittedToolCalls = new Set<string>();

  const handleTransportTerminal = (event: { toolCallId: string; isError: boolean }) => {
    const identity = pendingTransport.get(event.toolCallId);
    pendingTransport.delete(event.toolCallId);
    const admitted = admittedToolCalls.delete(event.toolCallId);
    if (identity !== undefined && event.isError && !admitted) {
      ledger.append({ source: "reviewer-transport", type: "transport-rejected", identity, violation: "schema", started: false });
    }
  };

  pi.registerFlag("ak-review-task", { description: "Opaque Markdown review task assigned to the reviewer role", type: "string" });
  pi.registerFlag("ak-review-capabilities", { description: "Closed Reviewer capability grant bound to the exact task bytes", type: "string" });

  return { async activate(ctx) {
    soul = (await dependencies.loadSoul()).trim();
    if (!soul) throw new Error("Reviewer soul is empty");
    const taskPath = pi.getFlag("ak-review-task");
    const capabilityPath = pi.getFlag("ak-review-capabilities");
    if (typeof taskPath !== "string" || !taskPath.trim()) throw new Error("Reviewer role requires --ak-review-task");
    if (typeof capabilityPath !== "string" || !capabilityPath.trim()) throw new Error("Reviewer role requires --ak-review-capabilities");
    taskBytes = Uint8Array.from(await dependencies.loadTask(taskPath));
    task = exactUtf8(taskBytes, "Reviewer task");
    if (!task.trim()) throw new Error("Reviewer task is empty");
    capabilities = parseReviewerCapabilities(await dependencies.loadCapabilities(capabilityPath), taskBytes);
    if (!capabilities.prerequisiteOperations.includes("preflight.git.pin-target")) {
      throw new Error("Missing preflight prerequisite: preflight.git.pin-target");
    }
    const loaded = await dependencies.loadCanonicalSkillBinding("code-review");
    if (loaded.name !== "code-review") throw new Error("Canonical Skill binding loader returned tdd for code-review");
    binding = loaded;
    reader = await dependencies.createPinnedGitReader();

    const run = async (dispatch: AcceptedReviewerDispatch, invocation: unknown): Promise<ReviewerDispatchRunResult> => {
      const { context, signal } = invocation as { context: ExtensionContext; signal?: AbortSignal };
      ledger.append(projectAcceptedDispatch(dispatch));
      ledger.append({ source: "reviewer-agent", type: "dispatch-started", dispatchIdentity: dispatch.identity, cardinality: dispatch.legs.length as 1 | 2 });
      const appendSettlements = (result: ReviewerDispatchRunResult) => {
        for (const leg of dispatch.legs) {
          const actual = result.legs[leg.axis];
          if (actual === undefined) throw new Error(`Reviewer runner omitted ${leg.axis} result`);
          ledger.append(actual.status === "failed"
            ? { source: "reviewer-agent", type: "leg-settled", dispatchIdentity: dispatch.identity, axis: leg.axis, status: "failed", prompt: actual.prompt, target: actual.target, failure: actual.failure, workspaceDisposition: actual.workspaceDisposition }
            : { source: "reviewer-agent", type: "leg-settled", dispatchIdentity: dispatch.identity, axis: leg.axis, status: "successful", prompt: actual.prompt, target: actual.target, report: actual.report, usage: actual.usage, workspaceDisposition: actual.workspaceDisposition });
        }
      };
      try {
        const result = await dependencies.runDispatch(dispatch, { context, ...(signal === undefined ? {} : { signal }) });
        appendSettlements(result);
        return result;
      } catch (error) {
        if (error instanceof ReviewerDispatchExecutionError) appendSettlements(error.outcome);
        throw ledger.recordInfrastructureFailure(error);
      }
    };
    dispatcher = createReviewerDispatcher({ task: taskBytes, canonicalSkill: binding.snapshot.raw, capabilities, reader, hostTools: dependencies.hostTools(), run });

    if (!registered) {
      registered = true;
      pi.registerTool({ name: AGENT_TOOL_NAME, label: "Reviewer Dispatch", description: "Validate and irreversibly run one atomic Reviewer proposal.", promptSnippet: "Propose the atomic Reviewer dispatch", promptGuidelines: ["Correct rejected proposals; an accepted proposal is irreversible."], parameters: reviewerProposalSchema,
        async execute(_id, proposal, signal, _update, toolCtx) {
          admittedToolCalls.add(_id);
          let result;
          try { result = await dispatcher!.propose(proposal as ReviewerProposalV1, { context: toolCtx, ...(signal === undefined ? {} : { signal }) }); }
          catch (error) { hostActions.failInfrastructure(error, toolCtx); }
          if (result.status === "rejected") ledger.append({ source: "reviewer-dispatch", type: "rejected", identity: result.identity, violations: result.violations, started: false });
          if (result.status === "closed") ledger.append({ source: "reviewer-dispatch", type: "closed-attempt", identity: result.identity, reason: result.reason, started: false });
          const text = result.status === "rejected"
            ? `Reviewer proposal rejected: ${result.violations.join("; ")}`
            : result.status === "closed"
              ? "Reviewer dispatch is already closed"
              : result.dispatch.legs.map((leg) => {
                const settled = (result.results as ReviewerSuccessfulDispatchRunResult).legs[leg.axis]!;
                return [
                  `<<< REVIEWER CHILD REPORT axis=${leg.axis} prompt=${JSON.stringify(settled.prompt)} >>>`,
                  settled.report,
                  `<<< END REVIEWER CHILD REPORT axis=${leg.axis} >>>`,
                ].join("\n");
              }).join("\n");
          return { content: [{ type: "text" as const, text }], details: result };
        } });
      pi.registerTool({ name: REVIEWER_OUTPUT_TOOL_NAME, label: "Reviewer Output", description: "Submit the thin Reviewer receipt after semantic compliance audit.", promptSnippet: "Submit the final Reviewer receipt", promptGuidelines: [`Use ${REVIEWER_OUTPUT_TOOL_NAME} as the sole final action.`], parameters: reviewerOutputSchema,
        async execute(id, parameters, signal, _update, toolCtx) {
          if (!soul || task === undefined || !binding) throw new Error("Reviewer inputs were not loaded");
          singleton(id, toolCtx);
          const output = validateReviewerOutput(parameters);
          if (output.status === "completed" && !expansionCaptured) throw new Error("Reviewer completed requires canonical Skill expansion capture");
          let record: ReviewerExecutionRecord;
          try { record = ledger.recordForAudit(output.status); } catch (error) { if ((error as any)?.fatalReviewerInfrastructure) hostActions.failInfrastructure(error, toolCtx); throw error; }
          let audit: ComplianceDecision;
          try { audit = await dependencies.auditCompliance({ soul, canonicalSkill: binding.snapshot.raw, task, record, candidate: output }, { context: toolCtx, ...(signal === undefined ? {} : { signal }) }); }
          catch (error) { hostActions.failInfrastructure(ledger.recordInfrastructureFailure(error), toolCtx); }
          if (audit.status === "revise") throw new Error(`Reviewer receipt violates its method: ${audit.violations.join("; ")}`);
          try { await dependencies.shutdownAgent?.(); } catch (error) { hostActions.failInfrastructure(ledger.recordInfrastructureFailure(error), toolCtx); }
          return { content: [{ type: "text" as const, text: "Reviewer report accepted" }], details: output, terminate: true as const, ...(audit.usage === undefined ? {} : { usage: audit.usage }) };
        } });
      pi.on("tool_execution_start", (event) => {
        if (event.toolName !== AGENT_TOOL_NAME) return;
        const encoded = JSON.stringify(event.args) ?? "undefined";
        pendingTransport.set(event.toolCallId, `transport-${createHash("sha256").update(encoded).digest("hex")}`);
      });
      pi.on("tool_execution_end", handleTransportTerminal);
      pi.on("tool_result", handleTransportTerminal);
      pi.on("input", (event) => { if (originalRequest !== undefined) return { action: "continue" as const }; originalRequest = event.text; return { action: "transform" as const, text: binding!.invocation(event.text), ...(event.images === undefined ? {} : { images: event.images }) }; });
      pi.on("before_agent_start", (event, toolCtx) => {
        if (!expansionCaptured) {
          if (originalRequest === undefined || binding!.captureExpansion(event.prompt, originalRequest) === undefined) {
            const error = ledger.recordInfrastructureFailure(new Error("Canonical code-review Skill expansion did not match the captured request"));
            hostActions.failInfrastructure(error, toolCtx);
          }
          expansionCaptured = true;
        }
        return { systemPrompt: `${event.systemPrompt}\n\n<reviewer_soul>\n${soul}\n</reviewer_soul>\n\n<review_task>\n${task}\n</review_task>` };
      });
      pi.on("session_shutdown", async () => { try { await dependencies.shutdownAgent?.(); } catch (error) { throw ledger.recordInfrastructureFailure(error); } });
    }
    const available = new Set(pi.getAllTools().map((tool) => tool.name));
    pi.setActiveTools([AGENT_TOOL_NAME, REVIEWER_OUTPUT_TOOL_NAME].filter((name) => available.has(name)));
  } };
}
