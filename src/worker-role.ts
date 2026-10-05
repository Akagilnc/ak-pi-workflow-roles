import type { RoleHost, HostContext, HostGatekeeperActions } from "./host-contracts.ts";

import {
  validateAcceptedWorkerDetails,
  type CoderOutput,
  type FixerOutput,
  type WorkerOutput,
  type WorkerRoleLabel,
} from "./package-contracts/worker-output.ts";
import { validateFixerOutput, type FixerPhase } from "./package-contracts/fixer-output.ts";
import { registerFiledSubmissionTool } from "./filed-submission.ts";
import { roleSubmissionDeclaration } from "./role-submission-declarations.ts";
import {
  createWorkerSubmissionGate,
  WorkerCommitReminderError,
  WorkerPrefixReminderError,
  WorkerUnfinishedReasonReminderError,
  type WorkerSubmissionGate,
} from "./worker-submission-gates.ts";
import { deliveryLimitFromEnv } from "./receipt-delivery-policy.ts";
import {
  fixerBashSeatbeltDenyReason,
  matchFixerBashForbiddenLiteral,
} from "./fixer-bash-seatbelt.ts";

import { isRecord } from "./unknown-value.ts";

export {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  coderOutputSchema,
  validateAcceptedWorkerDetails,
} from "./package-contracts/worker-output.ts";
export type { WorkerOutput, FixerOutput, CoderOutput };
/** #1168: phase only — dispatch text is the first message, not a packet flag. */
export const FIXER_FLAG_DEFINITIONS = {
  phase: {
    name: "ak-fixer-phase",
    definition: {
      description:
        "Fixer phase: plan (inspect and propose a repair plan; no edits or commits) or apply (execute the approved plan, verify, and commit when repaired)",
      type: "string" as const,
    },
  },
} as const;

export const FIXER_PHASES = ["plan", "apply"] as const satisfies readonly FixerPhase[];
type WorkerPhase = (typeof FIXER_PHASES)[number];

function isWorkerPhase(value: unknown): value is WorkerPhase {
  return typeof value === "string" && (FIXER_PHASES as readonly string[]).includes(value);
}

export type WorkerRoleHostActions = HostGatekeeperActions;

export type FixerRoleDependencies = {
  loadSoul(): Promise<string>;
};

export type CoderRoleDependencies = {
  loadSoul(): Promise<string>;
};

export type WorkerRoleRuntime = {
  activate(ctx?: HostContext): Promise<void>;
  /** Arm gate ① baseline after envelope places the worktree (coder/fixer). Durable parent required (#857). */
  armSubmissionGate(cwd: string, parent: { getSessionFile(): string | undefined }, invocationScopeId?: string): void;
};

/** Read only the field that selects the worker's next package-owned path. */
function workerStatusOf(output: WorkerOutput): string | undefined {
  return isRecord(output) && typeof output.status === "string"
    ? output.status
    : undefined;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function validateWorkerOutput(
  output: unknown,
  phase: WorkerPhase,
  roleLabel: WorkerRoleLabel,
): WorkerOutput {
  if (roleLabel === "Fixer") return validateFixerOutput(output, phase);
  return validateAcceptedWorkerDetails(output, "Coder") as CoderOutput;
}

/**
 * Coder and fixer share one submission sequence: record via the shared tool,
 * then read status and bounce through the same reminder gate.
 * Seat differences stay in the ready check and the projection.
 */
function registerWorkerSubmission(
  pi: RoleHost,
  role: "coder" | "fixer",
  options: {
    readonly notReady: string;
    readonly ready: () => boolean;
    readonly phase: () => WorkerPhase | undefined;
    readonly project: (parameters: unknown, phase: WorkerPhase) => WorkerOutput;
    readonly submissionGate: WorkerSubmissionGate;
    readonly hostActions: WorkerRoleHostActions;
  },
): void {
  registerFiledSubmissionTool(pi, roleSubmissionDeclaration(role), {
    readyError: () => (options.ready() ? undefined : options.notReady),
    beforeAccept: async ({ toolCallId, parameters, ctx }) => {
      const phase = options.phase();
      if (phase === undefined) throw new Error(options.notReady);
      const output = options.project(parameters, phase);
      const status = workerStatusOf(output);
      if (status !== undefined) {
        assertAcceptableThroughHost(
          options.submissionGate,
          status,
          output,
          options.hostActions,
          ctx,
          toolCallId,
        );
      }
      return output;
    },
  });
}

/** Reminder bounces stay typed rejects; IO/infrastructure keep identity via host failInfrastructure. */
function assertAcceptableThroughHost(
  submissionGate: WorkerSubmissionGate,
  status: string,
  details: unknown,
  hostActions: WorkerRoleHostActions,
  ctx: HostContext,
  toolCallId: string,
): void {
  try {
    submissionGate.assertAcceptable(status, details);
  } catch (error) {
    if (
      error instanceof WorkerCommitReminderError ||
      error instanceof WorkerPrefixReminderError ||
      error instanceof WorkerUnfinishedReasonReminderError
    ) {
      throw error;
    }
    hostActions.failInfrastructure(error, ctx, toolCallId);
  }
}

export function createFixerRoleRuntime(
  pi: RoleHost,
  dependencies: FixerRoleDependencies,
  hostActions: WorkerRoleHostActions,
  options?: { readonly unfinishedReasonBounceLimit?: number },
): WorkerRoleRuntime {
  let soul: string | undefined;
  let phase: WorkerPhase | undefined;
  let lifecycleRegistered = false;
  // #1132: ADR 0050 缺理由催全次数. The in-process seam passes the value it
  // already resolved; the Pi child has only the env that seam projected.
  const submissionGate = createWorkerSubmissionGate({
    unfinishedReasonBounceLimit: options?.unfinishedReasonBounceLimit
      ?? deliveryLimitFromEnv(process.env),
  });

  pi.registerFlag(
    FIXER_FLAG_DEFINITIONS.phase.name,
    FIXER_FLAG_DEFINITIONS.phase.definition,
  );

  return {
    async activate() {
      soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Fixer soul is empty");
      const selectedPhase = pi.getFlag(FIXER_FLAG_DEFINITIONS.phase.name);
      if (!isWorkerPhase(selectedPhase)) {
        throw new Error(
          "Fixer role requires --ak-fixer-phase plan|apply; no other phase is supported",
        );
      }
      phase = selectedPhase;

      if (!lifecycleRegistered) {
        lifecycleRegistered = true;
        registerWorkerSubmission(pi, "fixer", {
          notReady: "修内司阶段未装载",
          ready: () => phase !== undefined,
          phase: () => phase,
          project: (parameters, current) => deepFreeze(validateFixerOutput(parameters, current)),
          submissionGate,
          hostActions,
        });
        pi.on("tool_call", (event) => {
          if (event.toolName !== "bash") return;
          const command = event.input["command"];
          if (typeof command !== "string") return;
          const matched = matchFixerBashForbiddenLiteral(command);
          if (matched === undefined) return;
          return {
            block: true,
            reason: fixerBashSeatbeltDenyReason(matched),
          };
        });
        // #1168: soul + phase only; dispatch text is the first message.
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("修内司职分未装载");
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<fixer_soul>\n${soul}\n</fixer_soul>\n\n<fixer_phase>\n${phase ?? ""}\n</fixer_phase>`,
          };
        });
      }
    },
    armSubmissionGate(cwd: string, parent: { getSessionFile(): string | undefined }, invocationScopeId?: string) {
      submissionGate.arm(cwd, parent, invocationScopeId);
    },
  };
}

export function createCoderRoleRuntime(
  pi: RoleHost,
  dependencies: CoderRoleDependencies,
  hostActions: WorkerRoleHostActions,
  options?: { readonly unfinishedReasonBounceLimit?: number },
): WorkerRoleRuntime {
  let soul: string | undefined;
  let phase: WorkerPhase | undefined;
  let lifecycleRegistered = false;
  // #1132: same resolved ceiling as the fixer gate. Absent = Pi child env.
  const submissionGate = createWorkerSubmissionGate({
    unfinishedReasonBounceLimit: options?.unfinishedReasonBounceLimit
      ?? deliveryLimitFromEnv(process.env),
  });

  pi.registerFlag("ak-coder-phase", {
    description:
      "Coder phase: plan (inspect and propose an implementation plan; no edits or commits) or apply (execute the approved plan and verify the first implementation)",
    type: "string",
  });

  return {
    async activate() {
      soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Coder soul is empty");
      const selectedPhase = pi.getFlag("ak-coder-phase");
      if (selectedPhase !== "plan" && selectedPhase !== "apply") {
        throw new Error(
          "Coder role requires --ak-coder-phase plan|apply; no other phase is supported",
        );
      }
      phase = selectedPhase;

      if (!lifecycleRegistered) {
        lifecycleRegistered = true;
        registerWorkerSubmission(pi, "coder", {
          notReady: "将作监阶段未装载",
          ready: () => phase !== undefined,
          phase: () => phase,
          project: (parameters, current) => validateWorkerOutput(parameters, current, "Coder"),
          submissionGate,
          hostActions,
        });
        // #1168: soul + phase only; dispatch text is the first message.
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("将作监职分未装载");
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<coder_soul>\n${soul}\n</coder_soul>\n\n<coder_phase>\n${phase ?? ""}\n</coder_phase>`,
          };
        });
      }
    },
    armSubmissionGate(cwd: string, parent: { getSessionFile(): string | undefined }, invocationScopeId?: string) {
      submissionGate.arm(cwd, parent, invocationScopeId);
    },
  };
}
