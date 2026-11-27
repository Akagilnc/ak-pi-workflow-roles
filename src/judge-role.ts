import { type RoleHost } from "./host-contracts.ts";
import { registerFiledSubmissionTool } from "./filed-submission.ts";
import { roleSubmissionDeclaration } from "./role-submission-declarations.ts";
import { type GatekeeperSubject } from "./gatekeeper-role.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  type JudgeVerdict,
} from "./package-contracts/judge-output.ts";
import type { SubmissionGateOutcome } from "./submission-gate.ts";

export { JUDGE_OUTPUT_TOOL_NAME };
export type { JudgeVerdict };

/** The only judge audit order: 符宝郎, then 审刑院. */
export const JUDGE_GATES: readonly GatekeeperSubject[] = [
  { kind: "judge_draft" },
  { kind: "judge_compliance" },
];

export async function runJudgeGates(input: {
  readonly gateAlreadyConverged: (subject: GatekeeperSubject) => boolean;
  readonly runGate: (subject: GatekeeperSubject) => Promise<SubmissionGateOutcome>;
}): Promise<SubmissionGateOutcome | undefined> {
  for (const subject of JUDGE_GATES) {
    if (input.gateAlreadyConverged(subject)) continue;
    const pass = await input.runGate(subject);
    if (pass.status !== "converged") return pass;
  }
}

// #836 r16 class 1: fix/classes/note/decisionGate are LLM/human-read narrative
// content — 符宝郎/审刑院 read the raw receipt, no code branches on their length
// or nested presence. `status` alone is the machine discriminator the
// queue reads to pick converged/continue/escalate (below).

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
