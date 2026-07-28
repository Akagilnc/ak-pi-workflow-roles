import { StringEnum, type Usage } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

export const JUDGE_OUTPUT_TOOL_NAME = "ak_judge_output";

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

type JudgeVerdictParameters = Static<typeof judgeVerdictSchema>;
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

export type SoulAuditInput = {
  soul: string;
  transcript: string;
  verdict: JudgeVerdict;
};

export type SoulAuditResult =
  | { status: "pass"; usage?: Usage }
  | { status: "revise"; violations: readonly string[]; usage?: Usage };

export type JudgeRoleDependencies = {
  loadSoul(): Promise<string>;
  transcriptFromContext(ctx: ExtensionContext): string;
  auditSoulCompliance(
    input: SoulAuditInput,
    options: { context: ExtensionContext; signal?: AbortSignal },
  ): Promise<SoulAuditResult>;
};

export type JudgeRoleHostActions = {
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

function validateVerdict(verdict: JudgeVerdictParameters): JudgeVerdict {
  if (!isRecord(verdict)) throw new Error("Judge verdict must be an object");
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
      throw new Error("Judge continue requires only a non-blank fix.summary");
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
        (option) => typeof option === "string" && option.trim().length > 0,
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
  ctx: ExtensionContext,
): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") {
    throw new Error("Judge output must be the sole final tool call");
  }
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  const call = calls[0];
  if (
    calls.length !== 1 || call === undefined || call.id !== toolCallId ||
    call.name !== JUDGE_OUTPUT_TOOL_NAME
  ) {
    throw new Error("Judge output must be the sole final tool call");
  }
}

export function createJudgeRoleRuntime(
  pi: ExtensionAPI,
  dependencies: JudgeRoleDependencies,
  hostActions: JudgeRoleHostActions,
): { activate(): Promise<void> } {
  let soul: string | undefined;
  let lifecycleRegistered = false;

  return {
    async activate() {
      soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Judge soul is empty");
      if (!lifecycleRegistered) {
        lifecycleRegistered = true;
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
            if (soul === undefined) throw new Error("Judge soul was not loaded");
            requireSingletonSubmissionCall(toolCallId, ctx);
            const verdict = validateVerdict(parameters);
            let audit: SoulAuditResult;
            try {
              audit = await dependencies.auditSoulCompliance(
                {
                  soul,
                  transcript: dependencies.transcriptFromContext(ctx),
                  verdict,
                },
                signal === undefined
                  ? { context: ctx }
                  : { context: ctx, signal },
              );
            } catch (error) {
              hostActions.failInfrastructure(error, ctx);
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
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("Judge soul was not loaded");
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<judge_soul>\n${soul}\n</judge_soul>`,
          };
        });
      }
      const registeredTools = new Set(pi.getAllTools().map((tool) => tool.name));
      pi.setActiveTools(
        ["read", "grep", "find", "ls", "bash", JUDGE_OUTPUT_TOOL_NAME]
          .filter((name) => registeredTools.has(name)),
      );
    },
  };
}
