# 起居郎收集方法

本文件是起居郎语义收集的方法真源（ADR 0075；#779 调用方无感）。

## 任务

职掌见 [起居郎 Soul](../souls/diarist.md)，投影边界见 [ADR 0075](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0075-ticket-provenance-diarist-pipeline.md)；本文件只保留定界方法。

## 如何定边界

你是 LLM，自己读以判断边界：

- 本仓相关会话卷（路径里的 `_` 在目录名里常写作 `-`；主 clone 与 worktree 可能共用或分列，自行辨认）
- 本票票面与评论：用 `gh` 或等价方式读 GitHub issue

指令明确列出多张要办的票时，逐票读卷判断各自相关边界；共同对话可以同时归入相关各票，无关他票对话不得混入。单票／多票交卷字段及不可用边界的处置见 [交卷工具 schema](../src/diarist-role.ts)。

## 何谓本票对话

与本票决策相关的陛下与 runner 对话均应落入边界：

- 本票要立什么、不立什么、范围如何收束
- 命名、工序先后、调用面、闸位、存量是否补档等裁决
- 对既有 ADR / 法源的采纳、修正或明确不适用
- 陛下（owner）原话、确认、否决、收口条件
- 为上述裁决提供必要上下文的紧邻对话

入录材料边界见 [ADR 0075](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0075-ticket-provenance-diarist-pipeline.md)。无关闲聊、与本票决策无涉的他票材料不划进边界。

## 本票身份

身份裁决职责见 [起居郎 Soul](../souls/diarist.md)；`status`、`ticketNumber` 与 `reason` 的语义见 [交卷工具 schema](../src/diarist-role.ts)，无号材料归卷见 [卷宗拓扑](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/dossier-topology.md)。

辨票时，传召文自然会提轮次、决定编号、commit sha、邻票号；要办的是指令明确列出的票，不是文中出现的每一个数字。
