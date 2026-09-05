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
 * #676 A: role-decided target bind. The model judges task materials and submits
 * the chosen PR and/or issue identity; runtime only performs online association
 * for the role-chosen ticket — never scrapes task text to lock a target.
 */
export const collectorBindTargetArgsSchema = Type.Object({
  prNumber: Type.Optional(Type.Unknown({
    description: "角色判定的本仓 PR 号（正整数）。与 issueNumber 二选一或同指唯一目标。形状指引，非 schema 闸。",
  })),
  issueNumber: Type.Optional(Type.Unknown({
    description: "角色判定的本仓 issue 号（正整数）；runtime 经线上关联解析唯一 PR。形状指引，非 schema 闸。",
  })),
}, { additionalProperties: true });

/**
 * #641 chain① / #676 C / ADR 0057: nested finding item declarations for model
 * guidance. Host must not pure-shape-reject the envelope (第 0 条). Runtime binds
 * resolvable evidence pointers only; unprojected content stays distinguishable.
 */
const collectorFindingItemDeclaration = (() => {
  // Nested declarations for model guidance only — open required so host cannot
  // pure-shape-reject missing optional fields (第 0 条 / ADR 0057 / #676 C).
  const item = Type.Object(
    {
      evidenceId: Type.Unknown({
        description: "observe 返回的材料指针（必填语义）",
      }),
      category: Type.Unknown({
        description: "简短归类标签，不是摘要",
      }),
      summary: Type.Unknown({
        description: "哪个 bot、什么问题的摘要；不誊抄正文",
      }),
    },
    {
      additionalProperties: true,
      description:
        "单条 finding 指针：evidenceId + 可选 category/summary。形状指引，非 schema 闸。",
    },
  );
  (item as unknown as { required: string[] }).required = [];
  return item;
})();

/**
 * Field declarations + descriptions are guidance for the model — host must not
 * pure-shape-reject the envelope (第 0 条 / ADR 0057).
 */
export const collectorOutputBaseSchema = openToolObject(
  Type.Object({
    // No root type:array — host must not shape-reject non-array findings (#676 C).
    // Nested item declarations ride `items` for registration preservation (ADR 0057).
    findings: Type.Unsafe({
      description:
        "本次收集到的逐条 findings（指针数组为规范形）。零 finding 的模板通知不得进入；正常完工无 finding 时省略。形状指引，非 schema 闸。",
      items: collectorFindingItemDeclaration,
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
export type CollectorBindTargetArgs = Static<typeof collectorBindTargetArgsSchema>;
export type CollectorOutputArgs = Static<typeof collectorOutputArgsSchema>;
