# 0075 — 司天台每票起居录（ticket-provenance）与起居郎流水线工序

Status: accepted（owner 2026-08-31 多轮 grill 收口；票庭 run `01a05604-e46b-7e1b-8d5d-cb618de4c1ae` countersignStatus=converged 全票全审第七轮署；decision keys 与绑定原话见 #582）

## 承继 / 修正关系

本 ADR **修正** [ADR 0065](0065-sitian-phase-two-records-have-one-entry.md) 的 `record-scope-phase-two=pi-session-records-only`：二期 scope 在「Pi session 记录」之外，新增 kind `ticket-provenance`，收录 cc session 誊录块 / issue 面 / ADR 锚。历史 ADR 正文不回改；承继关系由本票记载（同 [ADR 0074](0074-gate-province-reorg-jishizhong-chaiyuan-split.md) 先例）。appender 内核 / 落盘拓扑 / `--source-run` / submission ledger **零改动**——`kind` 本为开放集，subject 哈希分区既有。

## Decision keys（逐条绑 owner 原话；真源票面 #582）

| key | 值 | 绑定原话（逐字） |
| --- | --- | --- |
| `ticket-provenance-file` | 每票一份起居录，送司天台 | 「立文件。送司天台记录。所以每个票都应该有的一份文档。免得后续还要去session大海里翻对话。」 |
| `diarist-generates` | 起居录由独立机械/llm 件生成，定名起居郎 | 「起居录的生成我觉得应该是一个机械角色/llm角色。 起居郎」 |
| `diarist-llm-collector` | 起居郎＝LLM 语义收集，机械层为保全带 | owner 条件句「机械的能不能做得到…如果可以那就机械」＋实测后「我现在倒是觉得上llm说不定更好」＋「llm和v3都给」；票庭依实测续审裁定处方 A |
| `transcribe-whole-blocks` | 誊录整块对话，不指针化 | 「起居郎不管票面写不写引语，只负责把这个issue的决策相关抓下来。最简单的就是把那一块都拿过来存着当案卷。」 |
| `immutable-transcript-dry-exception` | 不可变记录间不适用 DRY | 「这种时候不要将就什么dry。两边都是不会去改动的记录不存在dry这一说」 |
| `cc-sessions-first` | 对话源 v1＝cc session 卷优先 | 「基本上设计都在cc。可以先翻cc的。」 |
| `notary-inner-gate` | 符宝郎挂给事中交卷闸 | 「1 肯定是a」 |
| `no-global-ticket-flag` | 不加全局 --ticket；给事中/符宝郎可有 | 「我认为不需要改目前的调用方式也能知道做的是哪张票。只有给事中这种明确审票的衙门才需要这个参数。符宝郎也可以要」 |
| `diarist-before-countersign` | 起居郎＝给事中前一站；先后非调用 | 「第一步先起居郎，然后才是给事中。这句话你是怎么能理解成，给事中调用起居郎？」 |
| `refresh-every-court` | 每次过庭都跑（增量幂等） | （对「每次受理都跑」荐案）「行。先这样。派给事中审票吧」 |
| `no-backfill` | 存量票不补档 | 「8 不补了」 |
| `names` | 起居录 / `diarist` / `ticket-provenance` | 「9 可以」 |
| `github-face-local-only` | 人读面只落本地＋票面指针，不自动回贴 | 「a就行了。」 |
| `ticket-keyed-history` | 票键为主组织轴 | 「历史跟着票走比跟着runid走合适。runid有啥用？其实没啥用」 |
| `sitian-scope-amendment` | 修正 ADR 0065 二期 scope，新增 ticket-provenance | 由 `ticket-provenance-file`+`transcribe-whole-blocks`+`cc-sessions-first` 三键原话直接授权 |

本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张 owner authority。

## 机制骨架

- **真源**：司天台 JSONL，kind=`ticket-provenance`，subject＝票号字符串；落盘仍走 `resolveSitianRecordPathInLedger`（`bookDir/ticket-provenance/<sha256(票号)>/records.jsonl`）。
- **逐收录块一条 entry**（誊录制）：`basis` / `sourceKind` / `sourceRef` / `transcript` / `timestamp`。追加不改写。
- **人读面**：同分区 md 渲染视图；只有 JSONL 权威。
- **起居郎（`diarist`）**：流水线步，非公开席位。LLM 语义收集＋机械保全（来源枚举、逐字材料、去重滤通知、幂等落盘、LLM 引语逐字反验——失败留真因、该引语拒入录）。**相关性只由 LLM 裁决**；机械层不得以票号/引语/关键词散文命中排除来源（锚定宪法）。散文锚点仅作反验笔记，不构成遗漏闸。
- **时序**：票庭流水线在给事中席位 turn **前**跑起居郎；先后≠调用；调用者无感；每次过庭都跑。
- **符宝郎内闸**：给事中交卷闸出席符宝郎（与大理寺闸 gatekeeper→notary 同构）；缺录/缺条打回给事中。
- **调用面**：`--ticket` 只加给事中与符宝郎；其余席位零改动。

## 与既有 ADR

- 修正 0065 二期 scope；不改 appender/reader 内核契约。
- 补 [ADR 0074](0074-gate-province-reorg-jishizhong-chaiyuan-split.md) 票庭流水线前序工序与给事中交卷内闸；不改票庭五问与三态判词。
- 符宝郎 soul 两步（读录→核旨）已先行（PR #581）；本 ADR 只落录的生成与闸出席。
- 不 supersede [ADR 0072](0072-menxia-pre-pr-submission-hooks.md) 工人/判卷交卷钩。
