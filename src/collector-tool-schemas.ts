import { Type, type Static } from "typebox";
import { COLLECTOR_ELIGIBILITY_MS } from "./collector-evidence.ts";

export const collectorObserveArgsSchema = Type.Object({}, { additionalProperties: false });
export const collectorRequestArgsSchema = Type.Object({
  requestId: Type.String({ minLength: 1, description: "配置请求身份" }),
  snapshotId: Type.String({ minLength: 1, description: "最新留存观察快照" }),
}, { additionalProperties: false });
export const collectorWaitArgsSchema = Type.Object({
  durationMs: Type.Integer({ minimum: 1, maximum: COLLECTOR_ELIGIBILITY_MS, description: "等待毫秒；单次上限五分钟且不超剩余资格" }),
}, { additionalProperties: false });
/** Runtime owns the observed groups; the model only signals sole-final submission. */
export const collectorOutputArgsSchema = Type.Object({}, { additionalProperties: true });
(collectorOutputArgsSchema as unknown as { required: string[] }).required = [];

export type CollectorObserveArgs = Static<typeof collectorObserveArgsSchema>;
export type CollectorRequestArgs = Static<typeof collectorRequestArgsSchema>;
export type CollectorWaitArgs = Static<typeof collectorWaitArgsSchema>;
export type CollectorOutputArgs = Static<typeof collectorOutputArgsSchema>;
