# #58 排在 #28 之后，Navigator deferral 随之解除

Status: accepted（authority/provenance 见下节；解除 ADR 0020、0026、0027、0028、0030、0035、0045 中 Navigator deferral 的成立前提）

## Authority and provenance

Owner 直接决定，2026-08-02 交互 session 原话：

> 把58排在28后面就行了。这些豁免就都没有了

明确 decision keys：**施工次序**（#28 先于 #58）；**Navigator 范围例外随次序解除**。

本 ADR 不引用 ADR 0019 的 provenance 节。施工次序不是 issue #58 的 decision key，而是一项新的 owner 决定。[issue #58](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/58) 的「非目标与依赖」已声明可等待其他 issue 再选施工时点、且施工时点本身不增加 grill；本决定落在该 latitude 之内，不修改票面的类别裁决。

## Decision

#58 的施工时点排在 [#28](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/28) 合并之后。

ADR 0020、0026、0027、0028、0030、0035、0045 中「#58 不改 Navigator」「Navigator 归 #28」诸句，其成立前提是 Navigator 的设计与实现修正尚未完成。#28 合并后该前提消失，上述 deferral 一并解除：Navigator 中的同类拒绝行为回落为 #58 的普通实例，按各自类别裁决处置，不再作为「有理由的范围例外」记录，也不再需要逐类特别理由。

在 #28 合并之前，deferral 继续有效。本 ADR 不授权提前修改 Navigator。

解除的实质理由：Navigator 的格式面与其设计修正此前不可分——回执携带 `runId`、`invocationId`、`positionCursor` 与 `latestAttempt.terminalClass`（含 Assisted recover 协议专有值 `outcome_unavailable_after_runner_loss`），删除 Assisted 会移除这些字段的生产者，因此「清理 Navigator 格式」无法在不回答「Navigator 的输入契约是什么」的前提下完成，而后者属 #28。次序反转后该纠缠消失。

## 随之失效的两项既有事实

1. 已完成的施工前同类扫描（`docs/research/issue-58-cleanup-scan.md`、`docs/research/issue-58-cleanup-scan-findings.md`）与构造计划（`docs/research/issue-58-cleanup-plan.md`）钉在 `69446586ee7e821d47b8ed7f73c1d8fdcf2dbc68`。#28 将改动 Navigator 及其共享接缝，该证据基线随之失效。#58 施工前须在 #28 的 merge commit 上重钉并按同一批类别重扫全仓。类别裁决与各类 Red/Green 骨架不因重扫而改变。
2. `.ak/work/issues/58/runs/judge-scan-adjudication-001` 的 Judge 回执中，COV1「施工前无需再补扫」以「`58f70f1..HEAD` 生产源码与测试未变」为明示条件。该条件因本决定失效，COV1 须在重扫后重新提交裁决。同一回执的其余 11 条裁词不依赖该条件，继续有效。

## 不做什么

不改 #28 的范围与设计。不改 #58 的类别裁决、已批准保留例外或验收方法。不把 Assisted Runner 的删除从 #58 拆出提前施工——它仍属 #58 一次性大扫除的同一批次；#28 施工期间 Assisted 死码留在树上，按 ADR 0020 不得以未来接线为由接入。不新增常驻机制、gate、次序检查或调度器。
