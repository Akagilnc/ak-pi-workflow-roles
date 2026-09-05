import { Type, type Static } from "typebox";
import { COLLECTOR_ELIGIBILITY_MS } from "./collector-evidence.ts";
import { openToolObject } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

export const collectorObserveArgsSchema = Type.Object({}, { additionalProperties: false });
export const collectorRequestArgsSchema = Type.Object({
  requestId: Type.String({ minLength: 1, description: "配置请求身份" }),
  snapshotId: Type.String({ minLength: 1, description: "最新留存观察快照" }),
}, { additionalProperties: false });
export const collectorReadArgsSchema = Type.Object({
  evidenceId: Type.String({ minLength: 1, description: "observe 返回的材料证据 id（evidenceId）" }),
}, { additionalProperties: false });
export const collectorWaitArgsSchema = Type.Object({
  durationMs: Type.Integer({ minimum: 1, maximum: COLLECTOR_ELIGIBILITY_MS, description: "等待毫秒；单次上限五分钟且不超剩余资格" }),
}, { additionalProperties: false });

/**
 * #641 chain① / #676 D6 / ADR 0057: collector LLM does splitting/classification.
 * Field declarations + descriptions are guidance for the model — host must not
 * pure-shape-reject the envelope (第 0 条 / ADR 0057). Runtime binds resolvable
 * evidence pointers only; unprojected content stays distinguishable on the receipt.
 *
 * findings item guidance (not a host gate): evidenceId pointer into observe materials;
 * optional category (short label, not summary); optional summary (finding abstract);
 * open the body via ak_collector_read when the head excerpt is insufficient.
 */
export const collectorOutputBaseSchema = openToolObject(
  Type.Object({
    findings: Type.Unknown({
      description:
        "本次收集到的逐条 findings（指针数组为规范形）。每条：evidenceId（observe 返回的材料指针，必填语义）、可选 category（简短归类标签，不是摘要）、可选 summary（哪个 bot、什么问题的摘要；不誊抄正文）。零 finding 的模板通知不得进入；正常完工无 finding 时省略。形状指引，非 schema 闸。",
    }),
    unfinishedReasons: Type.Unknown({
      description:
        "未完成原因字符串数组（额度/故障/等待届满等现场依据）；不得把未完成表述为无问题。无可报告时省略。形状指引，非 schema 闸。",
    }),
  }),
);

/** Runtime owns the observed evidence; the model submits findings and signals sole-final submission. */
export const collectorOutputArgsSchema = withInfrastructureFailureDeclaration(
  collectorOutputBaseSchema,
);

export type CollectorObserveArgs = Static<typeof collectorObserveArgsSchema>;
export type CollectorRequestArgs = Static<typeof collectorRequestArgsSchema>;
export type CollectorReadArgs = Static<typeof collectorReadArgsSchema>;
export type CollectorWaitArgs = Static<typeof collectorWaitArgsSchema>;
export type CollectorOutputArgs = Static<typeof collectorOutputArgsSchema>;
