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
 * #641 chain①: the collector LLM does the splitting/classification (#245:
 * 他自己就是llm为什么不能读不能拆). Findings are submitted as pointer refs into
 * the stored evidence; the runtime enriches each with the machine pointer
 * (repo/PR/comment id/url/author/kind/时间) and validates resolvability.
 * Category is a short LLM classification label, never a body transcription.
 */
export const collectorFindingArgsSchema = Type.Object({
  evidenceId: Type.String({ minLength: 1, description: "observe 返回的材料证据 id（evidenceId）" }),
  category: Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "该 finding 的简短归类标签；需要头部之外的正文时先用 ak_collector_read 开卷再判读，不得誊写评论正文" })),
}, { additionalProperties: false });

export const collectorOutputBaseSchema = Type.Object({
  findings: Type.Optional(Type.Array(collectorFindingArgsSchema, {
    description: "本次收集到的逐条 findings；零 finding 的模板通知不得进入。正常完工无 finding 时省略。",
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
