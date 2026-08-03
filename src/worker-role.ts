import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  AgentToolResult,
} from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { disposeComplianceDecision } from "./audit-escalation.ts";
import type { ComplianceDecision } from "./compliance-transport.ts";

import type {
  AnyCanonicalSkillBinding,
  CanonicalSkillBinding,
} from "./canonical-skill-binding.ts";
import {
  CODER_OUTPUT_TOOL_NAME,
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

const coderOutputSchema = Type.Union([
  Type.Object({
    status: StringEnum(["planned"] as const),
    report: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
  Type.Object({
    status: StringEnum(["completed", "refused"] as const),
    report: Type.String({ minLength: 1 }),
    commitSha: Type.Optional(Type.String({ minLength: 1 })),
  }, { additionalProperties: false }),
  Type.Object({
    status: StringEnum(["unfinished"] as const),
    report: Type.String({ minLength: 1 }),
    remainingScope: Type.String({ minLength: 1 }),
  }, { additionalProperties: false }),
]);
type WorkerOutputParameters = Static<typeof coderOutputSchema> | FixerOutput;
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

export type WorkerRoleHostActions = {
  failInfrastructure(error: unknown, ctx: ExtensionContext): never;
};

export type FixerAuditInput = Readonly<{ soul: string; packet: FixerInvocationInput; phase: FixerPhase; transcript: string; candidate: FixerOutput }>;
export type FixerRoleDependencies = {
  loadSoul(): Promise<string>;
  loadPacket(path: string): Promise<string>;
  transcriptFromContext?(ctx: ExtensionContext): string;
  auditCompliance?(input: FixerAuditInput, options: { context: ExtensionContext; signal?: AbortSignal }): Promise<ComplianceDecision>;
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

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key));
}

export function validateWorkerOutput(
  output: WorkerOutputParameters,
  phase: WorkerPhase,
  roleLabel: WorkerRoleLabel,
): WorkerOutput {
  if (roleLabel === "Fixer") return validateFixerOutput(output, phase);
  const accepted = validateAcceptedWorkerDetails(output, "Coder") as CoderOutput;
  if (phase === "plan" && accepted.status !== "planned" && accepted.status !== "refused") {
    throw new Error("Coder plan phase permits only planned or refused");
  }
  if (phase === "apply" && accepted.status === "planned") {
    throw new Error("Coder apply phase permits only completed, unfinished, or refused");
  }
  return accepted;
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
  hostActions?: WorkerRoleHostActions,
): { activate(): Promise<void> } {
  let soul: string | undefined;
  let packet: FixerInvocationInput | undefined;
  let phase: WorkerPhase | undefined;
  let lifecycleRegistered = false;

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
          label: "Fixer Output",
          description:
            "Submit the plan refusal or per-finding apply settlement for compliance audit.",
          promptSnippet: "Submit the final fixer report",
          promptGuidelines: [
            `Use ${FIXER_OUTPUT_TOOL_NAME} as the final action for the fixer role.`,
            `${FIXER_OUTPUT_TOOL_NAME} reports only lawful assignment blockers; infrastructure failures abort.`,
            "plan permits planned|refused; apply permits completed|refused|partially_completed.",
          ],
          parameters: fixerOutputSchema,
          async execute(toolCallId, parameters, _signal, _onUpdate, ctx): Promise<AgentToolResult<unknown>> {
            if (packet === undefined || phase === undefined) {
              throw new Error("Fixer repair packet and phase were not loaded");
            }
            requireSingletonSubmissionCall(
              toolCallId,
              FIXER_OUTPUT_TOOL_NAME,
              "Fixer",
              ctx,
            );
            const output = deepFreeze(validateFixerOutputForPacket(parameters, phase, packet));
            if (dependencies.transcriptFromContext === undefined || dependencies.auditCompliance === undefined) {
              const error = new Error("Fixer compliance auditor is not configured");
              if (hostActions !== undefined) hostActions.failInfrastructure(error, ctx);
              throw error;
            }
            let audit: ComplianceDecision;
            try {
              const auditInput = Object.freeze({ soul: soul!, packet, phase, transcript: dependencies.transcriptFromContext(ctx), candidate: output });
              audit = await dependencies.auditCompliance(auditInput, { context: ctx, ...(_signal === undefined ? {} : { signal: _signal }) });
            } catch (error) {
              if (hostActions !== undefined) hostActions.failInfrastructure(error, ctx);
              throw error;
            }
            return disposeComplianceDecision<AgentToolResult<unknown>>(audit, {
              pass: (usage) => ({
                content: [{ type: "text" as const, text: "Fixer report accepted" }],
                details: output,
                terminate: true as const,
                ...(usage === undefined ? {} : { usage }),
              }),
              revise: (violations) => {
                throw new Error(`Fixer output violates its law: ${violations.join("; ")}`);
              },
              escalate: (result) => result,
            });
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
              `Fixer blocked bash command containing forbidden literal: ${matched}`,
          };
        });
        pi.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("Fixer soul was not loaded");
          return {
            systemPrompt:
              `${event.systemPrompt}\n\n<fixer_soul>\n${soul}\n</fixer_soul>\n\n<fixer_phase>\n${phase ?? ""}\n</fixer_phase>\n\n<fix_packet>\n${packet?.instructions ?? ""}\n</fix_packet>\n\n<fixer_prerequisites>\n${JSON.stringify(packet?.prerequisites ?? [])}\n</fixer_prerequisites>`,
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
            "Submit a plan, completion, unfinished handoff, or evidence-bearing refusal for the active coder phase.",
          promptSnippet: "Submit the final coder report",
          promptGuidelines: [
            `Use ${CODER_OUTPUT_TOOL_NAME} as the final action for the coder role.`,
            `${CODER_OUTPUT_TOOL_NAME} never escalates; explain authority or task conflicts in report for the caller to dispose.`,
            "plan permits planned|refused; apply permits completed|unfinished|refused. unfinished requires a non-blank remainingScope.",
            "A completed apply report must preserve evidence for TDD, the same-pattern check, introduced-regression check, and behavior-fact check.",
          ],
          parameters: coderOutputSchema,
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
