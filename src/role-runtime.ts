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

export type JudgeVerdict = Static<typeof judgeVerdictSchema>;

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
    let soul: string | undefined;
    let judgeToolRegistered = false;

    pi.registerFlag("ak-role", {
      description: "Activate a packaged workflow role",
      type: "string",
    });

    pi.on("session_start", async () => {
      if (pi.getFlag("ak-role") !== "judge") return;

      soul = (await dependencies.loadJudgeSoul()).trim();
      if (soul.length === 0) {
        throw new Error("Judge soul is empty");
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
        async execute(_toolCallId, verdict, signal, _onUpdate, ctx) {
          if (soul === undefined) {
            throw new Error("Judge soul was not loaded");
          }
          if (
            verdict.judgeStatus === "continue" &&
            (verdict.fix === undefined || verdict.fix.summary.trim().length === 0)
          ) {
            throw new Error("Judge continue requires fix.summary");
          }
          if (
            verdict.judgeStatus === "escalate" &&
            verdict.decisionGate === undefined
          ) {
            throw new Error("Judge escalate requires decisionGate");
          }
          const audit = await dependencies.auditSoulCompliance(
            {
              soul,
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
      if (pi.getFlag("ak-role") !== "judge") return;
      if (soul === undefined) {
        throw new Error("Judge soul was not loaded");
      }
      return {
        systemPrompt: `${event.systemPrompt}\n\n<judge_soul>\n${soul}\n</judge_soul>`,
      };
    });
  };
}
