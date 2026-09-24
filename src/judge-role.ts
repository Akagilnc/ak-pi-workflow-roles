import { dirname } from "node:path";
import {
  runDirectoryFromHostContext,
  type RoleHost,
  type HostContext,
  type HostToolResult,
  type HostGatekeeperActions,
} from "./host-contracts.ts";
import type { Static } from "typebox";
import { reviewSubmissionSchema } from "./review-submission.ts";
import { GatekeeperDecisionError, ParentQueueReaskError } from "./submission-errors.ts";
import { projectGatekeeperEscalation } from "./audit-escalation.ts";
import { gateOfficerForSubject, type GatekeeperSubject } from "./gatekeeper-role.ts";
import { readableGateItem } from "./readable-gate-item.ts";
import { listDirectOfficerRunPointers } from "./archivist-record-entry.ts";
import { tryHomeFromAkRolesPath } from "./activation-ledger-topology.ts";
import { runIdFromRunDirectory } from "./run-terminal-artifacts.ts";
import { readRecordedSubmissionRows } from "./submission-ledger.ts";
import { deepEqual } from "./package-contracts/terminating-tools.ts";
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
  ) => Promise<{ readonly status?: unknown; readonly receipt?: unknown } | void>;
}): Promise<{
  readonly status: "converged" | "continue";
  readonly passes: readonly {
    readonly subject: GatekeeperSubject;
    readonly status: "converged" | "continue";
    readonly receipt: unknown;
  }[];
}> {
  const passes: {
    subject: GatekeeperSubject;
    status: "converged" | "continue";
    receipt: unknown;
  }[] = [];
  for (const subject of JUDGE_GATES) {
    if (await input.gateAlreadyConverged(subject)) continue;
    const pass = await input.runGate(subject);
    const status = pass?.status;
    if (pass === undefined || (status !== "converged" && status !== "continue")) {
      throw new Error("judge gate returned no conclusion");
    }
    passes.push({ subject, status, receipt: pass.receipt });
    if (status === "continue") return { status: "continue", passes };
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

export type JudgeRoleHostActions = HostGatekeeperActions & {
  /** Preserve the first officer's pass as a separate model-visible result item if the second gate fails. */
  bindPriorGatePass(toolCallId: string, receipt: unknown): void;
};

export function validateVerdict(verdict: JudgeVerdictParameters): JudgeVerdict {
  return validateAcceptedJudgeDetails(verdict);
}

function hasConvergedStatus(value: unknown): boolean {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { status?: unknown }).status === "converged";
}

/**
 * A Judge whose pending output is resumed after an officer pass continues at
 * the first unfinished gate. The parent session's existing direct pointers
 * are the binding; only a sealed converged officer submission counts as done.
 */
async function priorGateConverged(
  context: HostContext,
  subject: GatekeeperSubject,
): Promise<boolean> {
  const parentSessionFile = context.sessionManager.getSessionFile?.();
  if (typeof parentSessionFile !== "string" || parentSessionFile.trim() === "") return false;
  const pointer = listDirectOfficerRunPointers(parentSessionFile)
    .find((entry) => entry.pointer.officer === gateOfficerForSubject(subject))
    ?.pointer;
  if (pointer === undefined) return false;
  const runDirectory = pointer.runDirectory ?? dirname(dirname(pointer.sessionFile));
  const runId = runIdFromRunDirectory(runDirectory);
  if (runId === undefined) {
    throw new Error(`officer pointer does not identify a run: ${pointer.sessionFile}`);
  }
  const home = tryHomeFromAkRolesPath(pointer.sessionFile);
  const rows = await readRecordedSubmissionRows(context.cwd, runId, {
    ...(home === undefined ? {} : { home }),
    sessionParent: pointer.sessionFile,
  });
  const latest = rows.at(-1);
  return latest?.kind === "accepted" && hasConvergedStatus(latest.accepted);
}

async function isSamePriorJudgeCandidate(context: HostContext): Promise<boolean> {
  const parentSessionFile = context.sessionManager.getSessionFile?.();
  const runDirectory = runDirectoryFromHostContext(context);
  const runId = (runDirectory === undefined ? undefined : runIdFromRunDirectory(runDirectory))
    ?? context.sessionManager.getHeader?.()?.id;
  if (typeof runId !== "string" || runId.trim() === "") return false;
  const home = typeof parentSessionFile === "string"
    ? tryHomeFromAkRolesPath(parentSessionFile)
    : undefined;
  const rows = await readRecordedSubmissionRows(context.cwd, runId, {
    ...(typeof parentSessionFile === "string" && parentSessionFile.trim() !== ""
      ? {
          ...(home === undefined ? {} : { home }),
          sessionParent: parentSessionFile,
        }
      : {}),
  });
  const current = rows.at(-1);
  const prior = rows.at(-2);
  return current?.role === "judge"
    && current.kind === "candidate"
    && prior?.role === "judge"
    && prior.kind === "candidate"
    && deepEqual(current.accepted, prior.accepted);
}


export function createJudgeRoleRuntime(
  pi: RoleHost,
  dependencies: JudgeRoleDependencies,
  hostActions: JudgeRoleHostActions,
): { activate(): Promise<void> } {
  let soul: string | undefined;
  let lifecycleRegistered = false;
  let resumed = false;

  return {
    async activate() {
      soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Judge soul is empty");
      if (!lifecycleRegistered) {
        lifecycleRegistered = true;
        pi.on("session_start", (event) => {
          resumed = event.reason === "resume";
        });
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
            // Candidate verdict is already on the parent session books as this
            // tool-call leaf (first-record-then-audit; run 019fea05 L61/L62).
            // One order: 符宝郎 then 审刑院. continue returns the raw receipts.
            const resumeContinuation = resumed;
            resumed = false;
            try {
              const continuingPendingCandidate = resumeContinuation
                && await isSamePriorJudgeCandidate(ctx);
              const chain = await runJudgeGates({
                gateAlreadyConverged: async (subject) => continuingPendingCandidate
                  ? priorGateConverged(ctx, subject)
                  : false,
                runGate: (subject) => pi.requireSubmissionGate!({
                  context: ctx,
                  subject,
                  ...(signal === undefined ? {} : { signal }),
                  hostActions,
                  toolCallId,
                  submission: parameters,
                }),
              });
              const draftPass = chain.passes.find((pass) => pass.subject.kind === "judge_draft");
              if (draftPass?.status === "converged") hostActions.bindPriorGatePass(toolCallId, draftPass.receipt);
              return {
                content: chain.passes.map((pass) => ({ type: "text" as const, text: readableGateItem(pass.receipt) })),
                details: verdict,
                terminate: chain.status === "converged",
              };
            } catch (error) {
              if (error instanceof GatekeeperDecisionError && error.result.status === "escalate") {
                return projectGatekeeperEscalation(error.result, verdict);
              }
              throw error;
            }
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
