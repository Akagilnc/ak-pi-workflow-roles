/**
 * Secretariat (中书省) label, soul shape, decision-tool specs, result projection.
 * Lifecycle assembly (activate, register, prompt inject, inventory) lives on the
 * shared envelope — src/role-runtime.ts (ADR 0018 / #924).
 */
import type { Static } from "typebox";
import { Type } from "typebox";

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

/** Project nested countersign PublicSummonResult onto tool details (evidence assembly). */
export function projectSecretariatSummonResult(
  summoned: PublicSummonResult,
): Record<string, unknown> {
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
