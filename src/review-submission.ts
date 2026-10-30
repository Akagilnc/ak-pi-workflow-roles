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
      description: "所答那句问的是哪件事：照抄 answered 里点名对象的原词，不转述、不概括（那句问「缓存是解禁还是维持禁令」，这格就是「缓存禁令」，不是「运行时 DRY 修复」）；answered 为 null 时同为 null",
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
 * Notary ADR-landing row (2026-10-30, 陛下: summoned by the countersign gate, the notary checks the grill's ADR
 * against the owner's words). One row per owner decision at the direction/design/decision level; two row shapes,
 * no third: the ADR text carries the sentence (adr filled, 落了) or it does not (adr null, 未落). A ticket clause,
 * a CLAUDE.md index line, a verdict citation or an ADR title is not a landing.
 */
const adrRowBase = {
  ownerUuid: Type.String({ description: "陛下拍定那句原话的 uuid" }),
  decided: Type.String({
    description: "那句拍定了什么：照原词，不概括、不合并（四层分工、四条规矩、账本只存事实……一条一行）",
  }),
};
export const notaryAdrRowSchema = Type.Union([
  Type.Object(
    {
      ...adrRowBase,
      adr: Type.String({ description: "落处：docs/adr 文件名＋文内承载这条拍定的那一句原文（照抄）" }),
      landed: Type.Literal("落了：ADR 文内有承载它的句子"),
    },
    { additionalProperties: true },
  ),
  Type.Object(
    {
      ...adrRowBase,
      adr: Type.Null(),
      landed: Type.Literal(
        "未落：ADR 文内没有承载它的句子；票面条款写了、CLAUDE.md 一类索引说某份 ADR 含它、判词引过它、ADR 标题像，都不是落处",
      ),
    },
    { additionalProperties: true },
  ),
]);

export const notaryAdrField = Type.Array(notaryAdrRowSchema, {
  description:
    "ADR 落处表：受审之物是给事中对票面的判词（票庭）时填——起居录与源卷里陛下拍定的方向、设计、决策一级的东西，每条一行，到 docs/adr 里找承载它的那一句。有「未落」行，status 只能是 escalate，拍定原文与它该进哪份 ADR 列进 decisionGate，进不进由陛下定。受审之物是大理寺的判词、修法方向或收敛的实现时为空数组。",
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
      adr: notaryAdrField,
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

/**
 * The two row shapes of the 存废尺 (existence ruler), with any extra per-row fields a seat needs.
 * `base` names the thing (a production line for 台院／大理寺／审刑院, a ticket clause for 中书省／给事中);
 * `labels` are the two dispositions (删／留 for code, 不要／要 for clauses). The coupling is the same everywhere:
 * official filled = the example manages without it; official null = the example carries the same layer.
 */
type RowFields = Record<string, ReturnType<typeof Type.String> | ReturnType<typeof Type.Integer> | ReturnType<typeof Type.Union>>;
const existenceRowUnion = (
  base: RowFields,
  labels: { readonly without: string; readonly carries: string; readonly evidenceField: string },
  extra: RowFields = {},
) =>
  Type.Union(
    [
      Type.Object(
        {
          ...base,
          official: Type.String({
            description: `这段代码所属应用框架的官方示范里，不带这一层时同一关切怎么处理：先写框架名，再链接＋原句（示范里直接读、直接查、交给框架哪项设置）。${MECHANISM_FRAMEWORK_RULE}`,
          }),
          disposition: Type.Literal(labels.without, { description: "official 填了字，这一行只能是这个处置" }),
          ...extra,
        },
        { additionalProperties: true },
      ),
      Type.Object(
        {
          ...base,
          official: Type.Null({
            description: `示范代码本身就为同一关切带同样的状态、锁、缓存或依赖：填 null，并在 ${labels.evidenceField} 末尾写框架名与示范里那一处。${MECHANISM_FRAMEWORK_RULE}`,
          }),
          disposition: Type.Literal(labels.carries, { description: "official 为 null，这一行只能是这个处置" }),
          ...extra,
        },
        { additionalProperties: true },
      ),
    ],
    { description: `两种行形，没有第三种：示范不带这一层也处理得了（official 填字，${labels.without.split("：")[0]}）；示范本身就带同样的层（official null，${labels.carries.split("：")[0]}）` },
  );

const MECHANISM_LABELS = { without: "删：示范不带这一层也处理得了", carries: "留：示范本身就为同一关切带同样的层", evidenceField: "keeps" } as const;
const mechanismRowUnion = (extra: RowFields = {}) => existenceRowUnion(mechanismRowBase, MECHANISM_LABELS, extra);

export const mechanismRowSchema = mechanismRowUnion();

/** Auditor row: the inspector row plus what the judge's verdict said about this layer, verbatim, or null when the verdict never touched it. */
export const auditorMechanismRowSchema = mechanismRowUnion({
  judgeSaid: Type.Union([Type.String(), Type.Null()], {
    description: "大理寺判词里裁到这一层的那句原文（照抄）；判词没提这一层，填 null",
  }),
});

/** 存废尺 row for a ticket clause: what the clause makes exist, against the framework's example. */
const clauseRowBase = {
  clause: Type.String({ description: "现行票面里让某个机制存在的那条条款原文（照抄，不合并、不改写）" }),
  kind: Type.Union(
    [Type.Literal("明写机制：条款自己点名了状态、表、缓存、锁、依赖"), Type.Literal("只写结果：条款只提要求，现状代码满足不了，得长出机制才做得到")],
    { description: "两类都要列。第二类最容易漏：零重复、跨提交不重读、不建豁免、每 X 只做一次、永不 Y——这种句子没写机制两个字，却只能靠新状态、缓存、失效规则满足；先打开现状代码核一遍它做不做得到，做不到就是这类" },
  ),
  makes: Type.String({ description: "这条条款落实后会让什么东西存在：跨调用保存的状态、缓存、锁、失效规则、预计算、新依赖；写出它的形状。只写结果的条款，写满足它必须长出的那样东西" }),
} as const;
const CLAUSE_LABELS = { without: "不要：示范不带这一层也处理得了", carries: "要：示范本身就为同一关切带同样的层", evidenceField: "makes" } as const;
export const clauseExistenceRowSchema = existenceRowUnion(clauseRowBase, CLAUSE_LABELS);

/** Countersign generation schema: shared review face plus the 存废尺 over the current ticket's clauses (package records as-is). */
export const countersignSubmissionSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      status: reviewStatusField,
      ...reviewNarrativeFields,
      existence: Type.Array(clauseExistenceRowSchema, {
        description:
          "存废尺：现行票面每条让机制存在的条款各一行——明写机制的，和只写结果要求、现状代码满足不了的，两类都算——到 ADR／票面点名的应用框架官方示范里看不带它时同一关切怎么处理。有「不要」行在，不得署，封驳或上呈并点名那条。票面已写、前轮判词要求过、签发方答过、陛下对别的题点过头，都不是「要」的理由；「要」只认示范里带同样的层。一条没有为空数组。",
      }),
    },
    { additionalProperties: true },
  ),
);

/** Judge row: the mechanism row plus where the layer comes from — the implementation under judgment, or the judge's own prescription. */
export const judgeMechanismRowSchema = mechanismRowUnion({
  origin: Type.Union(
    [Type.Literal("实现净增：本票起点到所审 HEAD 的生产代码里已有的"), Type.Literal("本判处方：本轮判词的处方或约束落实后会长出的")],
    { description: "这一层从哪来。处方行的 where 写处方原文而不是 path:line；处方会长出示范不带的层，处方本身就不能开" },
  ),
});

/** Judge generation schema: shared review face plus the 存废尺 over everything the verdict rules on (package records as-is). */
export const judgeSubmissionSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      status: reviewStatusField,
      ...reviewNarrativeFields,
      mechanisms: Type.Array(judgeMechanismRowSchema, {
        description:
          "存废尺：所审实现从本票起点到 HEAD 生产代码新增的每一处依赖行、跨调用状态、锁、缓存装饰或包装各一行（origin 实现净增），再加本轮判词每条处方或约束落实后会长出的每一层各一行（origin 本判处方）。每行只问一件事：这一关切（读复用、并发、失效……）在 ADR／票面点名的应用框架官方示范里怎么处理——示范不带这一层也处理得了，就是删；不问票面那句要求能不能靠示范满足。票面要求超过示范的，行照填删，那句要求上呈。有「删」行：实现里的，判删或上呈，不得据以署收敛；处方里的，那条处方不能开。票面已写、前轮判词要求过、施工自述、陛下对别的题点过头，都不是「留」的理由。行只能进这张表：不另开字段存放，不留「待定」；一处没有为空数组。",
      }),
    },
    { additionalProperties: true },
  ),
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

/** Auditor generation schema: shared review face plus the complexity account of the implementation the verdict ruled on (package records as-is). */
export const auditorSubmissionSchema = withTerminatingOutputDeclarations(
  Type.Object(
    {
      status: reviewStatusField,
      ...reviewNarrativeFields,
      mechanisms: Type.Array(auditorMechanismRowSchema, {
        description:
          "复杂度账：大理寺本轮判词所裁的实现，从本票起点到该 HEAD 生产代码新增的每一处依赖行、跨调用状态、锁、缓存装饰或包装，各一行（同台院机制层表），再写判词对这一层说了什么；一处没有为空数组。判词署了而表里有「删」行判词没处置，就是错署。",
      }),
      runtime: Type.Array(
        Type.Object(
          {
            entry: Type.String({ description: "真实入口：你亲跑的命令原文（测试用例或程序入口）。票面、判词、施工记录、台院回执里点名过的每个真实入口都要有一行，一个不漏，再加你自己选的；数字只认自己跑出来的，不抄记录" }),
            atBase: Type.String({ description: "在本票起点（本分支与家族分支或目标分支的 git merge-base，同台院）上跑这一入口的机器输出：用时、SQL／读次数、峰值内存等能读到的数字；入口是本票新加、票起点上没有的，写「票起点无此入口」" }),
            atHead: Type.String({ description: "在所裁 HEAD 上跑同一入口的机器输出，同一机器同一环境" }),
            judgeSaid: Type.Union([Type.String(), Type.Null()], { description: "判词对这一入口快慢说的那句原文（照抄）；没说填 null" }),
            compared: Type.Union(
              [Type.Literal("HEAD 比票起点慢或读得多"), Type.Literal("HEAD 不比票起点慢、不多读"), Type.Literal("无从比：票起点无此入口，或这一端跑失败")],
              { description: "只认 atBase 与 atHead 并排的数字：用时或读次数任一变大就是第一种；一次性成本、CI 另算、不阻断都不是理由。第三种给两类行：票起点上不存在的入口（atBase 写「票起点无此入口」），或任一端跑失败（把失败输出原样写进那一端）；跑失败的行没解决前不得 converged" },
            ),
          },
          { additionalProperties: true },
        ),
        {
          description:
            "性能账（受审之物是大理寺判词时填；受审太医署时此表与 mechanisms 都为空数组）：票面涉及的真实入口，每个一行，票起点与所裁 HEAD 各亲跑一次并排记；至少一行是票起点上就有、两端都跑出数字的既有入口。有一行 compared 为「慢或读得多」而 judgeSaid 为 null，判词就是署了没处置，status 不能是 converged；有跑失败的行，或没有一行可比，status 同样不能是 converged。",
        },
      ),
    },
    { additionalProperties: true },
  ),
);

export type ReviewSubmission = { readonly status?: unknown; readonly [key: string]: unknown };
