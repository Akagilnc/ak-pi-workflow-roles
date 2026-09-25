import {
  type RoleHost,
  type HostContext,
  type HostToolResult,
} from "./host-contracts.ts";
import type { Static } from "typebox";
import { reviewSubmissionSchema } from "./review-submission.ts";
import { type GatekeeperSubject } from "./gatekeeper-role.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedJudgeDetails,
  type JudgeVerdict,
} from "./package-contracts/judge-output.ts";

export { JUDGE_OUTPUT_TOOL_NAME };
export type { JudgeVerdict };

/** The only judge audit order: 符宝郎, then 审刑院. */
const JUDGE_GATES: readonly GatekeeperSubject[] = [
  { kind: "judge_draft" },
  { kind: "judge_compliance" },
];

export async function runJudgeGates(input: {
  readonly gateAlreadyConverged: (subject: GatekeeperSubject) => Promise<boolean>;
  readonly runGate: (
    subject: GatekeeperSubject,
  ) => Promise<{
    readonly status?: unknown;
    readonly receipt?: unknown;
    readonly runId?: string;
    readonly runDirectory?: string;
  } | void>;
}): Promise<{
  readonly status: "converged" | "continue" | "escalate";
  readonly passes: readonly {
    readonly subject: GatekeeperSubject;
    readonly status: "converged" | "continue" | "escalate";
    readonly receipt: unknown;
    readonly runId?: string;
    readonly runDirectory?: string;
  }[];
}> {
  const passes: {
    subject: GatekeeperSubject;
    status: "converged" | "continue" | "escalate";
    receipt: unknown;
    runId?: string;
    runDirectory?: string;
  }[] = [];
  for (const subject of JUDGE_GATES) {
    if (await input.gateAlreadyConverged(subject)) continue;
    const pass = await input.runGate(subject);
    const status = pass?.status;
    if (pass === undefined || (status !== "converged" && status !== "continue" && status !== "escalate")) {
      throw new Error("judge gate returned no conclusion");
    }
    passes.push({
      subject,
      status,
      receipt: pass.receipt,
      ...(pass.runId === undefined ? {} : { runId: pass.runId }),
      ...(pass.runDirectory === undefined ? {} : { runDirectory: pass.runDirectory }),
    });
    if (status === "continue" || status === "escalate") return { status, passes };
  }
  return { status: "converged", passes };
}

// #836 r16 class 1: fix/classes/note/decisionGate are LLM/human-read narrative
// content — 符宝郎/审刑院 read the raw receipt, no code branches on their length
// or nested presence. `status` alone is the machine discriminator the
// queue reads to pick converged/continue/escalate (below).
// The shared open schema preserves role-specific prose without adding another contract.
export const judgeVerdictSchema = reviewSubmissionSchema;

type JudgeVerdictParameters = Static<typeof judgeVerdictSchema>;

export type JudgeRoleDependencies = {
  loadSoul(): Promise<string>;
};

export function validateVerdict(verdict: JudgeVerdictParameters): JudgeVerdict {
  return validateAcceptedJudgeDetails(verdict);
}

export function createJudgeRoleRuntime(
  pi: RoleHost,
  dependencies: JudgeRoleDependencies,
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
          label: "大理寺输出",
          description: "提交大理寺终局判词；交卷调用结束后，由公开调用接缝按判词状态执行适用审核。",
          promptSnippet: "提交大理寺终局判词",
          parameters: judgeVerdictSchema,
          async execute(toolCallId: string, parameters: Static<typeof judgeVerdictSchema>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext): Promise<HostToolResult<unknown>> {
            if (soul === undefined) throw new Error("大理寺职分未装载");
            // ADR 0003: record the original receipt and end the tool call first.
            // The public seam reads status and chooses the next route.
            return { content: [], details: parameters, terminate: true };
          },
        });
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("大理寺职分未装载");
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<judge_soul>\n${soul}\n</judge_soul>`,
          };
        });
      }
    },
  };
}
