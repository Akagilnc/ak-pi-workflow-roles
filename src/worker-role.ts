import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { openToolObjectFromUnion } from "./open-tool-schema.ts";
import {
  failOnInfrastructureFailureDeclaration,
  withInfrastructureFailureDeclaration,
} from "./package-contracts/terminating-infrastructure.ts";

import type {
  AnyCanonicalSkillBinding,
  CanonicalSkillBinding,
} from "./canonical-skill-binding.ts";
import {
  CODER_ACCEPTED_TEXT,
  CODER_OUTPUT_TOOL_NAME,
  FIXER_ACCEPTED_TEXT,
  FIXER_OUTPUT_TOOL_NAME,
  validateAcceptedWorkerDetails,
  type CoderOutput,
  type FixerOutput,
  type WorkerOutput,
  type WorkerRoleLabel,
} from "./package-contracts/worker-output.ts";
import { fixerOutputSchema, validateFixerOutput, validateFixerOutputForPacket, type FixerPhase } from "./package-contracts/fixer-output.ts";
import {
  FixerPacketValidationError,
  parseFixerPrerequisites,
  type FixerInvocationInput,
} from "./package-contracts/fixer-packet.ts";
import { requireGatekeeperPass, type GatekeeperPassHostActions } from "./gatekeeper-role.ts";
import {
  createWorkerSubmissionGate,
  WorkerCommitReminderError,
  WorkerPrefixReminderError,
  WorkerUnfinishedReasonReminderError,
} from "./worker-submission-gates.ts";

export {
  CODER_OUTPUT_TOOL_NAME,
  FIXER_OUTPUT_TOOL_NAME,
  validateAcceptedWorkerDetails,
};
export type { WorkerOutput };

/** Exact case-sensitive substring literals blocked on Fixer bash only. */
const FIXER_BASH_FORBIDDEN_LITERALS = [
  "rm -rf",
  "git reset --hard",
  "git clean",
  "git checkout --",
] as const;

function matchFixerBashForbiddenLiteral(
  command: string,
): (typeof FIXER_BASH_FORBIDDEN_LITERALS)[number] | undefined {
  return FIXER_BASH_FORBIDDEN_LITERALS.find((literal) =>
    command.includes(literal)
  );
}

const coderOutputVariants = Type.Union([
  Type.Object({
    status: StringEnum(["planned"] as const, { description: "planned — 形状指引，非 schema 闸" }),
    report: Type.String({ minLength: 1, description: "如实结果报告" }),
  }, { additionalProperties: false }),
  Type.Object({
    status: StringEnum(["completed", "refused"] as const, {
      description:
        "completed | refused — 形状指引，非 schema 闸；completed 回执含 TDD、同模式、引入回归、行为事实四项证据",
    }),
    report: Type.String({ minLength: 1, description: "如实结果报告" }),
  }, { additionalProperties: false }),
  Type.Object({
    status: StringEnum(["unfinished"] as const, {
      description:
        "unfinished — 形状指引，非 schema 闸；缺前置或违宪约束致本局未完成时可用。缺待决 owner 决定或答复属缺前置。",
    }),
    report: Type.String({ minLength: 1, description: "如实结果报告" }),
    remainingScope: Type.String({ minLength: 1, description: "本局后剩余工作" }),
    reason: Type.Optional(Type.String({
      minLength: 1,
      description:
        "阻断原因：缺前置或违宪约束。缺待决 owner 决定或答复属缺前置。",
    })),
  }, { additionalProperties: false }),
]);
export const coderOutputSchema = withInfrastructureFailureDeclaration(
  openToolObjectFromUnion(coderOutputVariants),
);
export type { FixerOutput, CoderOutput };
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

export type WorkerRoleHostActions = GatekeeperPassHostActions;

export type FixerRoleDependencies = {
  loadSoul(): Promise<string>;
  loadPacket(path: string): Promise<string>;
};

export type CoderRoleDependencies = {
  loadSoul(): Promise<string>;
  loadTask(path: string): Promise<string>;
  loadCanonicalSkillBinding?(
    name: "tdd",
  ): Promise<AnyCanonicalSkillBinding>;
};

export type WorkerRoleRuntime = {
  activate(ctx?: ExtensionContext): Promise<void>;
  /** Arm gate ① baseline after envelope places the worktree (coder/fixer). Parent feeds archivist durability. */
  armSubmissionGate(cwd: string, parent?: { getSessionFile(): string | undefined }): void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function requireSingletonSubmissionCall(
  toolCallId: string,
  expectedToolName: string,
  roleLabel: WorkerRoleLabel,
  ctx: ExtensionContext,
): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  const seat = roleLabel === "Fixer" ? "修内司" : "将作监";
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") {
    throw new Error(`${seat}回执非唯一终局工具调用`);
  }
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  const call = calls[0];
  if (
    calls.length !== 1 || call === undefined || call.id !== toolCallId ||
    call.name !== expectedToolName
  ) {
    throw new Error(`${seat}回执非唯一终局工具调用`);
  }
}

/** Reminder bounces stay typed rejects; IO/infrastructure keep identity via host failInfrastructure. */
function assertAcceptableThroughHost(
  submissionGate: { assertAcceptable(status: string, details?: unknown): void },
  status: string,
  details: unknown,
  hostActions: WorkerRoleHostActions,
  ctx: ExtensionContext,
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
  pi: ExtensionAPI,
  dependencies: FixerRoleDependencies,
  hostActions: WorkerRoleHostActions,
): WorkerRoleRuntime {
  let soul: string | undefined;
  let packet: FixerInvocationInput | undefined;
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
      const packetPath = pi.getFlag(FIXER_FLAG_DEFINITIONS.packet.name);
      if (typeof packetPath !== "string" || packetPath.trim().length === 0) {
        throw new Error("Fixer role requires --ak-fix-packet");
      }
      const instructions = await dependencies.loadPacket(packetPath);
      if (instructions.trim().length === 0) {
        throw new FixerPacketValidationError(
          new Error("Fixer instructions must be nonblank"),
        );
      }
      const prerequisitesPath = pi.getFlag(FIXER_FLAG_DEFINITIONS.prerequisites.name);
      if (prerequisitesPath !== undefined && (typeof prerequisitesPath !== "string" || prerequisitesPath.trim().length === 0)) {
        throw new Error("Fixer --ak-fixer-prerequisites path must be nonblank when supplied");
      }
      const prerequisites = typeof prerequisitesPath === "string"
        ? parseFixerPrerequisites(await dependencies.loadPacket(prerequisitesPath))
        : Object.freeze([]);
      packet = Object.freeze({ instructions, prerequisites });

      if (!lifecycleRegistered) {
        lifecycleRegistered = true;
        pi.registerTool({
          name: FIXER_OUTPUT_TOOL_NAME,
          label: "修内司输出",
          description: "提交修内司终局回执",
          promptSnippet: "提交修内司终局回执",
          parameters: fixerOutputSchema,
          async execute(toolCallId, parameters, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
            if (packet === undefined || phase === undefined) {
              throw new Error("修内司修理包与阶段未装载");
            }
            // #541: infra declaration fails via the shared host seam before any
            // submission gate + Gatekeeper work.
            failOnInfrastructureFailureDeclaration(parameters, hostActions, ctx, toolCallId);
            requireSingletonSubmissionCall(
              toolCallId,
              FIXER_OUTPUT_TOOL_NAME,
              "Fixer",
              ctx,
            );
            const output = deepFreeze(validateFixerOutputForPacket(parameters, phase, packet));
            assertAcceptableThroughHost(
              submissionGate,
              output.status,
              output,
              hostActions,
              ctx,
              toolCallId,
            );
            await requireGatekeeperPass({
              context: ctx,
              subject: { kind: "worker_completion", material: JSON.stringify(output) },
              ...(_signal === undefined ? {} : { signal: _signal }),
              hostActions,
              toolCallId,
            });
            const acceptedDetails = output;
            return {
              content: [{ type: "text" as const, text: FIXER_ACCEPTED_TEXT }],
              details: acceptedDetails,
              terminate: true as const,
            };
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
            reason:
              `修内司 bash 拦截：命中禁用字面量 ${matched}`,
          };
        });
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("修内司职分未装载");
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<fixer_soul>\n${soul}\n</fixer_soul>\n\n<fixer_phase>\n${phase ?? ""}\n</fixer_phase>\n\n<fix_packet>\n${packet?.instructions ?? ""}\n</fix_packet>\n\n<fixer_prerequisites>\n${JSON.stringify(packet?.prerequisites ?? [])}\n</fixer_prerequisites>`,
          };
        });
      }
    },
    armSubmissionGate(cwd: string, parent?: { getSessionFile(): string | undefined }) {
      submissionGate.arm(cwd, parent);
    },
  };
}

export function createCoderRoleRuntime(
  pi: ExtensionAPI,
  dependencies: CoderRoleDependencies,
  hostActions: WorkerRoleHostActions,
): WorkerRoleRuntime {
  let soul: string | undefined;
  let task: string | undefined;
  let phase: WorkerPhase | undefined;
  let binding: CanonicalSkillBinding<"tdd"> | undefined;
  let tddInvocationInjected = false;
  let originalRequest: string | undefined;
  let expansionPending = false;
  let expansionCaptured = false;
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
      binding = undefined;
      if (phase === "apply") {
        if (dependencies.loadCanonicalSkillBinding === undefined) {
          throw new Error("Coder canonical Skill binding loader is not configured");
        }
        try {
          const loaded = await dependencies.loadCanonicalSkillBinding("tdd");
          if (loaded.name !== "tdd") {
            throw new Error(
              "Canonical Skill binding loader returned code-review for tdd",
            );
          }
          binding = loaded;
        } catch (error) {
          if (ctx === undefined) throw error;
          hostActions.failInfrastructure(error, ctx);
        }
      }

      if (!lifecycleRegistered) {
        lifecycleRegistered = true;
        pi.registerTool({
          name: CODER_OUTPUT_TOOL_NAME,
          label: "将作监输出",
          description: "提交将作监终局回执；本工具无 escalate 通道。",
          promptSnippet: "提交将作监终局回执",
          parameters: coderOutputSchema,
          async execute(toolCallId, parameters, _signal, _onUpdate, ctx) {
            if (task === undefined || phase === undefined) {
              throw new Error("将作监任务与阶段未装载");
            }
            // #541: infra declaration fails via the shared host seam before any
            // submission gate + Gatekeeper work.
            failOnInfrastructureFailureDeclaration(parameters, hostActions, ctx, toolCallId);
            requireSingletonSubmissionCall(
              toolCallId,
              CODER_OUTPUT_TOOL_NAME,
              "Coder",
              ctx,
            );
            const output = validateWorkerOutput(parameters, phase, "Coder");
            if (
              phase === "apply" && output.status === "completed" &&
              !expansionCaptured
            ) {
              throw new Error(
                "Coder completed requires the Matt tdd skill to be expanded through Pi /skill:tdd",
              );
            }
            assertAcceptableThroughHost(
              submissionGate,
              output.status,
              output,
              hostActions,
              ctx,
              toolCallId,
            );
            await requireGatekeeperPass({
              context: ctx,
              subject: { kind: "worker_completion", material: JSON.stringify(output) },
              ...(_signal === undefined ? {} : { signal: _signal }),
              hostActions,
              toolCallId,
            });
            const acceptedDetails = output;
            return {
              content: [{ type: "text" as const, text: CODER_ACCEPTED_TEXT }],
              details: acceptedDetails,
              terminate: true as const,
            };
          },
        });
        pi.on("input", (event) => {
          if (phase !== "apply" || tddInvocationInjected) {
            return { action: "continue" as const };
          }
          tddInvocationInjected = true;
          expansionPending = true;
          const isNativeTdd =
            event.text === "/skill:tdd" ||
            event.text.startsWith("/skill:tdd ");
          if (isNativeTdd) {
            originalRequest = event.text.slice("/skill:tdd".length).trim();
            return { action: "continue" as const };
          }
          originalRequest = event.text.trim();
          return {
            action: "transform" as const,
            text: binding?.invocation(event.text) ?? `/skill:tdd ${event.text}`,
            ...(event.images === undefined ? {} : { images: event.images }),
          };
        });
        pi.on("before_agent_start", (event, ctx) => {
          if (soul === undefined) throw new Error("将作监职分未装载");
          if (phase === "apply") {
            if (binding === undefined) {
              hostActions.failInfrastructure(
                new Error("Coder canonical tdd Skill binding was not initialized"),
                ctx,
              );
            }
            if (expansionPending) {
              expansionPending = false;
              if (originalRequest !== undefined) {
                expansionCaptured = binding.captureExpansion(
                  event.prompt,
                  originalRequest,
                ) !== undefined;
              }
            }
          }
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<coder_soul>\n${soul}\n</coder_soul>\n\n<coder_phase>\n${phase ?? ""}\n</coder_phase>\n\n<coder_task>\n${task ?? ""}\n</coder_task>`,
          };
        });
      }
    },
    armSubmissionGate(cwd: string, parent?: { getSessionFile(): string | undefined }) {
      submissionGate.arm(cwd, parent);
    },
  };
}
