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

function requireSingletonJudgeCall(
  toolCallId: string,
  ctx: ExtensionContext,
): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") {
    throw new Error("Judge output must be the sole final tool call");
  }
  const calls = leaf.message.content.filter(
    (part) => part.type === "toolCall",
  );
  const call = calls[0];
  if (
    calls.length !== 1 ||
    call === undefined ||
    call.id !== toolCallId ||
    call.name !== JUDGE_OUTPUT_TOOL_NAME
  ) {
    throw new Error("Judge output must be the sole final tool call");
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
    let activeRole: "judge" | "fixer" | undefined;
    let judgeToolRegistered = false;

    pi.registerFlag("ak-role", {
      description: "Activate a packaged workflow role",
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
      if (role !== "judge" || judgeToolRegistered) return;
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
          requireSingletonJudgeCall(toolCallId, ctx);
          const verdict = validateVerdict(parameters);
          const audit = await dependencies.auditSoulCompliance(
            {
              soul: activeSoul,
              transcript: dependencies.transcriptFromContext(ctx),
              verdict,
            },
            signal === undefined ? { context: ctx } : { context: ctx, signal },
          );
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
    });

    pi.on("before_agent_start", (event) => {
      if (activeRole === undefined) return;
      if (activeSoul === undefined) {
        throw new Error(`${activeRole} soul was not loaded`);
      }
      return {
        systemPrompt: `${event.systemPrompt}\n\n<${activeRole}_soul>\n${activeSoul}\n</${activeRole}_soul>`,
      };
    });
  };
}
