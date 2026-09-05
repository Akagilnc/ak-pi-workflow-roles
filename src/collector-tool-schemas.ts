import { Type, type Static } from "typebox";
import { COLLECTOR_ELIGIBILITY_MS } from "./collector-evidence.ts";
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
 * #641 chain① / #676 D6: the collector LLM does the splitting/classification.
 * Findings are pointer refs into stored evidence; runtime enriches machine locators.
 * category = short label (not the summary); summary = finding abstract for the caller;
 * neither is a body transcription. Schema is guidance — runtime does not pure-shape-reject.
 */
export const collectorFindingArgsSchema = Type.Object({
  evidenceId: Type.String({ minLength: 1, description: "observe 返回的材料证据 id（evidenceId）" }),
  category: Type.Optional(Type.String({ maxLength: 200, description: "该 finding 的简短归类标签（不是摘要）；需要头部之外的正文时先用 ak_collector_read 开卷再判读，不得誊写评论正文" })),
  summary: Type.Optional(Type.String({ maxLength: 2000, description: "该 finding 的摘要：哪个 bot、什么问题；不要求誊抄全部原文，证据位置由 runtime 从指针补全" })),
}, { additionalProperties: false });

export const collectorOutputBaseSchema = Type.Object({
  findings: Type.Optional(Type.Array(collectorFindingArgsSchema, {
    description: "本次收集到的逐条 findings；零 finding 的模板通知不得进入。正常完工无 finding 时省略。",
  })),
  unfinishedReasons: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), {
    description: "未完成原因（额度/故障/等待届满等现场依据）；不得把未完成表述为无问题。无可报告时省略。",
  })),
}, { additionalProperties: true, description: "正常完工提交空对象 {}；仅在基础设施真实失败时才填写 infrastructureFailure，无失败时必须省略该字段。" });

/** Runtime owns the observed evidence; the model submits findings and signals sole-final submission. */
export const collectorOutputArgsSchema = withInfrastructureFailureDeclaration(
  collectorOutputBaseSchema,
);
(collectorOutputArgsSchema as unknown as { required: string[] }).required = [];

export type CollectorObserveArgs = Static<typeof collectorObserveArgsSchema>;
export type CollectorRequestArgs = Static<typeof collectorRequestArgsSchema>;
export type CollectorReadArgs = Static<typeof collectorReadArgsSchema>;
export type CollectorWaitArgs = Static<typeof collectorWaitArgsSchema>;
export type CollectorOutputArgs = Static<typeof collectorOutputArgsSchema>;
