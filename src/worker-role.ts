import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

import type {
  AnyCanonicalSkillBinding,
  CanonicalSkillBinding,
} from "./canonical-skill-binding.ts";

export const FIXER_OUTPUT_TOOL_NAME = "ak_fixer_output";
export const CODER_OUTPUT_TOOL_NAME = "ak_coder_output";

const workerOutputSchema = Type.Object(
  {
    status: StringEnum(["planned", "completed", "refused"] as const),
    report: Type.String({ minLength: 1 }),
    commitSha: Type.Optional(Type.String({ minLength: 1 })),
  },
  { additionalProperties: false },
);

type WorkerOutputParameters = Static<typeof workerOutputSchema>;
export type WorkerOutput = {
  status: "planned" | "completed" | "refused";
  report: string;
  commitSha?: string;
};
export type FixerOutput = WorkerOutput;
export type CoderOutput = WorkerOutput;
type WorkerPhase = "plan" | "apply";
type WorkerRoleLabel = "Coder" | "Fixer";

export type WorkerRoleHostActions = {
  failInfrastructure(error: unknown, ctx: ExtensionContext): never;
};

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

function validateWorkerOutput(
  output: WorkerOutputParameters,
  phase: WorkerPhase,
  roleLabel: WorkerRoleLabel,
): WorkerOutput {
  if (!isRecord(output)) {
    throw new Error(`${roleLabel} output must be an object`);
  }
  const expectedKeys = output.commitSha === undefined
    ? ["status", "report"]
    : ["status", "report", "commitSha"];
  if (
    !hasExactKeys(output, expectedKeys) ||
    (output.status !== "planned" && output.status !== "completed" &&
      output.status !== "refused") ||
    typeof output.report !== "string" || output.report.trim().length === 0 ||
    (output.commitSha !== undefined &&
      (typeof output.commitSha !== "string" ||
        output.commitSha.trim().length === 0))
  ) {
    throw new Error(
      `${roleLabel} output requires planned|completed|refused, a non-blank report, and an optional non-blank commitSha`,
    );
  }
  if (phase === "plan" && output.status === "completed") {
    throw new Error(`${roleLabel} plan phase permits only planned or refused`);
  }
  if (phase === "apply" && output.status === "planned") {
    throw new Error(`${roleLabel} apply phase permits only completed or refused`);
  }
  if (output.status === "planned" && output.commitSha !== undefined) {
    throw new Error(`${roleLabel} planned output forbids commitSha`);
  }
  return {
    status: output.status,
    report: output.report,
    ...(output.commitSha === undefined ? {} : { commitSha: output.commitSha }),
  };
}

function requireSingletonSubmissionCall(
  toolCallId: string,
  expectedToolName: string,
  roleLabel: WorkerRoleLabel,
  ctx: ExtensionContext,
): void {
  const leaf = ctx.sessionManager.getLeafEntry();
  if (leaf?.type !== "message" || leaf.message.role !== "assistant") {
    throw new Error(`${roleLabel} output must be the sole final tool call`);
  }
  const calls = leaf.message.content.filter((part) => part.type === "toolCall");
  const call = calls[0];
  if (
    calls.length !== 1 || call === undefined || call.id !== toolCallId ||
    call.name !== expectedToolName
  ) {
    throw new Error(`${roleLabel} output must be the sole final tool call`);
  }
}

export function createFixerRoleRuntime(
  pi: ExtensionAPI,
  dependencies: FixerRoleDependencies,
): { activate(): Promise<void> } {
  let soul: string | undefined;
  let packet: string | undefined;
  let phase: WorkerPhase | undefined;
  let lifecycleRegistered = false;

  pi.registerFlag("ak-fix-packet", {
    description: "Markdown repair packet assigned to the fixer role",
    type: "string",
  });
  pi.registerFlag("ak-fixer-phase", {
    description:
      "Fixer phase: plan (inspect and propose a repair plan; no edits or commits) or apply (execute the approved plan, verify, and commit when repaired)",
    type: "string",
  });

  return {
    async activate() {
      soul = (await dependencies.loadSoul()).trim();
      if (soul.length === 0) throw new Error("Fixer soul is empty");
      const selectedPhase = pi.getFlag("ak-fixer-phase");
      if (selectedPhase !== "plan" && selectedPhase !== "apply") {
        throw new Error(
          "Fixer role requires --ak-fixer-phase plan|apply; no other phase is supported",
        );
      }
      phase = selectedPhase;
      const packetPath = pi.getFlag("ak-fix-packet");
      if (typeof packetPath !== "string" || packetPath.trim().length === 0) {
        throw new Error("Fixer role requires --ak-fix-packet");
      }
      packet = (await dependencies.loadPacket(packetPath)).trim();
      if (packet.length === 0) throw new Error("Fixer repair packet is empty");

      if (!lifecycleRegistered) {
        lifecycleRegistered = true;
        pi.registerTool({
          name: FIXER_OUTPUT_TOOL_NAME,
          label: "Fixer Output",
          description:
            "Submit a plan, completion, or refusal for the active fixer phase. commitSha is advisory evidence for the caller.",
          promptSnippet: "Submit the final fixer report",
          promptGuidelines: [
            `Use ${FIXER_OUTPUT_TOOL_NAME} as the final action for the fixer role.`,
            `${FIXER_OUTPUT_TOOL_NAME} never escalates; explain any requested owner decision in report for the caller to dispose.`,
            "plan permits planned|refused; apply permits completed|refused.",
          ],
          parameters: workerOutputSchema,
          async execute(toolCallId, parameters, _signal, _onUpdate, ctx) {
            if (packet === undefined || phase === undefined) {
              throw new Error("Fixer repair packet and phase were not loaded");
            }
            requireSingletonSubmissionCall(
              toolCallId,
              FIXER_OUTPUT_TOOL_NAME,
              "Fixer",
              ctx,
            );
            const output = validateWorkerOutput(parameters, phase, "Fixer");
            return {
              content: [{ type: "text" as const, text: "Fixer report accepted" }],
              details: output,
              terminate: true as const,
            };
          },
        });
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("Fixer soul was not loaded");
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<fixer_soul>\n${soul}\n</fixer_soul>\n\n<fixer_phase>\n${phase ?? ""}\n</fixer_phase>\n\n<fix_packet>\n${packet ?? ""}\n</fix_packet>`,
          };
        });
      }
    },
  };
}

export function createCoderRoleRuntime(
  pi: ExtensionAPI,
  dependencies: CoderRoleDependencies,
  hostActions: WorkerRoleHostActions,
): { activate(ctx?: ExtensionContext): Promise<void> } {
  let soul: string | undefined;
  let task: string | undefined;
  let phase: WorkerPhase | undefined;
  let binding: CanonicalSkillBinding<"tdd"> | undefined;
  let tddInvocationInjected = false;
  let originalRequest: string | undefined;
  let expansionPending = false;
  let expansionCaptured = false;
  let lifecycleRegistered = false;

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
          label: "Coder Output",
          description:
            "Submit a plan, completion, or evidence-bearing refusal for the active coder phase. commitSha is advisory evidence for the caller.",
          promptSnippet: "Submit the final coder report",
          promptGuidelines: [
            `Use ${CODER_OUTPUT_TOOL_NAME} as the final action for the coder role.`,
            `${CODER_OUTPUT_TOOL_NAME} never escalates; explain authority or task conflicts in report for the caller to dispose.`,
            "plan permits planned|refused; apply permits completed|refused.",
            "A completed apply report must preserve evidence for TDD, the same-pattern check, introduced-regression check, and behavior-fact check.",
          ],
          parameters: workerOutputSchema,
          async execute(toolCallId, parameters, _signal, _onUpdate, ctx) {
            if (task === undefined || phase === undefined) {
              throw new Error("Coder task and phase were not loaded");
            }
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
            return {
              content: [{ type: "text" as const, text: "Coder report accepted" }],
              details: output,
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
          if (soul === undefined) throw new Error("Coder soul was not loaded");
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
  };
}
