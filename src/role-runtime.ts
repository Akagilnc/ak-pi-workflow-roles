import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type { ComplianceDecision } from "./compliance-transport.ts";
import {
  createReviewerExecutionLedger,
  type ReviewerAgentAttempt,
  type ReviewerAgentPersistedEvidence,
  type ReviewerAgentResult,
  type ReviewerExecutionRecord,
} from "./reviewer-execution-ledger.ts";
export type {
  ReviewerAgentAttempt,
  ReviewerAgentInvocationBatch,
  ReviewerAgentResult,
  ReviewerBashEvidence,
  ReviewerExecutionRecord,
  ReviewerTargetSnapshot,
  ReviewerWorkspaceDisposition,
} from "./reviewer-execution-ledger.ts";
import type { CanonicalReviewerSkill } from "./reviewer-skill.ts";
import { captureCanonicalReviewerSkillExpansion } from "./reviewer-skill.ts";

export const JUDGE_OUTPUT_TOOL_NAME = "ak_judge_output";
export const FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";
export const CODER_OUTPUT_TOOL_NAME = "ak_coder_output";
export const REVIEWER_OUTPUT_TOOL_NAME = "ak_reviewer_output";
export const AGENT_TOOL_NAME = "Agent";

const judgeVerdictSchema = Type.Object(
  {
    judgeStatus: StringEnum(["converged", "continue", "escalate"] as const),
    fix: Type.Optional(
      Type.Object(
        { summary: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
    note: Type.Optional(Type.String({ minLength: 1 })),
    decisionGate: Type.Optional(
      Type.Object(
        {
          question: Type.String({ minLength: 1 }),
          options: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

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

const workerOutputSchema = Type.Object(
  {
    status: StringEnum(["planned", "completed", "refused"] as const),
    report: Type.String({ minLength: 1 }),
    commitSha: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

type JudgeVerdictParameters = Static<typeof judgeVerdictSchema>;
type WorkerOutputParameters = Static<typeof workerOutputSchema>;
type ReviewerOutputParameters = Static<typeof reviewerOutputSchema>;

export type WorkerOutput = {
  status: "planned" | "completed" | "refused";
  report: string;
  commitSha?: string;
};

export type FixerOutput = WorkerOutput;
export type CoderOutput = WorkerOutput;
export type ReviewerOutput = {
  status: "completed" | "refused";
  report: string;
};

export type ReviewerAuditInput = {
  soul: string;
  canonicalSkill: string;
  task: string;
  record: ReviewerExecutionRecord;
  candidate: ReviewerOutput;
};

type AdvisoryNote = { note?: string };

export type JudgeVerdict = AdvisoryNote &
  (
    | { judgeStatus: "converged" }
    | { judgeStatus: "continue"; fix: { summary: string } }
    | {
        judgeStatus: "escalate";
        decisionGate: { question: string; options: string[] };
      }
  );

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type WorkerPhase = "plan" | "apply";
type WorkerRoleLabel = "Coder" | "Fixer";

function validateWorkerOutput(
  output: WorkerOutputParameters,
  phase: WorkerPhase,
  roleLabel: WorkerRoleLabel,
): WorkerOutput {
  if (!isRecord(output)) {
    throw new Error(`${roleLabel} output must be an object`);
  }
  const expectedKeys =
    output.commitSha === undefined
      ? ["status", "report"]
      : ["status", "report", "commitSha"];
  if (
    !hasExactKeys(output, expectedKeys) ||
    (output.status !== "planned" &&
      output.status !== "completed" &&
      output.status !== "refused") ||
    typeof output.report !== "string" ||
    output.report.trim().length === 0 ||
    (output.commitSha !== undefined &&
      (typeof output.commitSha !== "string" ||
        output.commitSha.trim().length === 0))
  ) {
    throw new Error(
      `${roleLabel} output requires planned|completed|refused, a non-blank report, and an optional non-blank commitSha`,
    );
  }
  if (phase === "plan" && output.status === "completed") {
    throw new Error(`${roleLabel} plan phase permits only planned or refused`);
  }
  if (phase === "apply" && output.status === "planned") {
    throw new Error(`${roleLabel} apply phase permits only completed or refused`);
  }
  if (output.status === "planned" && output.commitSha !== undefined) {
    throw new Error(`${roleLabel} planned output forbids commitSha`);
  }
  return {
    status: output.status,
    report: output.report,
    ...(output.commitSha === undefined ? {} : { commitSha: output.commitSha }),
  };
}

function validateReviewerOutput(
  output: ReviewerOutputParameters,
): ReviewerOutput {
  if (
    !isRecord(output) ||
    !hasExactKeys(output, ["status", "report"]) ||
    (output.status !== "completed" && output.status !== "refused") ||
    typeof output.report !== "string" ||
    output.report.trim().length === 0
  ) {
    throw new Error(
      "Reviewer output requires only completed|refused and a non-blank Markdown report",
    );
  }
  return { status: output.status, report: output.report };
}

function validateVerdict(verdict: JudgeVerdictParameters): JudgeVerdict {
  if (!isRecord(verdict)) {
    throw new Error("Judge verdict must be an object");
  }
  if (
    verdict.note !== undefined &&
    (typeof verdict.note !== "string" || verdict.note.trim().length === 0)
  ) {
    throw new Error("Judge note must be a non-blank string when provided");
  }
  const withOptionalNote = (keys: string[]): string[] =>
    verdict.note === undefined ? keys : [...keys, "note"];
  const note = verdict.note === undefined ? {} : { note: verdict.note };

  if (verdict.judgeStatus === "converged") {
    if (!hasExactKeys(verdict, withOptionalNote(["judgeStatus"]))) {
      throw new Error("Judge converged forbids fix and decisionGate");
    }
    return { judgeStatus: "converged", ...note };
  }

  if (verdict.judgeStatus === "continue") {
    if (
      !hasExactKeys(verdict, withOptionalNote(["judgeStatus", "fix"])) ||
      !isRecord(verdict.fix) ||
      !hasExactKeys(verdict.fix, ["summary"]) ||
      typeof verdict.fix.summary !== "string" ||
      verdict.fix.summary.trim().length === 0
    ) {
      throw new Error(
        "Judge continue requires only a non-blank fix.summary",
      );
    }
    return {
      judgeStatus: "continue",
      fix: { summary: verdict.fix.summary },
      ...note,
    };
  }

  if (verdict.judgeStatus === "escalate") {
    const gate = verdict.decisionGate;
    if (
      !hasExactKeys(
        verdict,
        withOptionalNote(["judgeStatus", "decisionGate"]),
      ) ||
      !isRecord(gate) ||
      !hasExactKeys(gate, ["question", "options"]) ||
      typeof gate.question !== "string" ||
      gate.question.trim().length === 0 ||
      !Array.isArray(gate.options) ||
      gate.options.length === 0 ||
      !gate.options.every(
        (option) =>
          typeof option === "string" && option.trim().length > 0,
      )
    ) {
      throw new Error(
        "Judge escalate requires only a non-blank decisionGate question and options",
      );
    }
    return {
      judgeStatus: "escalate",
      decisionGate: { question: gate.question, options: [...gate.options] },
      ...note,
    };
  }

  throw new Error("Judge verdict has an invalid status");
}

function requireSingletonSubmissionCall(
  toolCallId: string,
  expectedToolName: string,
  roleLabel: "Judge" | WorkerRoleLabel | "Reviewer",
  ctx: ExtensionContext,
): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") {
    throw new Error(`${roleLabel} output must be the sole final tool call`);
  }
  const calls = leaf.message.content.filter(
    (part) => part.type === "toolCall",
  );
  const call = calls[0];
  if (
    calls.length !== 1 ||
    call === undefined ||
    call.id !== toolCallId ||
    call.name !== expectedToolName
  ) {
    throw new Error(`${roleLabel} output must be the sole final tool call`);
  }
}

export type SoulAuditInput = {
  soul: string;
  transcript: string;
  verdict: JudgeVerdict;
};

export type SoulAuditResult =
  | { status: "pass"; usage?: Usage }
  | { status: "revise"; violations: readonly string[]; usage?: Usage };

export type RoleRuntimeDependencies = {
  loadJudgeSoul(): Promise<string>;
  loadFixerSoul?(): Promise<string>;
  loadFixPacket?(path: string): Promise<string>;
  loadCoderSoul?(): Promise<string>;
  loadCoderTask?(path: string): Promise<string>;
  loadReviewerSoul?(): Promise<string>;
  loadReviewerTask?(path: string): Promise<string>;
  loadCanonicalReviewerSkill?(): Promise<CanonicalReviewerSkill>;
  runReviewerAgent?(
    input: {
      description: string;
      prompt: string;
    },
    options: {
      context: ExtensionContext;
      signal?: AbortSignal;
    },
  ): Promise<ReviewerAgentResult>;
  shutdownReviewerAgent?(): Promise<void>;
  transcriptFromContext(ctx: ExtensionContext): string;
  auditSoulCompliance(
    input: SoulAuditInput,
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<SoulAuditResult>;
  auditReviewerCompliance?(
    input: ReviewerAuditInput,
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<ComplianceDecision>;
};

function failInfrastructure(error: unknown, ctx: ExtensionContext): never {
  ctx.abort();
  if (ctx.mode === "print" || ctx.mode === "json") {
    process.exitCode = 1;
  }
  throw error;
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
        : [],
    ),
  };
}

function toolExecutionDiagnostic(result: unknown): string {
  if (isRecord(result) && Array.isArray(result["content"])) {
    const text = result["content"]
      .filter(
        (part): part is { type: "text"; text: string } =>
          isRecord(part) &&
          part["type"] === "text" &&
          typeof part["text"] === "string",
      )
      .map((part) => part.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return typeof result === "string" ? result : String(result);
}

export function createRoleRuntimeExtension(
  dependencies: RoleRuntimeDependencies,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    let activeSoul: string | undefined;
    let activeFixPacket: string | undefined;
    let activeFixerPhase: WorkerPhase | undefined;
    let activeCoderTask: string | undefined;
    let activeCoderPhase: WorkerPhase | undefined;
    let coderTddInvocationInjected = false;
    let activeReviewerTask: string | undefined;
    let activeReviewerSkill: CanonicalReviewerSkill | undefined;
    let reviewerOriginalRequest: string | undefined;
    let reviewerExpansionPending = false;
    const reviewerLedger = createReviewerExecutionLedger();
    let activeRole: "judge" | "fixer" | "coder" | "reviewer" | undefined;
    let judgeToolRegistered = false;
    let fixerToolRegistered = false;
    let coderToolRegistered = false;
    let reviewerToolsRegistered = false;

    pi.registerFlag("ak-role", {
      description:
        "Activate a packaged workflow role: judge, fixer, coder, or reviewer",
      type: "string",
    });
    pi.registerFlag("ak-fix-packet", {
      description: "Markdown repair packet assigned to the fixer role",
      type: "string",
    });
    pi.registerFlag("ak-fixer-phase", {
      description:
        "Fixer phase: plan (inspect and propose a repair plan; no edits or commits) or apply (execute the approved plan, verify, and commit when repaired)",
      type: "string",
    });
    pi.registerFlag("ak-coder-task", {
      description: "Markdown task assigned to the coder role",
      type: "string",
    });
    pi.registerFlag("ak-coder-phase", {
      description:
        "Coder phase: plan (inspect and propose an implementation plan; no edits or commits) or apply (execute the approved plan and verify the first implementation)",
      type: "string",
    });
    pi.registerFlag("ak-review-task", {
      description: "Opaque Markdown review task assigned to the reviewer role",
      type: "string",
    });

    pi.on("session_start", async () => {
      const role = pi.getFlag("ak-role");
      if (role === undefined) return;
      if (
        role !== "judge" &&
        role !== "fixer" &&
        role !== "coder" &&
        role !== "reviewer"
      ) {
        throw new Error(`Unsupported workflow role: ${String(role)}`);
      }
      activeRole = role;
      const loadSoul =
        role === "judge"
          ? dependencies.loadJudgeSoul
          : role === "fixer"
            ? dependencies.loadFixerSoul
            : role === "coder"
              ? dependencies.loadCoderSoul
              : dependencies.loadReviewerSoul;
      if (loadSoul === undefined) {
        throw new Error(`${role} soul loader is not configured`);
      }
      activeSoul = (await loadSoul()).trim();
      if (activeSoul.length === 0) {
        const roleLabel =
          role === "judge"
            ? "Judge"
            : role === "fixer"
              ? "Fixer"
              : role === "coder"
                ? "Coder"
                : "Reviewer";
        throw new Error(`${roleLabel} soul is empty`);
      }

      if (role === "reviewer") {
        const taskPath = pi.getFlag("ak-review-task");
        if (typeof taskPath !== "string" || taskPath.trim().length === 0) {
          throw new Error("Reviewer role requires --ak-review-task");
        }
        if (
          dependencies.loadReviewerTask === undefined ||
          dependencies.loadCanonicalReviewerSkill === undefined ||
          dependencies.runReviewerAgent === undefined ||
          dependencies.auditReviewerCompliance === undefined
        ) {
          throw new Error("Reviewer runtime dependencies are not configured");
        }
        const rawReviewerTask = await dependencies.loadReviewerTask(taskPath);
        if (rawReviewerTask.trim().length === 0) {
          throw new Error("Reviewer task is empty");
        }
        activeReviewerTask = rawReviewerTask;
        activeReviewerSkill = await dependencies.loadCanonicalReviewerSkill();
        if (reviewerToolsRegistered) return;
        reviewerToolsRegistered = true;

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
            if (
              activeRole !== "reviewer" ||
              activeReviewerTask === undefined ||
              activeReviewerSkill === undefined ||
              dependencies.runReviewerAgent === undefined
            ) {
              throw new Error("Reviewer task and canonical Skill were not loaded");
            }
            try {
              reviewerLedger.beginAgentCall(
                toolCallId,
                parameters,
                reviewerAgentPersistedEvidence(ctx),
              );
            } catch (error) {
              failInfrastructure(error, ctx);
            }
            let result: ReviewerAgentResult;
            let details: ReviewerAgentAttempt;
            try {
              result = await dependencies.runReviewerAgent(
                {
                  description: parameters.description,
                  prompt: parameters.prompt,
                },
                signal === undefined
                  ? { context: ctx }
                  : { context: ctx, signal },
              );
              details = reviewerLedger.completeAgentCall(toolCallId, result);
            } catch (error) {
              failInfrastructure(
                reviewerLedger.failAgentCall(toolCallId, error),
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
            if (
              activeRole !== "reviewer" ||
              activeSoul === undefined ||
              activeReviewerTask === undefined ||
              activeReviewerSkill === undefined ||
              dependencies.auditReviewerCompliance === undefined
            ) {
              throw new Error("Reviewer inputs were not loaded");
            }
            requireSingletonSubmissionCall(
              toolCallId,
              REVIEWER_OUTPUT_TOOL_NAME,
              "Reviewer",
              ctx,
            );
            const output = validateReviewerOutput(parameters);
            let record: ReviewerExecutionRecord;
            try {
              record = reviewerLedger.recordForAudit(output.status);
            } catch (error) {
              if (
                isRecord(error) &&
                error["fatalReviewerInfrastructure"] === true
              ) {
                failInfrastructure(error, ctx);
              }
              throw error;
            }
            let audit: ComplianceDecision;
            try {
              audit = await dependencies.auditReviewerCompliance(
                {
                  soul: activeSoul,
                  canonicalSkill: activeReviewerSkill.raw,
                  task: activeReviewerTask,
                  record,
                  candidate: output,
                },
                signal === undefined
                  ? { context: ctx }
                  : { context: ctx, signal },
              );
            } catch (error) {
              failInfrastructure(
                reviewerLedger.recordInfrastructureFailure(error),
                ctx,
              );
            }
            if (audit.status === "revise") {
              throw new Error(
                `Reviewer receipt violates its method: ${audit.violations.join("; ")}`,
              );
            }
            try {
              await dependencies.shutdownReviewerAgent?.();
            } catch (error) {
              failInfrastructure(
                reviewerLedger.recordInfrastructureFailure(error),
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

        const registeredTools = new Set(
          pi.getAllTools().map((tool) => tool.name),
        );
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
        return;
      }

      if (role === "coder") {
        const phase = pi.getFlag("ak-coder-phase");
        if (phase !== "plan" && phase !== "apply") {
          throw new Error(
            "Coder role requires --ak-coder-phase plan|apply; no other phase is supported",
          );
        }
        activeCoderPhase = phase;
        const taskPath = pi.getFlag("ak-coder-task");
        if (typeof taskPath !== "string" || taskPath.trim().length === 0) {
          throw new Error("Coder role requires --ak-coder-task");
        }
        if (dependencies.loadCoderTask === undefined) {
          throw new Error("Coder task loader is not configured");
        }
        activeCoderTask = (await dependencies.loadCoderTask(taskPath)).trim();
        if (activeCoderTask.length === 0) {
          throw new Error("Coder task is empty");
        }
        if (coderToolRegistered) return;
        coderToolRegistered = true;
        pi.registerTool({
          name: CODER_OUTPUT_TOOL_NAME,
          label: "Coder Output",
          description:
            "Submit a plan, completion, or evidence-bearing refusal for the active coder phase. commitSha is advisory evidence for the judge.",
          promptSnippet: "Submit the final coder report",
          promptGuidelines: [
            `Use ${CODER_OUTPUT_TOOL_NAME} as the final action for the coder role.`,
            `${CODER_OUTPUT_TOOL_NAME} never escalates; explain authority or task conflicts in report for the judge to adjudicate.`,
            "plan permits planned|refused; apply permits completed|refused.",
            "A completed apply report must preserve evidence for TDD, the same-pattern check, introduced-regression check, and behavior-fact check.",
          ],
          parameters: workerOutputSchema,
          async execute(toolCallId, parameters, _signal, _onUpdate, ctx) {
            if (
              activeRole !== "coder" ||
              activeCoderTask === undefined ||
              activeCoderPhase === undefined
            ) {
              throw new Error("Coder task and phase were not loaded");
            }
            requireSingletonSubmissionCall(
              toolCallId,
              CODER_OUTPUT_TOOL_NAME,
              "Coder",
              ctx,
            );
            const output = validateWorkerOutput(
              parameters,
              activeCoderPhase,
              "Coder",
            );
            if (
              activeCoderPhase === "apply" &&
              output.status === "completed" &&
              !/<skill name="tdd"\s/.test(
                dependencies.transcriptFromContext(ctx),
              )
            ) {
              throw new Error(
                "Coder completed requires the Matt tdd skill to be expanded through Pi /skill:tdd",
              );
            }
            return {
              content: [{ type: "text" as const, text: "Coder report accepted" }],
              details: output,
              terminate: true as const,
            };
          },
        });
        return;
      }

      if (role === "fixer") {
        const phase = pi.getFlag("ak-fixer-phase");
        if (phase !== "plan" && phase !== "apply") {
          throw new Error(
            "Fixer role requires --ak-fixer-phase plan|apply; no other phase is supported",
          );
        }
        activeFixerPhase = phase;
        const packetPath = pi.getFlag("ak-fix-packet");
        if (typeof packetPath !== "string" || packetPath.trim().length === 0) {
          throw new Error("Fixer role requires --ak-fix-packet");
        }
        if (dependencies.loadFixPacket === undefined) {
          throw new Error("Fixer packet loader is not configured");
        }
        activeFixPacket = (await dependencies.loadFixPacket(packetPath)).trim();
        if (activeFixPacket.length === 0) {
          throw new Error("Fixer repair packet is empty");
        }
        if (fixerToolRegistered) return;
        fixerToolRegistered = true;
        pi.registerTool({
          name: FIXER_OUTPUT_TOOL_NAME,
          label: "Fixer Output",
          description:
            "Submit a plan, completion, or refusal for the active fixer phase. commitSha is advisory evidence for the judge.",
          promptSnippet: "Submit the final fixer report",
          promptGuidelines: [
            `Use ${FIXER_OUTPUT_TOOL_NAME} as the final action for the fixer role.`,
            `${FIXER_OUTPUT_TOOL_NAME} never escalates; explain any requested owner decision in report for the judge to adjudicate.`,
            "plan permits planned|refused; apply permits completed|refused.",
          ],
          parameters: workerOutputSchema,
          async execute(toolCallId, parameters, _signal, _onUpdate, ctx) {
            if (
              activeRole !== "fixer" ||
              activeFixPacket === undefined ||
              activeFixerPhase === undefined
            ) {
              throw new Error("Fixer repair packet and phase were not loaded");
            }
            requireSingletonSubmissionCall(
              toolCallId,
              FIXER_OUTPUT_TOOL_NAME,
              "Fixer",
              ctx,
            );
            const output = validateWorkerOutput(
              parameters,
              activeFixerPhase,
              "Fixer",
            );
            return {
              content: [{ type: "text" as const, text: "Fixer report accepted" }],
              details: output,
              terminate: true as const,
            };
          },
        });
        return;
      }

      if (judgeToolRegistered) return;
      judgeToolRegistered = true;

      pi.registerTool({
        name: JUDGE_OUTPUT_TOOL_NAME,
        label: "Judge Output",
        description:
          "Submit the final judge verdict. Soul compliance is audited before acceptance.",
        promptSnippet: "Submit the final judge verdict after adjudication",
        promptGuidelines: [
          `Use ${JUDGE_OUTPUT_TOOL_NAME} as the final action for the judge role.`,
        ],
        parameters: judgeVerdictSchema,
        async execute(toolCallId, parameters, signal, _onUpdate, ctx) {
          if (activeRole !== "judge" || activeSoul === undefined) {
            throw new Error("Judge soul was not loaded");
          }
          requireSingletonSubmissionCall(
            toolCallId,
            JUDGE_OUTPUT_TOOL_NAME,
            "Judge",
            ctx,
          );
          const verdict = validateVerdict(parameters);
          let audit: SoulAuditResult;
          try {
            audit = await dependencies.auditSoulCompliance(
              {
                soul: activeSoul,
                transcript: dependencies.transcriptFromContext(ctx),
                verdict,
              },
              signal === undefined ? { context: ctx } : { context: ctx, signal },
            );
          } catch (error) {
            ctx.abort();
            if (ctx.mode === "print" || ctx.mode === "json") {
              process.exitCode = 1;
            }
            throw error;
          }
          if (audit.status === "revise") {
            throw new Error(
              `Judge verdict violates its soul: ${audit.violations.join("; ")}`,
            );
          }
          return {
            content: [{ type: "text" as const, text: "Judge verdict accepted" }],
            details: verdict,
            terminate: true as const,
            ...(audit.usage === undefined ? {} : { usage: audit.usage }),
          };
        },
      });

      const registeredTools = new Set(
        pi.getAllTools().map((tool) => tool.name),
      );
      pi.setActiveTools(
        [
          "read",
          "grep",
          "find",
          "ls",
          "bash",
          JUDGE_OUTPUT_TOOL_NAME,
        ].filter((name) => registeredTools.has(name)),
      );
    });

    pi.on("input", (event) => {
      if (activeRole === "reviewer") {
        if (reviewerOriginalRequest !== undefined) {
          return { action: "continue" as const };
        }
        reviewerOriginalRequest = event.text;
        reviewerExpansionPending = true;
        return {
          action: "transform" as const,
          text: `/skill:code-review ${event.text}`,
          ...(event.images === undefined ? {} : { images: event.images }),
        };
      }
      if (
        activeRole !== "coder" ||
        activeCoderPhase !== "apply" ||
        coderTddInvocationInjected
      ) {
        return { action: "continue" as const };
      }
      coderTddInvocationInjected = true;
      if (event.text.startsWith("/skill:tdd")) {
        return { action: "continue" as const };
      }
      return {
        action: "transform" as const,
        text: `/skill:tdd ${event.text}`,
        ...(event.images === undefined ? {} : { images: event.images }),
      };
    });

    pi.on("tool_execution_start", (event, ctx) => {
      if (activeRole !== "reviewer" || event.toolName !== AGENT_TOOL_NAME) {
        return;
      }
      try {
        reviewerLedger.beginAgentCall(
          event.toolCallId,
          event.args,
          reviewerAgentPersistedEvidence(ctx),
        );
      } catch (error) {
        failInfrastructure(error, ctx);
      }
    });

    pi.on("tool_execution_end", (event) => {
      if (
        activeRole !== "reviewer" ||
        event.toolName !== AGENT_TOOL_NAME ||
        !event.isError
      ) {
        return;
      }
      reviewerLedger.rejectAgentCall(
        event.toolCallId,
        toolExecutionDiagnostic(event.result),
      );
    });

    pi.on("tool_call", (event) => {
      if (
        activeRole === "reviewer" &&
        event.toolName === "bash" &&
        typeof event.input["command"] === "string"
      ) {
        reviewerLedger.recordBashCall(
          event.toolCallId,
          event.input["command"],
        );
      }
    });

    pi.on("tool_result", (event) => {
      if (activeRole !== "reviewer" || event.toolName !== "bash") return;
      reviewerLedger.recordBashResult(
        event.toolCallId,
        event.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n"),
        event.isError,
      );
    });

    pi.on("session_shutdown", async () => {
      if (activeRole !== "reviewer") return;
      try {
        await dependencies.shutdownReviewerAgent?.();
      } catch (error) {
        throw reviewerLedger.recordInfrastructureFailure(error);
      }
    });

    pi.on("before_agent_start", (event, ctx) => {
      if (activeRole === undefined) return;
      if (activeSoul === undefined) {
        throw new Error(`${activeRole} soul was not loaded`);
      }
      if (activeRole === "reviewer" && reviewerExpansionPending) {
        reviewerExpansionPending = false;
        try {
          if (
            activeReviewerSkill === undefined ||
            reviewerOriginalRequest === undefined
          ) {
            throw new Error(
              "Reviewer canonical Skill binding was not initialized",
            );
          }
          const evidence = captureCanonicalReviewerSkillExpansion(
            event.prompt,
            reviewerOriginalRequest,
            activeReviewerSkill,
          );
          if (evidence === undefined) {
            throw new Error(
              "Reviewer first prompt did not contain the canonical native code-review Skill expansion",
            );
          }
          reviewerLedger.recordSkillExpansion(evidence);
        } catch (error) {
          failInfrastructure(
            reviewerLedger.recordInfrastructureFailure(error),
            ctx,
          );
        }
      }
      const roleInputSection =
        activeRole === "fixer"
          ? `\n\n<fixer_phase>\n${activeFixerPhase ?? ""}\n</fixer_phase>\n\n<fix_packet>\n${activeFixPacket ?? ""}\n</fix_packet>`
          : activeRole === "coder"
            ? `\n\n<coder_phase>\n${activeCoderPhase ?? ""}\n</coder_phase>\n\n<coder_task>\n${activeCoderTask ?? ""}\n</coder_task>`
            : activeRole === "reviewer"
              ? `\n\n<review_task>\n${activeReviewerTask ?? ""}\n</review_task>`
              : "";
      return {
        systemPrompt: `${event.systemPrompt}\n\n<${activeRole}_soul>\n${activeSoul}\n</${activeRole}_soul>${roleInputSection}`,
      };
    });
  };
}
