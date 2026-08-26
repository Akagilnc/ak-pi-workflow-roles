# 0005 — Soul 分层:包内通用法 + 宿主 overlay 业务法

Status: accepted
Date: 2026-07-27

judge soul 重写为通用裁决法:保留法理内核(主张不是证据、证据只认当前 head、删压过加与三问、测试质量亲审、三态判词、卡死上抛、修复面审计),删除全部 Ming 机构引用(容器全局法文件、stationReceiptContracts、ADR/issue 编号、family、台账);suppress 的挂票机制(真实 OPEN 票 + native blocked_by)属编排器语境,整条移交 phase-2 编排器 overlay,通用法只钉「毙单必引证据、没有安静的降级」内核。业务法由调用方经 Pi 原生通道(`--append-system-prompt` / project skills)附加,包内零新机制。Ming 的 `orchestrator/image/souls/verify.md` 一字不动——冻结中的现役法,定性 legacy fork,随老编排器退役;过渡期双源以本包为通用法真源。

## Amendment (2026-08-26) — 审刑院法典与 Soul 分层有限覆盖

**Decision key:** `auditor-law-separate-from-soul`

#470 置顶御批原话：「目前审刑院没有自己的法典，应该和门下省一样，有一部自己的法典。而不是什么东西都往 soul 里面写！soul 不是拿来当法典用的。」

#470 御批二：法典为一部通用法（无角色分章、无退役旧词）；取证授权写通用条（一切取证席位）。

#470 御批三＋范围修正：共享执法自 judge-auditor／reviewer-auditor 迁入法典；太医线不动。

#470 御批四（定稿）：法典逐字节定稿（立法源／案在卷中／无证不得连续打回／取证授权）；两审计 soul 回置发判规则与调卷宗路径注记（已迁法典句不回置；escalate 处置句不落新处，真源唯 CLAUDE.md 直通御前）；参审四席=大理寺、御史台主会话＋审刑院、御史台审计；`judge.md` 同义取证授权句删（法典单真源）；doctor-auditor roleLabel 回置；太医线全部不动。

有限覆盖本 ADR 将「通用裁决法」置于 Soul 的表述——审刑院通用执法与取证法源入包内 `souls/audit-law.md`，由参审四席开庭装入。宿主 overlay 原则与其它角色分层其余仍有效。不得无证扩成全角色法典重构。
