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
  FixerPacketValidationError,
  parseFixerPrerequisites,
  type FixerInvocationInput,
} from "./package-contracts/fixer-packet.ts";
import {
  createWorkerSubmissionGate,
  WorkerCommitReminderError,
  WorkerPrefixReminderError,
  WorkerUnfinishedReasonReminderError,
} from "./worker-submission-gates.ts";
import {
  fixerBashSeatbeltDenyReason,
  matchFixerBashForbiddenLiteral,
} from "./fixer-bash-seatbelt.ts";

export {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  coderOutputSchema,
  validateAcceptedWorkerDetails,
} from "./package-contracts/worker-output.ts";
export type { WorkerOutput, FixerOutput, CoderOutput };
export const FIXER_FLAG_DEFINITIONS = {
  packet: {
    name: "ak-fix-packet",
    definition: {
      description: "Path to opaque prose instructions for the Fixer",
      type: "string" as const,
    },
  },
  prerequisites: {
    name: "ak-fixer-prerequisites",
    definition: {
      description: "Optional path to a JSON array of typed Fixer prerequisites",
      type: "string" as const,
    },
  },
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
  loadPacket(path: string): Promise<string>;
};

export type CoderRoleDependencies = {
  loadSoul(): Promise<string>;
  loadTask(path: string): Promise<string>;
};

export type WorkerRoleRuntime = {
  activate(ctx?: HostContext): Promise<void>;
  /** Arm gate ① baseline after envelope places the worktree (coder/fixer). Durable parent required (#857). */
  armSubmissionGate(cwd: string, parent: { getSessionFile(): string | undefined }): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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


/** Reminder bounces stay typed rejects; IO/infrastructure keep identity via host failInfrastructure. */
function assertAcceptableThroughHost(
  submissionGate: { assertAcceptable(status: string, details?: unknown): void },
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
): WorkerRoleRuntime {
  let soul: string | undefined;
  let packet: FixerInvocationInput | undefined;
  let packetPath: string | undefined;
  let prerequisitesPath: string | undefined;
  let phase: WorkerPhase | undefined;
  let lifecycleRegistered = false;
  const submissionGate = createWorkerSubmissionGate();

  pi.registerFlag(
    FIXER_FLAG_DEFINITIONS.packet.name,
    FIXER_FLAG_DEFINITIONS.packet.definition,
  );
  pi.registerFlag(
    FIXER_FLAG_DEFINITIONS.prerequisites.name,
    FIXER_FLAG_DEFINITIONS.prerequisites.definition,
  );
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
      const resolvedPacketPath = pi.getFlag(FIXER_FLAG_DEFINITIONS.packet.name);
      if (typeof resolvedPacketPath !== "string" || resolvedPacketPath.trim().length === 0) {
        throw new Error("Fixer role requires --ak-fix-packet");
      }
      packetPath = resolvedPacketPath;
      const instructions = await dependencies.loadPacket(packetPath);
      if (instructions.trim().length === 0) {
        throw new FixerPacketValidationError(
          new Error("Fixer instructions must be nonblank"),
        );
      }
      const resolvedPrerequisitesPath = pi.getFlag(FIXER_FLAG_DEFINITIONS.prerequisites.name);
      if (resolvedPrerequisitesPath !== undefined && (typeof resolvedPrerequisitesPath !== "string" || resolvedPrerequisitesPath.trim().length === 0)) {
        throw new Error("Fixer --ak-fixer-prerequisites path must be nonblank when supplied");
      }
      prerequisitesPath =
        typeof resolvedPrerequisitesPath === "string" ? resolvedPrerequisitesPath : undefined;
      const prerequisites = prerequisitesPath !== undefined
        ? parseFixerPrerequisites(await dependencies.loadPacket(prerequisitesPath))
        : Object.freeze([]);
      packet = Object.freeze({ instructions, prerequisites });

      if (!lifecycleRegistered) {
        lifecycleRegistered = true;
        registerFiledSubmissionTool(pi, roleSubmissionDeclaration("fixer"), {
          readyError: () =>
            packet === undefined || phase === undefined ? "修内司修理包与阶段未装载" : undefined,
          beforeAccept: async ({ toolCallId, parameters, ctx }) => {
            if (phase === undefined) throw new Error("修内司修理包与阶段未装载");
            const output = deepFreeze(validateFixerOutput(parameters, phase));
            const status = workerStatusOf(output);
            if (status !== undefined) {
              assertAcceptableThroughHost(
                submissionGate,
                status,
                output,
                hostActions,
                ctx,
                toolCallId,
              );
            }
            return output;
          },
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
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("修内司职分未装载");
          if (packetPath === undefined) throw new Error("修内司修理包路径未装载");
          // Path delivery only — body is self-fetched; no inline duplicate of flag bytes (#632).
          const prerequisitesBlock =
            prerequisitesPath === undefined
              ? ""
              : `\n\n<fixer_prerequisites_path>\n${prerequisitesPath}\n</fixer_prerequisites_path>`;
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<fixer_soul>\n${soul}\n</fixer_soul>\n\n<fixer_phase>\n${phase ?? ""}\n</fixer_phase>\n\n<fix_packet_path>\n${packetPath}\n</fix_packet_path>${prerequisitesBlock}`,
          };
        });
      }
    },
    armSubmissionGate(cwd: string, parent: { getSessionFile(): string | undefined }) {
      submissionGate.arm(cwd, parent);
    },
  };
}

export function createCoderRoleRuntime(
  pi: RoleHost,
  dependencies: CoderRoleDependencies,
  hostActions: WorkerRoleHostActions,
): WorkerRoleRuntime {
  let soul: string | undefined;
  let task: string | undefined;
  let phase: WorkerPhase | undefined;
  let lifecycleRegistered = false;
  const submissionGate = createWorkerSubmissionGate();

  pi.registerFlag("ak-coder-task", {
    description: "Markdown task assigned to the coder role",
    type: "string",
  });
  pi.registerFlag("ak-coder-phase", {
    description:
      "Coder phase: plan (inspect and propose an implementation plan; no edits or commits) or apply (execute the approved plan and verify the first implementation)",
    type: "string",
  });

  return {
    async activate(ctx) {
      soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Coder soul is empty");
      const selectedPhase = pi.getFlag("ak-coder-phase");
      if (selectedPhase !== "plan" && selectedPhase !== "apply") {
        throw new Error(
          "Coder role requires --ak-coder-phase plan|apply; no other phase is supported",
        );
      }
      phase = selectedPhase;
      const taskPath = pi.getFlag("ak-coder-task");
      if (typeof taskPath !== "string" || taskPath.trim().length === 0) {
        throw new Error("Coder role requires --ak-coder-task");
      }
      task = (await dependencies.loadTask(taskPath)).trim();
      if (task.length === 0) throw new Error("Coder task is empty");

      if (!lifecycleRegistered) {
        lifecycleRegistered = true;
        registerFiledSubmissionTool(pi, roleSubmissionDeclaration("coder"), {
          readyError: () =>
            task === undefined || phase === undefined ? "将作监任务与阶段未装载" : undefined,
          beforeAccept: async ({ toolCallId, parameters, ctx }) => {
            if (phase === undefined) throw new Error("将作监任务与阶段未装载");
            const output = validateWorkerOutput(parameters, phase, "Coder");
            const status = workerStatusOf(output);
            if (status !== undefined) {
              assertAcceptableThroughHost(
                submissionGate,
                status,
                output,
                hostActions,
                ctx,
                toolCallId,
              );
            }
            return output;
          },
        });
        pi.on("before_agent_start", (event, ctx) => {
          if (soul === undefined) throw new Error("将作监职分未装载");
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<coder_soul>\n${soul}\n</coder_soul>\n\n<coder_phase>\n${phase ?? ""}\n</coder_phase>\n\n<coder_task>\n${task ?? ""}\n</coder_task>`,
          };
        });
      }
    },
    armSubmissionGate(cwd: string, parent: { getSessionFile(): string | undefined }) {
      submissionGate.arm(cwd, parent);
    },
  };
}
