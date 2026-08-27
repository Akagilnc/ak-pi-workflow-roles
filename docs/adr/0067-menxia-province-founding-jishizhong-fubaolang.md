# 0067 — 门下省开府：质量保证省与给事中、符宝郎

Status: accepted（陛下 2026-08-11 grill 收口「暂定这样吧」并令「先落设计。再 /to-spec」；后续 /to-spec（#430）与 ADR 0072 均已收口 accepted，2026-08-24 陛下确认设计早已定、状态系漏转，补转 accepted。decision keys 与绑定原话见下）

**门下省**定为质量保证省：与干活的尚书省角色（将作监/修内司）对举，下辖收证（Collector）与两名新官——**给事中**（对将作监/修内司产出行复杂度与测试质量两轴质检）、**符宝郎**（独立文书核验：引语真伪与票面对齐，进单口与交卷口双位）。（勘正 2026-08-24，陛下核史：审刑院系宋帝特设、置于禁中直属皇帝、不隶三省，元丰改制后废；工厂中亦直属陛下、自有挂钩，不入门下省编制——原文误列其为门下省下辖。）本 ADR 只立**角色与能力**，不立编排：挂哪站、是否默认挂、未来独立流程，均归调用方与后续决策（[ADR 0010](0010-callers-own-role-composition-and-repetition.md)）。

## Decision keys（逐条绑陛下原话）

| key | 值 | 绑定原话 |
| --- | --- | --- |
| `province-purpose` | `quality-assurance-province` | 「尚书省是干活的， 门下省属于质量保证衙门」「更多的是质检，这个质检不是狭隘的代码实现有没有bug。这个是御史台的活」 |
| `staged-gates-concept` | `completion-gates-not-wired` | 「我想把它做成几个阶段性的闸门」「目前想法是。 设计完成，开发完成，修理完成，提交完成」（概念框架；具体布线未立，见 `scope`） |
| `scope` | `roles-and-capabilities-only` | 「而且调用方本来也可以随便指定一个角色调用。所以只考虑角色和能力。不考虑编排」 |
| `verdict-form` | `one-step-in-session-bounce` | 「如果类似审刑院那样。就是session内直接打回」「肯定就是审刑院的形态了」 |
| `bounce-routing` | `back-to-original-flow` | 「封驳后打回原流程修复」；进单口：「可以直接打回大理寺」 |
| `jishizhong-axes` | `complexity+test-quality-one-role` | 「将作监 和 修内司 肯定就是代码复杂度/测试质量」「复杂 测试 本来也不想分两个衙门」「测试是不是又复杂了又一大堆垃圾测试耗时了」 |
| `fubaolang-axes` | `quote-fidelity+ticket-alignment-standalone` | 「陛下的话有没有乱引（出现好多次了，我没下结论的话说是我下的，实际上不是我）」「票面需求对得上吗？」「比如核查任务派单是否违宪这种，是否有乱说我的决定，或者明显超出/缺少票面要求」「符宝郎确实很重要。单独审计好像是需要的」 |
| `depth-principle` | `fewer-duties-deeper` | 「一个衙门职责越多，深度越弱」 |
| `narrow-bugs` | `remain-reviewer` | 「这个质检不是狭隘的代码实现有没有bug。这个是御史台的活」 |
| `audit-subjects` | `coder-fixer-judge-outputs` | 「考虑 将作监，修内司，大理寺」 |
| `shenxingyuan` | `unchanged-tentative` | 「大理寺的话目前已经有审刑院了。是完善审刑院的职责还是加我还没想好」＋收口「暂定这样吧」（本轮零改动；乱引轴由符宝郎独立承担） |
| `names` | `jishizhong+fubaolang` | 「给事中和符宝郎倒是合适」 |
| `collector-position` | `one-bureau-of-menxia` | 「这最多算是门下省下的一个衙门。离门下省完全体还差得远呢」 |
| `future-flow` | `independent-flow-deferred` | 「但是后面有可能有独立流程。不过那个再说」 |

本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张陛下 authority。

## 能力契约

- **形态＝审刑院式**：独立打包 Pi 子进程、session 内挂接、经 run 绑定取卷工具自取证据（[#264](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/264) 已建）。
- **一步制**：查出即裁决——typed 判词（放行 / 封驳＋findings 引法条），session 内直接打回：交卷口打回产出方、进单口打回签发方（如大理寺的派单）；修复后回同一道闸复检。争议不省际互裁，上抛陛下。
- **法源**：给事中＝宿主全局宪法 #12（复杂度即成本：能删不加、机制三问、同构重复）与 #13（测试质量五尺）；符宝郎＝#11 裁决法理与授权载体纪律。soul 蒸馏走陛下直批通道，非本 ADR 射程。
- **引语硬锚**：凡「陛下拍定 X」必须指向可追溯真源（真 user turn / 冻结授权载体）；指不出＝封驳。

## 射程与既有 ADR 关系

- **不 supersede [ADR 0066](0066-worker-typed-submission-gates.md)**：修内司合规审计腿退役维持、将作监合规腿仍不加。给事中不是合规腿复活：法不同——0066 退役的是与下游四层兜底重叠的**合规**审计（观察窗内零真捕获）；给事中执掌的复杂度/测试质量两轴现无人执掌（陛下观察：「御史台现在检查出来的复杂度和测试简化/必要性 感觉几乎没有」）。开 PR 前交卷挂钩见 [ADR 0072](0072-menxia-pre-pr-submission-hooks.md)。
- 不动御史台（狭义 bug/correctness 主业）、Soul 审刑院（现职）、Collector（收证职）之职掌与 soul。
- Collector 词表正名：「门下省」自本 ADR 起是省名；Collector 是其收证衙门。

## Considered Options

- **封驳过大理寺再裁（两步制）**：驳回——陛下「如果又要过大理寺是不是有点奇怪」，终拍一步制「就是session内直接打回」。
- **复杂度/测试分设两官**：驳回——陛下「复杂 测试 本来也不想分两个衙门」。
- **扩审刑院职责收编乱引轴**：未采——陛下「一个衙门职责越多，深度越弱」；由符宝郎独立成官消解，审刑院零改动。

## 修正案：增设左拾遗（2026-08-27，owner 拍）

- 门下省增设第三席**左拾遗**（机器名 `gleaner-left`）：合并候选颁下之前，以无锚定的线上 bot 视角对全幅 diff 作冷眼评审。风闻奏事、言不为狱：只上弹章、无封驳权，弹章由 runner/大理寺裁处。Soul＝`souls/gleaner-left.md`。
- 法源原话：「因为我发现线上bot老是能审出不少问题。我觉得这个职责我想收到门下省，再合并之前做一次模仿线上bot视角的评审」；定名原话：「很好。左拾遗。英文名直接加left，或者简写的_l」。
- 与本 ADR decision key `narrow-bugs=remain-reviewer`（「这个是御史台的活」）的关系：御史台仍是带票面锚定的狭义 bug 评审真源；左拾遗的「bug 与边界」为合并前无锚定的风闻扫掠，弹章无权威、不取代御史台职掌——同轴两眼，权只一处。
- 机器席位另票施工（缓至 #495 dogfood 拍板后）；`souls/gatekeeper.md` 派官规则与 CONTEXT.md 门下省词条随席位施工同步修订（本批不动，避免法先于机器）。
