import { type RoleHost } from "./host-contracts.ts";
import { REVIEW_QUEUE_STATUSES } from "./review-submission.ts";
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

export type JudgeGateStatus = SubmissionGateOutcome["status"];

type JudgeGatePass = Omit<SubmissionGateOutcome, "officer"> & { readonly subject: GatekeeperSubject };

export async function runJudgeGates(input: {
  readonly gateAlreadyConverged: (subject: GatekeeperSubject) => Promise<boolean>;
  readonly runGate: (
    subject: GatekeeperSubject,
  ) => Promise<SubmissionGateOutcome | void>;
}): Promise<{
  readonly status: JudgeGateStatus;
  readonly passes: readonly JudgeGatePass[];
}> {
  const passes: JudgeGatePass[] = [];
  for (const subject of JUDGE_GATES) {
    if (await input.gateAlreadyConverged(subject)) continue;
    const pass = await input.runGate(subject);
    const received = pass?.status;
    if (pass === undefined || (
      typeof received !== "string"
      || (!REVIEW_QUEUE_STATUSES.has(received)
        && received !== "needs_reask"
        && received !== "transport_failure"
        && received !== "no_receipt")
    )) {
      // #1214 A12: do not convert missing/unreadable gate conclusion into a
      // parent-killing throw. Surface needs_reask so callers present honestly.
      return {
        status: "needs_reask",
        passes: [{
          ...pass, subject, status: "needs_reask",
          receipt: pass?.receipt ?? { reason: "judge gate returned no conclusion" },
        }],
      };
    }
    const status = pass.status;
    if (status === "needs_reask" || status === "transport_failure" || status === "no_receipt") {
      return {
        status,
        passes: [{ ...pass, subject }],
      };
    }
    passes.push({ ...pass, subject });
    if (status === "continue" || status === "escalate") return { status, passes };
  }
  return { status: "converged", passes };
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
