import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const JUDGE_OUTPUT_TOOL_NAME = "ak_judge_output";
export const FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";

const judgeVerdictSchema = Type.Object(
  {
    judgeStatus: StringEnum(["converged", "continue", "escalate"] as const),
    fix: Type.Optional(
      Type.Object(
        { summary: Type.String({ minLength: 1 }) },
        { additionalProperties: false },
      ),
    ),
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

const fixerOutputSchema = Type.Object(
  {
    status: StringEnum(["planned", "completed", "refused"] as const),
    report: Type.String({ minLength: 1 }),
    commitSha: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

type JudgeVerdictParameters = Static<typeof judgeVerdictSchema>;
type FixerOutputParameters = Static<typeof fixerOutputSchema>;

export type FixerOutput = {
  status: "planned" | "completed" | "refused";
  report: string;
  commitSha?: string;
};

export type JudgeVerdict =
  | { judgeStatus: "converged" }
  | { judgeStatus: "continue"; fix: { summary: string } }
  | {
      judgeStatus: "escalate";
      decisionGate: { question: string; options: string[] };
    };

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

type FixerPhase = "plan" | "apply";

function validateFixerOutput(
  output: FixerOutputParameters,
  phase: FixerPhase,
): FixerOutput {
  if (!isRecord(output)) {
    throw new Error("Fixer output must be an object");
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
      "Fixer output requires planned|completed|refused, a non-blank report, and an optional non-blank commitSha",
    );
  }
  if (phase === "plan" && output.status === "completed") {
    throw new Error("Fixer plan phase permits only planned or refused");
  }
  if (phase === "apply" && output.status === "planned") {
    throw new Error("Fixer apply phase permits only completed or refused");
  }
  if (output.status === "planned" && output.commitSha !== undefined) {
    throw new Error("Fixer planned output forbids commitSha");
  }
  return {
    status: output.status,
    report: output.report,
    ...(output.commitSha === undefined ? {} : { commitSha: output.commitSha }),
  };
}

function validateVerdict(verdict: JudgeVerdictParameters): JudgeVerdict {
  if (!isRecord(verdict)) {
    throw new Error("Judge verdict must be an object");
  }

  if (verdict.judgeStatus === "converged") {
    if (!hasExactKeys(verdict, ["judgeStatus"])) {
      throw new Error("Judge converged forbids fix and decisionGate");
    }
    return { judgeStatus: "converged" };
  }

  if (verdict.judgeStatus === "continue") {
    if (
      !hasExactKeys(verdict, ["judgeStatus", "fix"]) ||
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
    };
  }

  if (verdict.judgeStatus === "escalate") {
    const gate = verdict.decisionGate;
    if (
      !hasExactKeys(verdict, ["judgeStatus", "decisionGate"]) ||
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
    };
  }

  throw new Error("Judge verdict has an invalid status");
}

function requireSingletonSubmissionCall(
  toolCallId: string,
  expectedToolName: string,
  roleLabel: "Judge" | "Fixer",
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
  transcriptFromContext(ctx: ExtensionContext): string;
  auditSoulCompliance(
    input: SoulAuditInput,
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<SoulAuditResult>;
};

export function createRoleRuntimeExtension(
  dependencies: RoleRuntimeDependencies,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    let activeSoul: string | undefined;
    let activeFixPacket: string | undefined;
    let activeFixerPhase: FixerPhase | undefined;
    let activeRole: "judge" | "fixer" | undefined;
    let judgeToolRegistered = false;
    let fixerToolRegistered = false;

    pi.registerFlag("ak-role", {
      description: "Activate a packaged workflow role",
      type: "string",
    });
    pi.registerFlag("ak-fix-packet", {
      description: "Markdown repair packet assigned to the fixer role",
      type: "string",
    });
    pi.registerFlag("ak-fixer-phase", {
      description:
        "Fixer phase: plan (plan only; no edits/commit) or apply (execute the approved plan)",
      type: "string",
    });

    pi.on("session_start", async () => {
      const role = pi.getFlag("ak-role");
      if (role === undefined) return;
      if (role !== "judge" && role !== "fixer") {
        throw new Error(`Unsupported workflow role: ${String(role)}`);
      }
      activeRole = role;
      const loadSoul =
        role === "judge"
          ? dependencies.loadJudgeSoul
          : dependencies.loadFixerSoul;
      if (loadSoul === undefined) {
        throw new Error(`${role} soul loader is not configured`);
      }
      activeSoul = (await loadSoul()).trim();
      if (activeSoul.length === 0) {
        const roleLabel = role === "judge" ? "Judge" : "Fixer";
        throw new Error(`${roleLabel} soul is empty`);
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
          parameters: fixerOutputSchema,
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
            const output = validateFixerOutput(parameters, activeFixerPhase);
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

    pi.on("before_agent_start", (event) => {
      if (activeRole === undefined) return;
      if (activeSoul === undefined) {
        throw new Error(`${activeRole} soul was not loaded`);
      }
      const fixPacketSection =
        activeRole === "fixer"
          ? `\n\n<fixer_phase>\n${activeFixerPhase ?? ""}\n</fixer_phase>\n\n<fix_packet>\n${activeFixPacket ?? ""}\n</fix_packet>`
          : "";
      return {
        systemPrompt: `${event.systemPrompt}\n\n<${activeRole}_soul>\n${activeSoul}\n</${activeRole}_soul>${fixPacketSection}`,
      };
    });
  };
}
