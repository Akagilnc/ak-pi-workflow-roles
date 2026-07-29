import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type {
  AnyCanonicalSkillBinding,
  CanonicalSkillBinding,
} from "./canonical-skill-binding.ts";
import type { ComplianceDecision } from "./compliance-transport.ts";
import {
  createReviewerExecutionLedger,
  type ReviewerAgentAttempt,
  type ReviewerAgentPersistedEvidence,
  type ReviewerAgentResult,
  type ReviewerExecutionRecord,
} from "./reviewer-execution-ledger.ts";
import {
  REVIEWER_OUTPUT_TOOL_NAME,
  validateAcceptedReviewerDetails,
  type ReviewerOutput,
} from "./package-contracts/reviewer-output.ts";

export { REVIEWER_OUTPUT_TOOL_NAME };
export type { ReviewerOutput };
export const AGENT_TOOL_NAME = "Agent";

const reviewerOutputSchema = Type.Object(
  {
    status: StringEnum(["completed", "refused"] as const),
    report: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

const reviewerAgentSchema = Type.Object(
  {
    subagent_type: StringEnum(["general-purpose"] as const),
    description: Type.String({ minLength: 1 }),
    prompt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

type ReviewerOutputParameters = Static<typeof reviewerOutputSchema>;
export type ReviewerAuditInput = {
  soul: string;
  canonicalSkill: string;
  task: string;
  record: ReviewerExecutionRecord;
  candidate: ReviewerOutput;
};

export type ReviewerRoleDependencies = {
  loadSoul(): Promise<string>;
  loadTask(path: string): Promise<string>;
  loadCanonicalSkillBinding(
    name: "code-review",
  ): Promise<AnyCanonicalSkillBinding>;
  runAgent(
    input: { description: string; prompt: string },
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<ReviewerAgentResult>;
  shutdownAgent?(): Promise<void>;
  auditCompliance(
    input: ReviewerAuditInput,
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<ComplianceDecision>;
};

export type ReviewerRoleHostActions = {
  failInfrastructure(error: unknown, ctx: ExtensionContext): never;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

export function validateReviewerOutput(
  output: ReviewerOutputParameters,
): ReviewerOutput {
  return validateAcceptedReviewerDetails(output);
}

function requireSingletonSubmissionCall(
  toolCallId: string,
  ctx: ExtensionContext,
): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") {
    throw new Error("Reviewer output must be the sole final tool call");
  }
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  const call = calls[0];
  if (
    calls.length !== 1 || call === undefined || call.id !== toolCallId ||
    call.name !== REVIEWER_OUTPUT_TOOL_NAME
  ) {
    throw new Error("Reviewer output must be the sole final tool call");
  }
}

function reviewerAgentPersistedEvidence(
  ctx: ExtensionContext,
): ReviewerAgentPersistedEvidence {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf === undefined) return { kind: "unavailable" };
  if (leaf.type !== "message" || leaf.message.role !== "assistant") {
    return { kind: "non-assistant" };
  }
  return {
    kind: "assistant",
    entryId: leaf.id,
    calls: leaf.message.content.flatMap((part) =>
      part.type === "toolCall" && part.name === AGENT_TOOL_NAME
        ? [{ id: part.id, arguments: part.arguments }]
        : []
    ),
  };
}

function toolExecutionDiagnostic(result: unknown): string {
  if (isRecord(result) && Array.isArray(result["content"])) {
    const text = result["content"]
      .filter(
        (part): part is { type: "text"; text: string } =>
          isRecord(part) && part["type"] === "text" &&
          typeof part["text"] === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return typeof result === "string" ? result : String(result);
}

export function createReviewerRoleRuntime(
  pi: ExtensionAPI,
  dependencies: ReviewerRoleDependencies,
  hostActions: ReviewerRoleHostActions,
): { activate(ctx?: ExtensionContext): Promise<void> } {
  let soul: string | undefined;
  let task: string | undefined;
  let binding: CanonicalSkillBinding<"code-review"> | undefined;
  let originalRequest: string | undefined;
  let expansionPending = false;
  let lifecycleRegistered = false;
  const ledger = createReviewerExecutionLedger();

  pi.registerFlag("ak-review-task", {
    description: "Opaque Markdown review task assigned to the reviewer role",
    type: "string",
  });

  return {
    async activate(ctx) {
      soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Reviewer soul is empty");
      const taskPath = pi.getFlag("ak-review-task");
      if (typeof taskPath !== "string" || taskPath.trim().length === 0) {
        throw new Error("Reviewer role requires --ak-review-task");
      }
      const loadedTask = await dependencies.loadTask(taskPath);
      if (loadedTask.trim().length === 0) throw new Error("Reviewer task is empty");
      task = loadedTask;
      try {
        const loadedBinding = await dependencies.loadCanonicalSkillBinding(
          "code-review",
        );
        if (loadedBinding.name !== "code-review") {
          throw new Error(
            "Canonical Skill binding loader returned tdd for code-review",
          );
        }
        binding = loadedBinding;
      } catch (error) {
        if (ctx === undefined) throw error;
        hostActions.failInfrastructure(error, ctx);
      }

      if (!lifecycleRegistered) {
        lifecycleRegistered = true;
        pi.registerTool({
          name: AGENT_TOOL_NAME,
          label: "Agent",
          description:
            "Run one general-purpose review leg in an isolated writable clone at the pinned reviewed target.",
          promptSnippet: "Run an isolated review leg",
          promptGuidelines: [
            "Use Agent for the independent review legs required by the expanded canonical code-review Skill.",
          ],
          parameters: reviewerAgentSchema,
          executionMode: "parallel" as const,
          async execute(toolCallId, parameters, signal, _onUpdate, ctx) {
            if (task === undefined || binding === undefined) {
              throw new Error("Reviewer task and canonical Skill were not loaded");
            }
            try {
              ledger.beginAgentCall(
                toolCallId,
                parameters,
                reviewerAgentPersistedEvidence(ctx),
              );
            } catch (error) {
              hostActions.failInfrastructure(error, ctx);
            }
            let result: ReviewerAgentResult;
            let details: ReviewerAgentAttempt;
            try {
              result = await dependencies.runAgent(
                {
                  description: parameters.description,
                  prompt: parameters.prompt,
                },
                signal === undefined
                  ? { context: ctx }
                  : { context: ctx, signal },
              );
              details = ledger.completeAgentCall(toolCallId, result);
            } catch (error) {
              hostActions.failInfrastructure(
                ledger.failAgentCall(toolCallId, error),
                ctx,
              );
            }
            return {
              content: [{ type: "text" as const, text: result.report }],
              details,
              ...(result.usage === undefined ? {} : { usage: result.usage }),
            };
          },
        });

        pi.registerTool({
          name: REVIEWER_OUTPUT_TOOL_NAME,
          label: "Reviewer Output",
          description:
            "Submit the completed review or an evidence-bearing refusal. Method compliance is audited before acceptance.",
          promptSnippet: "Submit the final Reviewer receipt",
          promptGuidelines: [
            `Use ${REVIEWER_OUTPUT_TOOL_NAME} as the sole final action for the reviewer role.`,
          ],
          parameters: reviewerOutputSchema,
          async execute(toolCallId, parameters, signal, _onUpdate, ctx) {
            if (soul === undefined || task === undefined || binding === undefined) {
              throw new Error("Reviewer inputs were not loaded");
            }
            requireSingletonSubmissionCall(toolCallId, ctx);
            const output = validateReviewerOutput(parameters);
            let record: ReviewerExecutionRecord;
            try {
              record = ledger.recordForAudit(output.status);
            } catch (error) {
              if (
                isRecord(error) && error["fatalReviewerInfrastructure"] === true
              ) {
                hostActions.failInfrastructure(error, ctx);
              }
              throw error;
            }
            let audit: ComplianceDecision;
            try {
              audit = await dependencies.auditCompliance(
                {
                  soul,
                  canonicalSkill: binding.snapshot.raw,
                  task,
                  record,
                  candidate: output,
                },
                signal === undefined
                  ? { context: ctx }
                  : { context: ctx, signal },
              );
            } catch (error) {
              hostActions.failInfrastructure(
                ledger.recordInfrastructureFailure(error),
                ctx,
              );
            }
            if (audit.status === "revise") {
              throw new Error(
                `Reviewer receipt violates its method: ${audit.violations.join("; ")}`,
              );
            }
            try {
              await dependencies.shutdownAgent?.();
            } catch (error) {
              hostActions.failInfrastructure(
                ledger.recordInfrastructureFailure(error),
                ctx,
              );
            }
            return {
              content: [{ type: "text" as const, text: "Reviewer report accepted" }],
              details: output,
              terminate: true as const,
              ...(audit.usage === undefined ? {} : { usage: audit.usage }),
            };
          },
        });

        pi.on("input", (event) => {
          if (originalRequest !== undefined) {
            return { action: "continue" as const };
          }
          originalRequest = event.text;
          expansionPending = true;
          return {
            action: "transform" as const,
            text: binding?.invocation(event.text) ??
              `/skill:code-review ${event.text}`,
            ...(event.images === undefined ? {} : { images: event.images }),
          };
        });

        pi.on("tool_execution_start", (event, ctx) => {
          if (event.toolName !== AGENT_TOOL_NAME) return;
          try {
            ledger.beginAgentCall(
              event.toolCallId,
              event.args,
              reviewerAgentPersistedEvidence(ctx),
            );
          } catch (error) {
            hostActions.failInfrastructure(error, ctx);
          }
        });

        pi.on("tool_execution_end", (event) => {
          if (event.toolName !== AGENT_TOOL_NAME || !event.isError) return;
          ledger.rejectAgentCall(
            event.toolCallId,
            toolExecutionDiagnostic(event.result),
          );
        });

        pi.on("tool_call", (event) => {
          if (
            event.toolName === "bash" &&
            typeof event.input["command"] === "string"
          ) {
            ledger.recordBashCall(event.toolCallId, event.input["command"]);
          }
        });

        pi.on("tool_result", (event) => {
          if (event.toolName !== "bash") return;
          ledger.recordBashResult(
            event.toolCallId,
            event.content.filter((part) => part.type === "text")
              .map((part) => part.text)
              .join("\n"),
            event.isError,
          );
        });

        pi.on("session_shutdown", async () => {
          try {
            await dependencies.shutdownAgent?.();
          } catch (error) {
            throw ledger.recordInfrastructureFailure(error);
          }
        });

        pi.on("before_agent_start", (event, ctx) => {
          if (soul === undefined) throw new Error("Reviewer soul was not loaded");
          if (expansionPending) {
            expansionPending = false;
            try {
              if (binding === undefined || originalRequest === undefined) {
                throw new Error(
                  "Reviewer canonical Skill binding was not initialized",
                );
              }
              const evidence = binding.captureExpansion(
                event.prompt,
                originalRequest,
              );
              if (evidence === undefined) {
                throw new Error(
                  "Reviewer first prompt did not contain the canonical native code-review Skill expansion",
                );
              }
              ledger.recordSkillExpansion(evidence);
            } catch (error) {
              hostActions.failInfrastructure(
                ledger.recordInfrastructureFailure(error),
                ctx,
              );
            }
          }
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<reviewer_soul>\n${soul}\n</reviewer_soul>\n\n<review_task>\n${task ?? ""}\n</review_task>`,
          };
        });
      }

      const registeredTools = new Set(pi.getAllTools().map((tool) => tool.name));
      pi.setActiveTools(
        [
          "read",
          "grep",
          "find",
          "ls",
          "bash",
          AGENT_TOOL_NAME,
          REVIEWER_OUTPUT_TOOL_NAME,
        ].filter((name) => registeredTools.has(name)),
      );
    },
  };
}
