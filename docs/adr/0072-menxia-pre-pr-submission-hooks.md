# 0072 — 开 PR 前门下省交卷挂钩

Status: accepted（陛下 2026-08-23 grill 收口「可以」）

[ADR 0067](0067-menxia-province-founding-jishizhong-fubaolang.md) 只立角色与能力。本 ADR 落开 PR 前的交卷挂钩：钩上调门下省，不点名司官；省内按受审物派给事中或符宝郎。开 PR 之后整段后做。不改审刑院。

## Decision keys（逐条绑陛下原话）

| key | 值 | 绑定原话 |
| --- | --- | --- |
| `invoke-province` | `submission-hook-calls-menxia` | 「调省。必然的」「后续我只需要调整门下省的逻辑就行了」 |
| `jishizhong-hook` | `coder-fixer-submission` | 「A 交卷，就是类似现在审刑院对大理寺的机制」 |
| `fubaolang-hook` | `judge-submission-after-draft-before-auditor` | 「不。我还是应该是B」（拟判已写、审刑院之前） |
| `dispatch` | `menxia-soul-by-subject` | 「票审肯定是符宝郎，后面代码审才是给事中。这个属于门下省怎么判断的事情。或者说。是门下省的soul怎么写的问题」 |
| `shenxingyuan` | `judge-only-unchanged` | 「A啊。我又没说要改审刑院」 |
| `bounce` | `rewrite-submission-not-failure` | 「打回是让重新改了交卷。不是失败。」 |
| `skip-statuses` | `planned-refused-unfinished-skip-menxia` | 「planned refused unfinished 我觉得门下省都不用调吧」 |
| `post-pr` | `deferred` | 「q8后续再改造吧……目前主要精力还是聚焦在 开出pr这个节点之前」 |

本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张陛下 authority。

## 挂钩

交卷工具内起独立子会话，形态比照审刑院对大理寺。封驳＝当场打回重写交卷，本局未失败。

| 交卷 | 是否调门下省 | 省内 | 审刑院 |
| --- | --- | --- | --- |
| 将作监 / 修内司 `completed` / `partially_completed` | 调 | 给事中 | 不挂 |
| 将作监 / 修内司 `planned` / `refused` / `unfinished` | 不调 | — | 不挂 |
| 大理寺（审票或判卷） | 拟判入卷后调 | 符宝郎 | 现有，零改动 |

给事中不在判卷交卷上再跑。工人完成侧集合与 [ADR 0066](0066-worker-typed-submission-gates.md) 交卷闸同一张表。

## 与既有 ADR

- 补 0067 未立的编排；不改 0067 角色与能力。
- 不 supersede 0066：给事中不是修内司合规审刑院还魂。
- 不改审刑院职掌、挂钩、soul。
- 给事中、符宝郎、门下省取证权见 [ADR 0064](0064-evidence-roles-have-unrestricted-tools.md) 2026-08-23 扩射程。
- 开 PR 后通进司总闸不在本条。

## Considered Options

- **交卷钩直接起给事中/符宝郎**：驳回——陛下「调省。必然的」，以后只改门下省内政。
- **给事中挂大理寺判卷交卷**：驳回——给事中受审物是工人产出；判卷交卷只派符宝郎。
- **修内司交卷加审刑院**：未提出；审刑院维持只挂大理寺。
- **非完成侧仍调门下省**：陛下倾向不调；完成侧集合已在交卷缝上，跳过不麻烦。
