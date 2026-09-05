# 0079 — 交卷闸直接传召、衙门按票记忆、传召只递指针

Status: accepted（母票 #630；owner 2026-09-03 grill 收口「可以」；实施分票 #634）

本 ADR 是 #630 三项一体改造的薄决策页；历史 ADR 正文不回改，承继与修正关系记于本页。

## Decision keys

| key | 值 | 绑定 owner 原话 | 承接 |
| --- | --- | --- | --- |
| `direct-officer-summons` | 交卷闸按受审物直接传召具体衙门，不起门下省子 session；门下省仍可独立调用 | 「我的意思是。不再调用门下省，直接调用具体衙门。所以不存在你说的这个问题了」；「门下省保持一个独立角色，只是暂时不主动去调用。调用者想自己调用门下省还是可以调用」 | #634 |
| `ticket-seat-memory-officer-principal` | 察院／符宝郎／审刑院以票号＋席位为逻辑记忆 principal 跨 run 续用；每次调用仍独立直写自己的 run | 「所有给事中，符宝郎，审刑院，察院，都改成resume而不是每次都是全新起腿」；「和现在一致。没有任何变化。只是把新起变成resume，也就是让衙门有记忆。调用本身不改」 | #636 |
| `ticket-seat-memory-countersign-principal` | 给事中以票号＋席位为逻辑记忆 principal 跨 run 续用；每次调用仍独立直写自己的 run | （同上记忆原话；给事中席单独承接） | #637 |
| `summons-pointer-input` | 传召输入由代码精准控制，只给卷宗指针，不转述内容 | 「差不多。正常应该就是这样。而且这个输入是代码控制的，所以可以完全精准。不像你调用的，根本记不住😂」 | #632 |

本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张 owner authority。

## 具名承继与修正

- **ADR 0072**：`invoke-province=submission-hook-calls-menxia`、`dispatch=menxia-soul-by-subject` 及 Considered Options 中「交卷钩直接起给事中/符宝郎」被驳回的结论，由后出 `direct-officer-summons` 取代。`jishizhong-hook`、`fubaolang-hook`、`bounce`、`skip-statuses`、`shenxingyuan` 保留；`post-pr` 仍 deferred。
- **ADR 0074**：交卷闸段按直接映射改写；`gate-non-mandatory` 仅描述门下省作为独立角色的派发自由，保留。其余键不改，`three-state-reuse` 由 #657 承接。
- **ADR 0075**：`no-global-ticket-flag` 与 `diarist-resolves-ticket-llm-layer` 中调用面三处「给事中/符宝郎可带 --ticket」结论，由 #630「这个旗帜本身就很可笑！一起去掉」具名修正：角色受理与记忆绑定不再有显式票号旗或附件 frontmatter 通道，LLM 认票为唯一路径；施工由 #635 承接。其余十四键保留。
- **ADR 0077 / ADR 0048**：`record-scope-phase-two`、`live-session-in-books` 与直写律保留并作窄限定：每次调用仍为独立 run，受理单、附件、artifacts、终局均在自己的 run 目录直写；只有逻辑记忆 principal（票号＋席位）跨 run 续用，落司天台票键位置，直写且不复制卷宗。记忆施工由 `ticket-seat-memory-officer-principal`→#636、`ticket-seat-memory-countersign-principal`→#637 承接。
- **ADR 0066**：`gate-power`、`gate-1-status-matrix`、`durability-entry` 保留并由本票复用；其余九键不改。
- **ADR 0067**：`scope`、`verdict-form`、`bounce-routing`、`audit-subjects`、`jishizhong-axes`、`fubaolang-axes` 保留，作为直接传召目标的职掌依据；其余八键不改。

## 映射与承接

交卷闸确定映射为：将作监/修内司完成侧交卷→察院；大理寺判牒→符宝郎；给事中署章→符宝郎。门下省 soul、`dispatch/pass` 出参与公开 `ak-role gatekeeper` 入口不变。

本票 #634 只施工直接传召。指针输入由 #632、删票号旗由 #635、察院/符宝郎/审刑院记忆由 #636、给事中记忆由 #637、最终真跑由 #638 承接。
