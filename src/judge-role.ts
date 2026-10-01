import { type RoleHost } from "./host-contracts.ts";
import { reviewSubmissionSchema } from "./review-submission.ts";
import { registerFiledSubmissionTool } from "./filed-submission.ts";
import { roleSubmissionDeclaration } from "./role-submission-declarations.ts";
import { type GatekeeperSubject } from "./gatekeeper-role.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
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

export type JudgeRoleDependencies = {
  loadSoul(): Promise<string>;
};

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
        registerFiledSubmissionTool(pi, roleSubmissionDeclaration("judge"), {
          readyError: () => (soul === undefined ? "大理寺职分未装载" : undefined),
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
