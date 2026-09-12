# 0075 — 司天台每票起居录（ticket-provenance）与起居郎（角色）

Status: accepted（owner 2026-08-31 多轮 grill 收口；票庭 run `01a05604-e46b-7e1b-8d5d-cb618de4c1ae` countersignStatus=converged 全票全审第七轮署；decision keys 与绑定原话见 #582；**2026-09-06 原地修正**：起居郎建制为角色，见 #708 r2 修订（#582 已关）与下表 `diarist-is-role`；**2026-09-07 #742**：`no-call-rule` 键值回到 L108274/L108315 射程；陛下「直接修正老的adr。我不认为让adr越来越多有什么好处」）

> **Supersession / 修订 (#836):** 删预绑票号覆盖起居郎自报、escalate 时删 sitian/ticketNumber、anchors 覆盖与失败行静默丢、白名单外整条丢。起居郎交什么记什么；投影失败只记「未投影」不丢原文。票号绑定改为随材料告知。

## 承继 / 修正关系

本 ADR **修正** [ADR 0065](0065-sitian-phase-two-records-have-one-entry.md) 的 `record-scope-phase-two=pi-session-records-only`：二期 scope 在「Pi session 记录」之外，新增 kind `ticket-provenance`，收录 cc session 誊录块 / issue 面 / ADR 锚。历史 ADR 正文不回改；承继关系由本票记载（同 [ADR 0074](0074-gate-province-reorg-jishizhong-chaiyuan-split.md) 先例）。appender 内核 / `--source-run` / submission ledger **零改动**。簿以下落盘拓扑由 [卷宗拓扑](../dossier-topology.md) 统一定义。

## Decision keys（逐条绑 owner 原话；真源票面 #582 r1，2026-09-06 起为 #708 r2 修订节；#582 已关）

| key | 值 | 绑定原话（逐字） |
| --- | --- | --- |
| `ticket-provenance-file` | 每票一份起居录，送司天台 | 「立文件。送司天台记录。所以每个票都应该有的一份文档。免得后续还要去session大海里翻对话。」 |
| `diarist-generates` | 起居录由独立机械/llm 件生成，定名起居郎 | 「起居录的生成我觉得应该是一个机械角色/llm角色。 起居郎」 |
| `diarist-llm-collector` | 起居郎＝LLM 角色，语义收集是其本职 turn；机械保全带为其工具门禁（2026-09-06 修正：不再起独立收集子进程，引擎/模型走席位表） | owner 条件句「机械的能不能做得到…如果可以那就机械」＋实测后「我现在倒是觉得上llm说不定更好」＋「llm和v3都给」；票庭依实测续审裁定处方 A |
| `transcribe-whole-blocks` | 誊录整块对话，不指针化 | 「起居郎不管票面写不写引语，只负责把这个issue的决策相关抓下来。最简单的就是把那一块都拿过来存着当案卷。」 |
| `immutable-transcript-dry-exception` | 不可变记录间不适用 DRY | 「这种时候不要将就什么dry。两边都是不会去改动的记录不存在dry这一说」 |
| `cc-sessions-first` | 对话源 v1＝cc session 卷优先 | 「基本上设计都在cc。可以先翻cc的。」 |
| `notary-inner-gate` | 符宝郎挂给事中交卷闸 | 「1 肯定是a」 |
| `no-global-ticket-flag` | 不加全局 --ticket；给事中/符宝郎可有 | 「我认为不需要改目前的调用方式也能知道做的是哪张票。只有给事中这种明确审票的衙门才需要这个参数。符宝郎也可以要」 |
| `diarist-is-role` | 起居郎＝LLM 角色：soul、席位表一行、公开入口、交卷工具、同一调用路径同一卷宗；「非公开席」表述作废（2026-09-06） | 「起居录的生成我觉得应该是一个机械角色/llm角色。 起居郎」（08-31）＋「老子是不是说过一切都是角色！你们又给我造出一个不是角色的角色！」＋「肯定是llm」（09-06，卷 47ef0224 L107237 / L108267） |
| `no-call-rule` | 不规定谁调用起居郎、不把顺序写进法；组合与顺序归调用者（[ADR 0010](0010-callers-own-role-composition-and-repetition.md)） | 「不准规定调用，理论上任何角色都可以被调用。没有什么不能调用这种规矩」＋「不需要写这个顺序。这个顺序是调用者决定的…以后我要改到别的地方还要来改adr吗？」（09-06，L108274 / L108315） |
| `refresh-every-court` | 每次过庭都跑（增量幂等） | （对「每次受理都跑」荐案）「行。先这样。派给事中审票吧」 |
| `no-backfill` | 存量票不补档 | 「8 不补了」 |
| `names` | 起居录 / `diarist` / `ticket-provenance` | 「9 可以」 |
| `github-face-local-only` | 人读面只落本地＋票面指针，不自动回贴 | 「a就行了。」 |
| `ticket-keyed-history` | 票键为主组织轴 | 「历史跟着票走比跟着runid走合适。runid有啥用？其实没啥用」 |
| `sitian-scope-amendment` | 修正 ADR 0065 二期 scope，新增 ticket-provenance | 由 `ticket-provenance-file`+`transcribe-whole-blocks`+`cc-sessions-first` 三键原话直接授权 |
| `diarist-resolves-ticket-llm-layer` | 起居郎 LLM 自行认票；认得出→有录；真无票→无录（#779 改正：键值只保留 L68521「就这样」所点三支；「机械层验真」无 owner 原话，已删） | 卷 47ef0224 L68512 块经 L68521「就这样」：自行认票；认得出→有录；真无票→无录。符宝郎读录核旨。块内无验真句。#774：「让llm自己判断目前修的哪个票，识别不了就上抛！」「代码不准做判断！」 |

本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张 owner authority。

## 机制骨架

- **真源**：司天台 JSONL，kind=`ticket-provenance`，subject＝票号字符串；具体落点引用 [卷宗拓扑](../dossier-topology.md)，本 ADR 不另存路径副本。
- **逐收录块一条 entry**（誊录制）：`basis` / `sourceKind` / `sourceRef` / `transcript` / `timestamp`。追加不改写。
- **人读面**：同分区 md 渲染视图；只有 JSONL 权威。
- **起居郎（`diarist`）**：LLM 角色（soul、席位、公开入口 `ak-role diarist`、交卷工具 `ak_diarist_output`）。LLM 自己找材料（`~/.claude/projects`、issue 面、引用 ADR），交卷整块入录；机械层只做幂等落盘与人读面刷新（#779）。**不**预扫会话切块编号、**不**冻清单、**不**目录名推算、**不**对 LLM 输出做引文/票号/相关性判定。**相关性只由 LLM 裁决**（锚定宪法）。
- **调用与顺序归调用者**（ADR 0010）：本 ADR 不规定谁调用起居郎、不规定先后；每次过庭都跑（`refresh-every-court`）是调用者的用法。**增量幂等**：水位＝卷宗 entry identity；同块再交为 no-op append。
- **符宝郎内闸**：给事中交卷闸出席符宝郎（与大理寺闸 gatekeeper→notary 同构）；内闸永远出席。认得出票→有录，符宝郎读录核旨；真无票对象→无录，符宝郎按 source-run 核旨（不得因缺录把 true-unbound 打回给事中）。**#753 审核循环**：给事中交卷 → 符宝郎审 → 只读结论字段 `pass|bounce|escalate`；`pass` 收卷；`bounce`/`escalate` 把符宝郎回执原文当 tool result 回给事中；结论非三态 → resume 符宝郎本人人话重问；给事中 `escalate` 原样抛给调用者；给事中 status 读不出 → 回给事中本人重交；无轮数上限。handler 只记录与排队，不判内容（`notary-inner-gate` 触及；键 `review-queue-code-guarantee` / `unreadable-conclusion-resume-speaker` / `escalate-thrown-verbatim` / `no-round-cap` 见 #750）。
- **认票（`diarist-resolves-ticket-llm-layer`）**：起居郎 LLM 自行认票，产 typed 断言「本庭对象=票N」或 true-unbound 或 escalate；认得出→有录；真无票→无录。已绑定 ticket（typed handoff）优先。机械层不重判票号。
- **调用面**：调用方无感——任意目录/工作树，无附件无路径即可传召（#779）。

## 与既有 ADR

- 修正 0065 二期 scope；不改 appender/reader 内核契约。
- 补 [ADR 0074](0074-gate-province-reorg-jishizhong-chaiyuan-split.md) 给事中交卷内闸；不改票庭五问与三态判词。
- 符宝郎 soul 两步（读录→核旨）已先行（PR #581）；本 ADR 只落录的生成与闸出席。
- 不 supersede [ADR 0072](0072-menxia-pre-pr-submission-hooks.md) 工人/判卷交卷钩。
