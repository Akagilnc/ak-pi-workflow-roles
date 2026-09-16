/**
 * Secretariat (中书省) label, soul shape, decision-tool specs, result projection.
 * Lifecycle assembly (activate, register, prompt inject, inventory) lives on the
 * shared envelope — src/role-runtime.ts (ADR 0018 / #924).
 */
import type { Static } from "typebox";
import { Type } from "typebox";

import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";
import type { NamedRoleTurnHostAdapter } from "./public-cli/role-turn-host-resolution.ts";
import type { PublicSummonResult } from "./public-role-summons.ts";
import {
  SECRETARIAT_ACCEPTED_TEXT,
  SECRETARIAT_OUTPUT_TOOL_NAME,
  SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME,
  type SecretariatVerdict,
} from "./secretariat-contracts.ts";
import { runIdFromRunDirectory } from "./run-terminal-artifacts.ts";

export {
  SECRETARIAT_ACCEPTED_TEXT,
  SECRETARIAT_OUTPUT_TOOL_NAME,
  SECRETARIAT_SUMMON_COUNTERSIGN_TOOL_NAME,
} from "./secretariat-contracts.ts";
export type { SecretariatVerdict };

/** 中书省终局回执形状；形状指引，非 schema 闸。 */
export const secretariatVerdictSchema = withInfrastructureFailureDeclaration(
  Type.Object(
    {
      secretariatStatus: Type.Unknown({
        description: "sealed | escalate（形状指引，非闸）",
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
   * tests may inject a tracer. Prefer hostAdapters on the default path.
   */
  summonCountersign?: SecretariatSummonCountersign;
  /** Optional home override for nested summons (tests). */
  home?: string;
  /**
   * Composition-root adapter table forwarded by the default summonPublicRole
   * path (tests). Production leaves unset.
   */
  hostAdapters?: readonly NamedRoleTurnHostAdapter[];
};

function latestObjectPayload(
  payloads: readonly unknown[] | undefined,
): Record<string, unknown> | undefined {
  if (payloads === undefined || payloads.length === 0) return undefined;
  const latest = payloads[payloads.length - 1];
  if (latest === null || typeof latest !== "object" || Array.isArray(latest)) {
    return undefined;
  }
  return latest as Record<string, unknown>;
}

/**
 * Project nested countersign PublicSummonResult onto tool details.
 * Authority: keep typed terminal kind + payloads/diagnostic intact (gatekeeper
 * projectOfficerTerminal precedent / ADR 0052 / 失败诚实). No content gate.
 */
export function projectSecretariatSummonResult(
  summoned: PublicSummonResult,
): Record<string, unknown> {
  const terminal = summoned.terminal;
  const roleOutcome = terminal?.roleOutcome;
  const runDirectory = summoned.runDirectory;
  const runId =
    typeof runDirectory === "string" && runDirectory.trim() !== ""
      ? runIdFromRunDirectory(runDirectory)
      : undefined;
  const base: Record<string, unknown> = {
    exitCode: summoned.exitCode,
    ...(runId === undefined ? {} : { runId }),
    ...(runDirectory === undefined ? {} : { runDirectory }),
    ...(summoned.stderr === undefined || summoned.stderr === ""
      ? {}
      : { stderr: summoned.stderr }),
  };

  if (roleOutcome === undefined) {
    return { ...base, outcomeKind: "no_terminal" };
  }

  if (roleOutcome.kind === "accepted" || roleOutcome.kind === "audit_escalation") {
    const payloads = Array.isArray(roleOutcome.payloads) ? roleOutcome.payloads : undefined;
    const latest = latestObjectPayload(payloads);
    const countersignStatus =
      latest !== undefined && typeof latest.countersignStatus === "string"
        ? latest.countersignStatus
        : undefined;
    return {
      ...base,
      outcomeKind: roleOutcome.kind,
      // audit_escalation carries typed status; accepted may carry fixture/compat status.
      ...("status" in roleOutcome &&
      typeof roleOutcome.status === "string" &&
      roleOutcome.status.length > 0
        ? { status: roleOutcome.status }
        : {}),
      ...(countersignStatus === undefined ? {} : { countersignStatus }),
      ...(latest === undefined ? {} : { receipt: latest }),
      ...(payloads === undefined ? {} : { payloads }),
      ...(roleOutcome.decisiveFacts === undefined
        ? {}
        : { decisiveFacts: roleOutcome.decisiveFacts }),
    };
  }

  if (roleOutcome.kind === "failure") {
    const payloads = Array.isArray(roleOutcome.payloads) ? roleOutcome.payloads : undefined;
    return {
      ...base,
      outcomeKind: "failure",
      diagnostic: roleOutcome.diagnostic,
      ...(roleOutcome.cause === undefined ? {} : { cause: roleOutcome.cause }),
      ...(roleOutcome.decisiveFacts === undefined
        ? {}
        : { decisiveFacts: roleOutcome.decisiveFacts }),
      ...(payloads === undefined ? {} : { payloads }),
      ...(latestObjectPayload(payloads) === undefined
        ? {}
        : { receipt: latestObjectPayload(payloads) }),
    };
  }

  // no_receipt (and any future kind still carries decisiveFacts when present)
  return {
    ...base,
    outcomeKind: roleOutcome.kind,
    ...("status" in roleOutcome &&
    typeof roleOutcome.status === "string" &&
    roleOutcome.status.length > 0
      ? { status: roleOutcome.status }
      : {}),
    ...("decisiveFacts" in roleOutcome && roleOutcome.decisiveFacts !== undefined
      ? { decisiveFacts: roleOutcome.decisiveFacts }
      : {}),
  };
}
