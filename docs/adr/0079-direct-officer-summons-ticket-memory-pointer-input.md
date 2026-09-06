# 0079 — 交卷闸直接传召、衙门按票记忆、传召只递指针

Status: accepted（母票 #630；owner 2026-09-03 grill 收口「可以」；实施分票 #634）

本 ADR 是 #630 三项一体改造的薄决策页；历史 ADR 正文不回改，承继与修正关系记于本页。

## Decision keys

| key | 值 | 绑定 owner 原话 | 承接 |
| --- | --- | --- | --- |
| `direct-officer-summons` | 交卷闸按受审物直接传召具体衙门，不起门下省子 session；门下省仍可独立调用 | 「我的意思是。不再调用门下省，直接调用具体衙门。所以不存在你说的这个问题了」；「门下省保持一个独立角色，只是暂时不主动去调用。调用者想自己调用门下省还是可以调用」 | #634 |
| `ticket-seat-memory-officer-principal` | **2026-09-06 二次修正：作废自动同票 resume。** 任何传召一律新起 run；resume 只经显式 `ak-role resume <runId>`；衙门记忆由起居录随案递送承担（ADR 0081）。原值：察院／符宝郎／审刑院同票再传召 = resume 该席上一次的 run | 「所有给事中，符宝郎，审刑院，察院，都改成resume而不是每次都是全新起腿」；「和现在一致。没有任何变化。只是把新起变成resume，也就是让衙门有记忆。调用本身不改」 | #636 |
| `ticket-seat-memory-countersign-principal` | **2026-09-06 二次修正：同上作废。** 给事中传召一律新起 run；resume 只经显式入口。原值：给事中同票再传召 = resume 该席上一次的 run | （同上记忆原话；给事中席单独承接） | #637 |
| `summons-pointer-input` | 传召输入由代码精准控制，只给卷宗指针，不转述内容 | 「差不多。正常应该就是这样。而且这个输入是代码控制的，所以可以完全精准。不像你调用的，根本记不住😂」 | #632 |

本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张 owner authority。

## 具名承继与修正

- **ADR 0072**：`invoke-province=submission-hook-calls-menxia`、`dispatch=menxia-soul-by-subject` 及 Considered Options 中「交卷钩直接起给事中/符宝郎」被驳回的结论，由后出 `direct-officer-summons` 取代。`jishizhong-hook`、`fubaolang-hook`、`bounce`、`skip-statuses`、`shenxingyuan` 保留；`post-pr` 仍 deferred。
- **ADR 0074**：交卷闸段按直接映射改写；`gate-non-mandatory` 仅描述门下省作为独立角色的派发自由，保留。其余键不改，`three-state-reuse` 由 #657 承接。
- **ADR 0075**：`no-global-ticket-flag` 与 `diarist-resolves-ticket-llm-layer` 中调用面三处「给事中/符宝郎可带 --ticket」结论，由 #630「这个旗帜本身就很可笑！一起去掉」具名修正：角色受理与记忆绑定不再有显式票号旗或附件 frontmatter 通道，LLM 认票为唯一路径；施工由 #635 承接。其余十四键保留。
- **ADR 0077 / ADR 0048**：`record-scope-phase-two`、`live-session-in-books` 与直写律保留。传召一律新起 run；resume 只经显式 `ak-role resume <runId>`；不设跨 run 的记忆 principal / nest / binding（2026-09-06 两次修订，见下）。
- **ADR 0066**：`gate-power`、`gate-1-status-matrix`、`durability-entry` 保留并由本票复用；其余九键不改。
- **ADR 0067**：`scope`、`verdict-form`、`bounce-routing`、`audit-subjects`、`jishizhong-axes`、`fubaolang-axes` 保留，作为直接传召目标的职掌依据；其余八键不改。

## 映射与承接

交卷闸确定映射为：将作监/修内司完成侧交卷→察院；大理寺判牒→符宝郎；给事中署章→符宝郎。门下省 soul、`dispatch/pass` 出参与公开 `ak-role gatekeeper` 入口不变。

本票 #634 只施工直接传召。指针输入由 #632、删票号旗由 #635、察院/符宝郎/审刑院记忆由 #636、给事中记忆由 #637、最终真跑由 #638 承接。

**修订（2026-09-06，owner）：** 原文「每次调用仍独立直写自己的 run；只有逻辑记忆 principal 跨 run 续用」无 owner 原话，系起草时自加；owner 原话仅「都改成resume而不是每次都是全新起腿」「只是把新起变成resume，也就是让衙门有记忆。调用本身不改」，并于 2026-09-06 反问「同一票传召正常不就是一个resume吗？」。据此同票再传召 = resume 该席上一次 run；#636 已合并的 ticket-seat-memory nest / binding 机制与 #637 分支按此删除重做（#637 承接）。

**二次修订（2026-09-06 晚，owner）：** 自动同票 resume 作废。实证：#708 给事中传召自动 resume 了该票最新 run（01a075d2，会话 754,851 token），被模型 500,000 上限拒绝，该票在该席永久不可传召。owner 原话：「resume不是要你指定才会触发吗？」（卷 47ef0224 L108494）；对「1. 自动同票 resume 撤掉：只有显式 `ak-role resume <runId>` 才 resume；新传召一律新 run（票记忆靠起居录随案递送）」答「1」（L108511）。据此：`tryResumeSameTicketSeatRun` 及其在给事中／察院／符宝郎／审刑院各入口的自动调用删除；显式 `ak-role resume` 入口不变；#675 中按「同票传召＝resume」拓扑钉的测试按新口径改。施工票见承接列。
