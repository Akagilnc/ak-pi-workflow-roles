/**
 * Secretariat (中书省) business tools, soul assembly, and result projection.
 * Nested countersign lifecycle stays on the shared public summons seam (ADR 0018 / #924).
 * Role module: label, soul, evidence assembly, decision tools, result projection only.
 */
import type { Static } from "typebox";
import { Type } from "typebox";

import {
  runDirectoryFromHostContext,
  type HostContext,
  type HostToolResult,
  type RoleHost,
} from "./host-contracts.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
import {
  SECRETARIAT_ACCEPTED_TEXT,
  SECRETARIAT_OUTPUT_TOOL_NAME,
  SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME,
  validateRecordedSecretariatOutput,
  type SecretariatVerdict,
} from "./secretariat-contracts.ts";

export {
  SECRETARIAT_ACCEPTED_TEXT,
  SECRETARIAT_OUTPUT_TOOL_NAME,
  SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME,
} from "./secretariat-contracts.ts";
export type { SecretariatVerdict };
export { validateRecordedSecretariatOutput };

const SECRETARIAT_QUEUE_STATUSES = new Set(["sealed", "escalate"]);
const SECRETARIAT_STATUS_REASK =
  "secretariatStatus 不是 sealed、escalate 两态之一。请重新交卷，status 写明其一。" as const;

/** 中书省终局回执形状；形状指引，非 schema 闸。 */
export const secretariatVerdictSchema = withInfrastructureFailureDeclaration(
  Type.Object(
    {
      secretariatStatus: Type.Unknown({
        description: "sealed | escalate。非两态时请重读后重交，勿改标。",
      }),
      ticketNumber: Type.Optional(
        Type.Number({ description: "本票号；署时指向最终正文所在票" }),
      ),
      note: Type.Optional(Type.String({ description: "附注" })),
      evidence: Type.Optional(Type.Unknown({ description: "留存证据" })),
      decisionGate: Type.Optional(
        Type.Object(
          {
            question: Type.Optional(Type.String()),
            options: Type.Optional(Type.Array(Type.String())),
          },
          { additionalProperties: true, description: "需陛下处置的问题与选项" },
        ),
      ),
    },
    { additionalProperties: true },
  ),
);
(secretariatVerdictSchema as unknown as { required: string[] }).required = [];

export type SecretariatVerdictParameters = Static<typeof secretariatVerdictSchema>;

/** 传召给事中参数；形状指引，非 schema 闸。 */
export const secretariatSummonCountersignSchema = Type.Object(
  {
    instruction: Type.Optional(
      Type.String({
        description: "传召散文；票号写在其中。空则沿用本局指令。",
      }),
    ),
  },
  { additionalProperties: true },
);
(secretariatSummonCountersignSchema as unknown as { required: string[] }).required = [];

export type SecretariatSummonCountersignParameters = Static<
  typeof secretariatSummonCountersignSchema
>;

export const SECRETARIAT_OUTPUT_TOOL_SPEC = {
  name: SECRETARIAT_OUTPUT_TOOL_NAME,
  label: "中书省输出",
  description: "中书省终局回执（署或上呈）。",
  promptSnippet: "中书省终局回执",
  parameters: secretariatVerdictSchema,
} as const;

export const SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_SPEC = {
  name: SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME,
  label: "传召给事中",
  description: "经共享执行接缝传召给事中审票；封驳后续同一 run 再送。",
  promptSnippet: "传召给事中",
  parameters: secretariatSummonCountersignSchema,
} as const;

export type SecretariatSummonCountersign = (input: {
  readonly instruction: string;
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly correlationId?: string;
  readonly home?: string;
  readonly packageRoot?: string;
}) => Promise<PublicSummonResult>;

export type SecretariatRuntimeDependencies = {
  loadSoul(): Promise<string>;
  /** Package root for nested public summons. */
  packageRoot?: string;
  /**
   * Nested countersign summon. Production uses shared summonPublicRole;
   * tests may inject a tracer.
   */
  summonCountersign?: SecretariatSummonCountersign;
  /** Optional home override for nested summons (tests). */
  home?: string;
};

function parentRunIdFromContext(ctx: HostContext): string | undefined {
  const runDirectory = runDirectoryFromHostContext(ctx);
  if (runDirectory === undefined) return undefined;
  const leaf = runDirectory.split("/").filter(Boolean).at(-1);
  if (leaf === undefined || leaf.trim() === "") return undefined;
  const at = leaf.indexOf("@");
  return at > 0 ? leaf.slice(0, at) : leaf;
}

function projectSummonResult(summoned: PublicSummonResult): Record<string, unknown> {
  const terminal = summoned.terminal;
  const roleOutcome = terminal?.roleOutcome;
  const payloads =
    roleOutcome !== undefined &&
    roleOutcome.kind === "accepted" &&
    Array.isArray(roleOutcome.payloads)
      ? roleOutcome.payloads
      : undefined;
  const latest =
    payloads !== undefined && payloads.length > 0
      ? payloads[payloads.length - 1]
      : undefined;
  const countersignStatus =
    latest !== null &&
    typeof latest === "object" &&
    !Array.isArray(latest) &&
    typeof (latest as Record<string, unknown>).countersignStatus === "string"
      ? ((latest as Record<string, unknown>).countersignStatus as string)
      : undefined;
  const runDirectory = summoned.runDirectory;
  const runId =
    typeof runDirectory === "string" && runDirectory.trim() !== ""
      ? (() => {
          const leaf = runDirectory.split("/").filter(Boolean).at(-1) ?? "";
          const at = leaf.indexOf("@");
          return at > 0 ? leaf.slice(0, at) : leaf;
        })()
      : undefined;
  return {
    exitCode: summoned.exitCode,
    ...(runId === undefined ? {} : { runId }),
    ...(runDirectory === undefined ? {} : { runDirectory }),
    ...(countersignStatus === undefined ? {} : { countersignStatus }),
    ...(latest === undefined ? {} : { receipt: latest }),
    ...(summoned.stderr === undefined || summoned.stderr === ""
      ? {}
      : { stderr: summoned.stderr }),
  };
}

/**
 * Create secretariat runtime: output tool + summon-countersign tool.
 * Lifecycle of nested countersign is owned by the shared public summons seam.
 */
export function createSecretariatRoleRuntime(
  roleHost: RoleHost,
  dependencies: SecretariatRuntimeDependencies,
): { activate(): Promise<void> } {
  let soul: string | undefined;
  let registered = false;
  let parentInstruction = "";

  return {
    async activate() {
      const loaded = (await dependencies.loadSoul()).trim();
      if (loaded.length === 0) throw new Error("secretariat soul is empty");
      soul = loaded;
      if (!registered) {
        registered = true;

        roleHost.registerTool({
          name: SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME,
          label: SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_SPEC.label,
          description: SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_SPEC.description,
          promptSnippet: SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_SPEC.promptSnippet,
          parameters: secretariatSummonCountersignSchema,
          async execute(
            _toolCallId: string,
            parameters: SecretariatSummonCountersignParameters,
            signal: AbortSignal | undefined,
            _onUpdate: unknown,
            ctx: HostContext,
          ): Promise<HostToolResult<unknown>> {
            const fromArgs =
              typeof parameters?.instruction === "string"
                ? parameters.instruction.trim()
                : "";
            const instruction =
              fromArgs !== ""
                ? fromArgs
                : parentInstruction.trim() !== ""
                  ? parentInstruction
                  : "裁：按《票面法》审本票是否足以开工。";
            const correlationId = parentRunIdFromContext(ctx);
            const summon =
              dependencies.summonCountersign ??
              (async (input) => {
                const { summonPublicRole } = await import("./public-role-summons.ts");
                return summonPublicRole({
                  role: "countersign",
                  argv: [input.instruction, "--project", input.cwd],
                  cwd: input.cwd,
                  ...(input.signal === undefined ? {} : { signal: input.signal }),
                  ...(input.correlationId === undefined
                    ? {}
                    : { correlationId: input.correlationId }),
                  ...(input.home === undefined ? {} : { home: input.home }),
                  ...(input.packageRoot === undefined
                    ? {}
                    : { packageRoot: input.packageRoot }),
                });
              });
            const summoned = await summon({
              instruction,
              cwd: ctx.cwd,
              ...(signal === undefined ? {} : { signal }),
              ...(correlationId === undefined ? {} : { correlationId }),
              ...(dependencies.home === undefined ? {} : { home: dependencies.home }),
              ...(dependencies.packageRoot === undefined
                ? {}
                : { packageRoot: dependencies.packageRoot }),
            });
            return {
              content: [
                {
                  type: "text" as const,
                  text: "给事中回执已送达中书省",
                },
              ],
              details: projectSummonResult(summoned),
            };
          },
        });

        roleHost.registerTool({
          name: SECRETARIAT_OUTPUT_TOOL_NAME,
          label: SECRETARIAT_OUTPUT_TOOL_SPEC.label,
          description: SECRETARIAT_OUTPUT_TOOL_SPEC.description,
          promptSnippet: SECRETARIAT_OUTPUT_TOOL_SPEC.promptSnippet,
          parameters: secretariatVerdictSchema,
          async execute(
            _toolCallId: string,
            parameters: SecretariatVerdictParameters,
            _signal: AbortSignal | undefined,
            _onUpdate: unknown,
            _ctx: HostContext,
          ): Promise<HostToolResult<unknown>> {
            if (soul === undefined) throw new Error("中书省职分未装载");
            const rawStatus =
              parameters !== null &&
              typeof parameters === "object" &&
              !Array.isArray(parameters) &&
              typeof (parameters as Record<string, unknown>).secretariatStatus ===
                "string"
                ? ((parameters as Record<string, unknown>).secretariatStatus as string)
                : undefined;
            if (
              rawStatus === undefined ||
              !SECRETARIAT_QUEUE_STATUSES.has(rawStatus)
            ) {
              const { ParentQueueReaskError } = await import(
                "./submission-errors.ts"
              );
              throw new ParentQueueReaskError(SECRETARIAT_STATUS_REASK);
            }
            return {
              content: [{ type: "text" as const, text: SECRETARIAT_ACCEPTED_TEXT }],
              details: parameters,
              terminate: true as const,
            };
          },
        });

        roleHost.on("before_agent_start", (event) => {
          if (soul === undefined) throw new Error("中书省职分未装载");
          if (typeof event.prompt === "string" && event.prompt.trim() !== "") {
            parentInstruction = event.prompt;
          }
          return {
            systemPrompt: `${event.systemPrompt}\n\n<secretariat_soul>\n${soul}\n</secretariat_soul>`,
          };
        });
      }
      const all = roleHost.getAllTools().map((tool) => tool.name);
      for (const name of [
        SECRETARIAT_OUTPUT_TOOL_NAME,
        SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME,
      ]) {
        if (all.filter((n) => n === name).length !== 1) {
          throw new Error(`secretariat required tool collision or missing: ${name}`);
        }
      }
    },
  };
}
