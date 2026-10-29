/**
 * Public Secretariat (中书省) terminating receipt contracts.
 * Public terminal domain: converged (署) | escalate (上呈).
 * (#924) — 原卷保真: the verdict is recognized read-only; no field
 * is defaulted, rewritten, or dropped (ADR 0055).
 */

import { Type, type Static } from "typebox";

import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";
import { clauseExistenceRowSchema } from "./review-submission.ts";

export const SECRETARIAT_OUTPUT_TOOL_NAME = "ak_secretariat_output";

/**
 * 中书省终局回执形状。
 * #1134: `secretariatStatus` alone is the trajectory field
 * (src/packaged-role-registry.ts receiptStatusKey; the public settlement reads
 * converged | escalate to route); its words ride the description. note/evidence/
 * decisionGate are declared name + semantic description only — the string type, the
 * number type, the nested question/options object shape and the required constraint
 * are deleted, because the package declaration IS the host's pre-dispatch validator.
 * (ticketNumber keeps its own declaration: it is the declared seat identity the
 * activation flag and settlement read, not narrative content.)
 */
export const secretariatVerdictSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      secretariatStatus: Type.Unknown({
        description: "converged | escalate",
      }),
      ticketNumber: Type.Optional(
        Type.Unknown({ description: "本票号；署时指向最终正文所在票" }),
      ),
      note: Type.Unknown({
        description:
          "附注；署（converged）时逐题列答案、依据与落在哪一句；封还（escalate）时首写「封还」。原样留存。",
      }),
      evidence: Type.Optional(Type.Unknown({ description: "留存证据" })),
      decisionGate: Type.Unknown({
        description:
          "本轮题目：每题 question、options（稿里做法／另一做法）、两边代价、建议。原样留存。存废尺标「不要」的条款另列为陛下拍的题，附原文，不出给宰相答。",
      }),
      existence: Type.Array(clauseExistenceRowSchema, {
        description:
          "存废尺：稿里每条让机制存在的条款各一行——明写机制的，和只写结果要求、现状代码满足不了的，两类都算——到 ADR／票面点名的应用框架官方示范里看不带它时同一关切怎么处理。有「不要」行，这条不进票面：上呈陛下，原文列进 decisionGate；宰相答不了它。票面已写、前轮判词要求过、宰相答过、陛下对别的题点过头，都不是「要」的理由。一条没有为空数组。",
      }),
    },
    { additionalProperties: true },
  ),
);
// #1134 deleted the required set for the narrative fields; the 存废尺 table is the one generation-required field,
// as it is for 给事中／台院／审刑院／大理寺 (the package still records the receipt as-is).
(secretariatVerdictSchema as unknown as { required: string[] }).required = ["existence"];
// Reflect the declaration's empty required set and open additional properties,
// including the shared terminating fields composed at runtime.
export type SecretariatVerdict =
  Partial<Static<typeof secretariatVerdictSchema>> & Record<string, unknown>;
