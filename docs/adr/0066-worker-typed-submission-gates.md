# 0066 — Worker typed 交卷闸与 git 前置闸（修内司 LLM 审刑院退役）

Status: accepted（陛下 2026-08-10 grill 链 + r14 票面收敛；decision keys 与绑定原话见下）

将作监/修内司下游已有御史台、大理寺（自带审刑院）、CI、家族末票四层兜底；修内司 LLM 审刑院观察窗内零真捕获并有橡皮图章与活锁实证。本 ADR 落定：**退役 Fixer LLM 审刑院代码腿**，以 Pi 原生 typed 交卷闸 + git 层前置钩替代其打回权能；soul 文件 `souls/fixer-auditor.md` 原地保留备用。

## Decision keys（逐条绑陛下原话）

| key | 值 | 绑定原话 |
| --- | --- | --- |
| `fixer-llm-auditor` | `retire-code-keep-soul` | 「soul可以先留着。不影响。后面也许还会启用」「代码管 llm？别开玩笑了」 |
| `gate-set` | `commit-reminder + git-prefix + git-no-amend` | 「可以。1234就够了」后 r12 收回③；r8 将②④前移 git 层 |
| `gate-power` | `bounce-not-reject-not-fail-role` | 「这个是用来代替fixer 审刑院的……审刑院的工作原理一直是打回」「打回重写不等于拒收」 |
| `gate-1` | `forgetfulness-reminder-once` | 「Coder 完成不以 commit 为前提……要防的是。做完了，忘了提交」；「拒绝也要求有commit吗？」「机器不管啊」 |
| `gate-1-status-matrix` | `completed\|partially_completed require; planned\|refused\|unfinished free` | 同上 + ADR 0015 partially_completed 归施工完成侧 |
| `gate-2-domain` | `closed-singleton-{ak-roles:}` | 「怎么会是pi。应该是 ak-roles」；CLAUDE.md「Commit 前缀法」 |
| `gate-2-4-enforcement` | `reference-transaction-before-history` | 「就没有别的办法吗？在commit实际成真之前就打回让他重写？」「可以。」 |
| `gate-3` | `not-built` | 「去掉这个闸门……不同技术栈也不一样的」 |
| `gate-5` | `not-built` | 「1234就够了」 |
| `gate-6` | `fixer-schema-field-no-machine-check` | 「代码不查这种东西。可以要求fixer交这个东西。但是不要求检查」 |
| `durability-entry` | `adr-0065-sitian-only` | 票面钉死：①耐久记录经司天唯一入口；#216 缺位则不造旁路 |
| `supersession` | `0024/0055/0057-not-superseded` | 「Coder 完成不以 commit 为前提……这一条现在也没错」；「检验失败响亮失败没错。打回重写还不叫本次提交失败？失败和终止进程不是一回事」 |

本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张陛下 authority。

## 处置分落

1. **① 交卷闸（防忘提醒）**：`completed` / `partially_completed` 且零新 commit → 打回一次 typed「未观察到 commit」；同 run 重交视为确认。`planned` / `refused` / `unfinished` 零 commit 合法。工作树脏不脏机器不管。
2. **②④ git 层前置闸**：信封布置 coder/fixer 工作树时装 `reference-transaction` 钩子——新 commit 标题须冠 `ak-roles:` 在最前；拒绝分支/HEAD 非前进式改写。交卷时不设②④检查。钩子漏网不加第二道机器，归大理寺看卷。
3. **⑥ 举证单**：`ak_fixer_output` 独有 optional `testEvidence` 字段（contract / minimumNecessaryCost / measuredDuration）；要求交、机器不查存在/齐备/覆盖。Coder 不增此字段。
4. **耐久**：跨 resume 的 baseline 与打回记录须经 [ADR 0065](0065-sitian-phase-two-records-have-one-entry.md) 司天唯一入口。#216 OPEN 期间本实现仅进程内状态，**不**直调 `SessionManager.appendCustomEntry`、不自造旁路 ledger。

## 具名 supersession / 射程修订

- **不 supersede** [ADR 0024](0024-delete-coder-self-reported-commit-sha.md)：完成不以 commit 为无条件前提；①只是防忘提醒。
- **不 supersede** [ADR 0055](0055-shape-validation-failure-must-not-abort-the-run.md)：打回即本次交卷的响亮失败（typed），≠终止进程。
- **不 supersede** [ADR 0057](0057-schema-narrowing-cuts-the-required-set-not-the-declared-set.md)：③不建闸，0057 原文不动。
- **修订** [ADR 0006](0006-soul-audit-same-model-fresh-call.md) / [ADR 0062](0062-auditor-is-an-independent-substantive-role.md) 射程：审刑院制度仍适用于判官道（及仍接线的御史台/太医署审计）；**修内司道代码腿退役**，不再是 0006/0062 的在役适用对象。将作监道本无审计腿，确认不加。

## Consequences

- 每次 Fixer 交卷省 1 条 LLM 审计腿；Coder 0。
- 活锁类「散文入法案无限 revise」随撤审结构性灭绝。
- #160 amend 例外已消费，本闸不开口。
