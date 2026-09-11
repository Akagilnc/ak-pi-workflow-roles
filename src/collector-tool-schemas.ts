import { Type, type Static } from "typebox";
import { openToolObject } from "./open-tool-schema.ts";
import { withInfrastructureFailureDeclaration } from "./package-contracts/terminating-infrastructure.ts";

// #836 r16 class 3: execute() reads no params for this tool
// (src/collector-role.ts:431-459) — a closed root only rejects the role for
// saying more; no reader consumes extra fields.
export const collectorObserveArgsSchema = Type.Object({}, { additionalProperties: true });
// #836 r16 class 4: the regex was a real provider shape rejection ahead of the
// ledger's own identity check — src/collector-ledger.ts:911-972 already trims
// and enforces non-empty/lookup/marker/attemptKey identity on requestId once
// the tool receives it, so the duplicate pattern-based rejection is deleted
// (r15b decision, not reopened here).
export const collectorRequestArgsSchema = Type.Object({
  requestId: Type.String({
    minLength: 1,
    description: "请求身份（配置 id 或角色判定的稳定 id；首尾无空白）",
  }),
  snapshotId: Type.String({ minLength: 1, description: "最新留存观察快照" }),
  // #836 r16 class 3: body.minLength deleted — manifest-configured requestId
  // ignores body, and the unknown-requestId non-empty condition is a real
  // branch in src/collector-ledger.ts:922-951, not a provider shape gate.
  body: Type.Optional(Type.String({
    description: "角色判定的请求正文；request-manifest 未收录该 requestId 时必填",
  })),
}, { additionalProperties: true });
/** UTF-8 byte ceiling per handbook body — keeps next activation materials inside context budget. */
export const COLLECTOR_HANDBOOK_MAX_BYTES = 64 * 1024;
export const collectorHandbookWriteArgsSchema = Type.Object({
  scope: Type.Union([
    Type.Literal("general"),
    Type.Literal("repo"),
  ], { description: "general＝通用手册；repo＝当前仓库差异" }),
  body: Type.String({
    description: `手册全文（opaque 工作记忆；整份替换；UTF-8 至多 ${COLLECTOR_HANDBOOK_MAX_BYTES} 字节）`,
  }),
}, { additionalProperties: true });
export const collectorReadArgsSchema = Type.Object({
  evidenceId: Type.String({ minLength: 1, description: "observe 返回的材料证据 id（evidenceId）" }),
}, { additionalProperties: true });
export const collectorWaitArgsSchema = Type.Object({
  durationMs: Type.Integer({
    minimum: 1,
    description: "等待毫秒；实际睡眠不超过剩余等待窗（#678；无包内单次任意上限）",
  }),
}, { additionalProperties: true });

/**
 * #678 D4: open the wait window at a work step.
 * Omit startedAt for existing-PR trigger-phase end (= now).
 * Pass PR creation success time for new-PR auto-trigger rounds.
 */
// #836 r16 class 3: startedAt.minLength deleted — an empty string is already
// handled as omission by src/collector-role.ts:586-597, so the provider
// nonblank gate is not load-bearing for any branch.
export const collectorOpenWaitWindowArgsSchema = Type.Object({
  startedAt: Type.Optional(Type.String({
    description: "等待窗起点 ISO 时间；新建 PR 用创建成功时刻；省略＝现在（触发阶段结束）",
  })),
}, { additionalProperties: true });

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
export type CollectorOpenWaitWindowArgs = Static<typeof collectorOpenWaitWindowArgsSchema>;
export type CollectorBindTargetArgs = Static<typeof collectorBindTargetArgsSchema>;
export type CollectorOutputArgs = Static<typeof collectorOutputArgsSchema>;
