/** One shared terminating receipt contract for review officers (#1028 / #1055). */
import { Type } from "typebox";

import { withTerminatingOutputDeclarations } from "./package-contracts/terminating-infrastructure.ts";

export const REVIEW_SUBMISSION_OUTPUT_TOOL_NAME = "ak_submission_output" as const;

/** Single schema copy of the review queue words. Runtime membership reads this set. */
export const REVIEW_QUEUE_WORDS = ["converged", "continue", "escalate"] as const;
export type ReviewQueueWord = (typeof REVIEW_QUEUE_WORDS)[number];
export const REVIEW_QUEUE_STATUSES: ReadonlySet<string> = new Set(REVIEW_QUEUE_WORDS);

const reviewStatusField = Type.Union(
  [
    Type.Literal(REVIEW_QUEUE_WORDS[0]),
    Type.Literal(REVIEW_QUEUE_WORDS[1]),
    Type.Literal(REVIEW_QUEUE_WORDS[2]),
  ],
  {
    description: "审核席本轮裁决的判别状态。",
  },
);

/** Shared optional review narrative fields (generation guidance only). */
const reviewNarrativeFields = {
  findings: Type.Optional(Type.Unknown({ description: "审核发现，原样留存" })),
  reason: Type.Optional(Type.Unknown({ description: "上呈理由" })),
  violations: Type.Optional(Type.Unknown({ description: "违规条目" })),
  conflicts: Type.Optional(Type.Unknown({ description: "待决冲突" })),
  fix: Type.Optional(Type.Unknown({ description: "仅 continue 时填补救说明（可写 summary 摘要，其余内容原样留存）；没有就填 null" })),
  classes: Type.Optional(Type.Unknown({ description: "已裁决 finding 类；可说明 name、owner、boundary、disposition，原样留存" })),
  note: Type.Optional(Type.Unknown({ description: "裁决附注" })),
  evidence: Type.Optional(Type.Unknown({ description: "留存证据" })),
  decisionGate: Type.Optional(Type.Unknown({ description: "需人权威处置的问题与选项；可说明 question、options，原样留存" })),
} as const;

/**
 * One object root. Codex structured output rejects a root anyOf, and status
 * stays a required three-state enum with no omitted-status failure branch.
 * External-dependency failure while the seat can still submit:
 * docs/adr/0057-schema-narrowing-cuts-the-required-set-not-the-declared-set.md
 */
export const reviewSubmissionSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      status: reviewStatusField,
      ...reviewNarrativeFields,
    },
    { additionalProperties: true },
  ),
);

/**
 * #1195 notary clause row: original ticket text, owner uuid (or null),
 * the runner line that utterance answered and what it asked about, and a one-line derivation.
 * Generation-required on notary only; package still records as-is.
 */
export const notaryClauseItemSchema = Type.Object(
  {
    clause: Type.String({
      description: "票面条款原文（改变实际行为的条款；不合并、不改写）",
    }),
    ownerUuid: Type.Union([Type.String(), Type.Null()], {
      description: "推出该条的陛下原话 uuid；无原话则 null",
    }),
    answered: Type.Union([Type.String(), Type.Null()], {
      description:
        "那句原话所答的 runner 句原文（问句、选项、表格行，照抄）；陛下独立提出、不是在答谁的，填 null",
    }),
    askedObject: Type.Union([Type.String(), Type.Null()], {
      description: "所答那句问的是哪件事（它的对象）；answered 为 null 时同为 null",
    }),
    derivation: Type.String({
      description:
        "一句推导：从原话哪个意思到该条款。answered 不为 null 时，条款的对象须在 askedObject 之内，或另有原话点名更大的对象，ownerUuid 才站得住，否则填 null；陛下独立提出的原话直接按它的意思推",
    }),
    sealed: Type.Union(
      [Type.Literal("最后一签时已在条款表"), Type.Literal("最后一签后才出现在票面")],
      {
        description:
          "对照起居录里本票最后一次签押（给事中／符宝郎 converged）那一轮符宝郎交的条款表：这条当时在不在。签押后才改进票面的条款是后者，没有过庭，不是现行票面；后者只在受审之物是大理寺的判词、修法方向或收敛的实现时出现。受审的是给事中对票面的判词（票庭，含修订后重送的），或票庭尚无签押、签押那一轮没有可对照的表，不论受审之物为何，每条都是前者。现行票面的更新时间只是线索（评论也会改它），定夺看条款在不在那张表里；表漏列的不算后者，拿不准就查 issue 的编辑记录",
      },
    ),
  },
  { additionalProperties: true },
);

export const notaryClausesField = Type.Array(notaryClauseItemSchema, {
  description:
    "票面逐条核旨表，每一轮都填，不论本轮受审的是票面还是大理寺的判词：现行票面每条改变实际行为的条款的原文、陛下原话 uuid、推导、是否在最后一签时就在表里。无原话则 ownerUuid 为 null。真无票对象没有票面，填空数组。",
});

/**
 * Notary generation schema (#1195): shared review face plus
 * required top-level clauses. Package execute does not reject a missing table.
 */
export const notaryReviewSubmissionSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      status: reviewStatusField,
      ...reviewNarrativeFields,
      clauses: notaryClausesField,
    },
    { additionalProperties: true },
  ),
);

/** Inspector whole-ticket complexity row: one quality-law deletion clause, answered for the whole ticket. */
export const ticketComplexityRowSchema = Type.Object(
  {
    class: Type.String({ description: "照抄《质量法》里那一句要求删除、合并、复用或不另写的条文" }),
    hits: Type.Array(Type.String(), {
      description: "本票净增里命中这一句的每一处 path:line，并写删到哪、并到哪；打开看过才算。一处没有为空数组，没有第三种答法",
    }),
    checked: Type.String({
      description: "为这一条打开比对过的几处 path:line：hits 为空时写每处为什么不算，不能只写未发现；有命中时写比对了哪些地方、命中在哪找到",
    }),
  },
  { additionalProperties: true },
);

/**
 * Inspector whole-ticket mechanism row: one added line that keeps state across calls, locks, caches, or adds a dependency.
 * Two row shapes, no third: the framework's example manages without the layer (official filled, 删), or it carries the
 * same layer itself (official null, 留). The union sits inside the array item, never at the root (see reviewSubmissionSchema).
 */
const mechanismRowBase = {
  where: Type.String({
    description:
      "本票生产代码净增里的那一行 path:line：新增依赖行、跨调用保存的状态（模块级或实例级的字典、集合、列表、LRU 等）、锁、缓存装饰或包装；一行一条，照 diff 列，不合并；测试夹具不列",
  }),
  keeps: Type.String({ description: "这一行让什么东西在两次调用之间留下来，或挡住什么" }),
  layer: Type.Integer({ description: "从本票起点到 HEAD，这是第几处这样的新增（含前几轮已署过的）" }),
} as const;

const MECHANISM_FRAMEWORK_RULE =
  "框架是仓库 ADR 或票面点名的那一个（读写模型、Web、测试等框架），不是席位自选；实现这一层所用的库（ORM、缓存库、解析库）不是框架，它的 API 页或示例填不进这格——那答的是「这层怎么做」，这格问的是「示范不带这层怎么办」";

export const mechanismRowSchema = Type.Union(
  [
    Type.Object(
      {
        ...mechanismRowBase,
        official: Type.String({
          description: `这段代码所属应用框架的官方示范里，不带这一层时同一关切怎么处理：先写框架名，再链接＋原句（示范里直接读、直接查、交给框架哪项设置）。${MECHANISM_FRAMEWORK_RULE}`,
        }),
        disposition: Type.Literal("删：示范不带这一层也处理得了", { description: "official 填了字，这一行只能是这个处置" }),
      },
      { additionalProperties: true },
    ),
    Type.Object(
      {
        ...mechanismRowBase,
        official: Type.Null({
          description: `示范代码本身就为同一关切带同样的状态、锁、缓存或依赖：填 null，并在 keeps 末尾写框架名与示范里那一处。${MECHANISM_FRAMEWORK_RULE}`,
        }),
        disposition: Type.Literal("留：示范本身就为同一关切带同样的层", { description: "official 为 null，这一行只能是这个处置" }),
      },
      { additionalProperties: true },
    ),
  ],
  { description: "两种行形，没有第三种：示范不带这一层也处理得了（official 填字，删）；示范本身就带同样的层（official null，留）" },
);

/** Inspector generation schema: shared review face plus the required whole-ticket complexity answer (package records as-is). */
export const inspectorSubmissionSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      status: reviewStatusField,
      ...reviewNarrativeFields,
      suspect: Type.String({
        description: "整票里最可疑、最像能删能并的一处 path:line，以及为什么留着；说不清就该进 hits",
      }),
      ticketComplexity: Type.Array(ticketComplexityRowSchema, {
        description:
          "整票复杂度：本票起点（本分支与家族分支或目标分支的 git merge-base）到 HEAD 的生产与测试净增，对《质量法》里每一句要求删除、合并、复用或不另写的条文各答一行。前几轮已署过的改动也算在内。",
      }),
      mechanisms: Type.Array(mechanismRowSchema, {
        description:
          "整票机制层：本票起点到 HEAD 生产代码新增的每一处依赖行、跨调用状态、锁、缓存装饰或包装，各一行，前几轮已署过的也列，测试夹具不列；一处没有为空数组。",
      }),
    },
    { additionalProperties: true },
  ),
);

export type ReviewSubmission = { readonly status?: unknown; readonly [key: string]: unknown };
