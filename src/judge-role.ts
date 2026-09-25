import {
  type RoleHost,
  type HostContext,
  type HostToolResult,
} from "./host-contracts.ts";
import type { Static } from "typebox";
import { reviewSubmissionSchema } from "./review-submission.ts";
import { ParentQueueReaskError } from "./submission-errors.ts";
import { type GatekeeperSubject } from "./gatekeeper-role.ts";
import {
  JUDGE_OUTPUT_TOOL_NAME,
  validateAcceptedJudgeDetails,
  type JudgeVerdict,
} from "./package-contracts/judge-output.ts";

const JUDGE_QUEUE_STATUSES = new Set(["converged", "continue", "escalate"]);
const JUDGE_STATUS_REASK =
  "status 不是 converged、continue、escalate 三态之一。请重新交卷，status 写明其一。" as const;

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
          description: "提交大理寺终局判词；受理前经符宝郎内闸与审刑院合规审核。",
          promptSnippet: "提交大理寺终局判词",
          parameters: judgeVerdictSchema,
          async execute(toolCallId: string, parameters: Static<typeof judgeVerdictSchema>, signal: AbortSignal | undefined, _onUpdate: unknown, ctx: HostContext): Promise<HostToolResult<unknown>> {
            if (soul === undefined) throw new Error("大理寺职分未装载");
            // #756 queue: read shared status only — escalate skips gates;
            // unreadable status returns to judge; else 符宝郎内闸 then 审刑院合规.
            const rawStatus =
              parameters !== null && typeof parameters === "object" && !Array.isArray(parameters)
              && typeof (parameters as Record<string, unknown>).status === "string"
                ? (parameters as Record<string, unknown>).status as string
                : undefined;
            if (rawStatus === undefined || !JUDGE_QUEUE_STATUSES.has(rawStatus)) {
              throw new ParentQueueReaskError(JUDGE_STATUS_REASK);
            }
            if (rawStatus === "escalate") {
              // Parent escalate → throw to caller as-is; officers do not attend (#753 / #756).
              const verdict = validateVerdict(parameters);
              return {
                content: [],
                details: verdict,
                terminate: true as const,
              };
            }
            const verdict = validateVerdict(parameters);
            return { content: [], details: verdict, terminate: true };
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
