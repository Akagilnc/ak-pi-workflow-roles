# 交卷 schema 零 `required`，声明全保留

Status: accepted

交卷工具 schema 的改造为：**`required` 数组清空**（含记账位）；字段**保留声明、保留 description**；顶层允许额外属性。记账位的精确 key 与取值域写在 `description` 里——那是**要求**，不是校验。删除的是手写校验器与跨字段状态机，不是字段声明。

记账位不设 `required` 的依据（陛下 2026-08-07 裁）：JSON Schema 的 `required` 就是「键名不逐字相同即拒」的机器实现，与本 ADR 自己「key 名字不必逐字相同」的规定不能同时为真。护栏三问亦全不过——[ADR 0054](0054-audit-decision-tool-drops-constrained-sampling.md) 实测八条对照腿 `judgeStatus` 全对（glm-5.2 在其余字段全写错时四次四对）；漏了的后果仅是账面缺一格；下游有审刑院与调用者双层承接。

理由：仓级 `CLAUDE.md` 内容分层把「字段名称、类型、可选性和字段语义」判给 Tool / output schema，本决定不改该归属；锚定宪法要求机器要消费的信息以键或 typed 字段提供。`settlement` 今日读的 `fix.summary` / `classes` / `remainingScope` 需要有产出通道，而 `souls/` 全目录只有 `judge.md` 提到 `classes`，无任何 soul 提到 `fix.summary` 或 `remainingScope`——删掉声明等于切断唯一的产出指引，并默删 [ADR 0050](0050-unfinished-terminal-state-reports-fact-not-diagnosis.md) Decision 节对 typed 剩余范围的要求。

**声明是「要求」，不是「必须」。** schema 声明「这里期望一个数组」是产出指引——它负责让内容分类、不堆一处，**不授权代码在自己这一侧强制检查**。代码不得因模型没给、给成字符串、或键名写歪而拒收，那是 CLAUDE.md 第 0 条所禁。

**key 名字不必逐字相同**：`fix.summary` / `fixSummary` / `fix summary` 一律合法。要求里可以写规范形，合不合格由审刑院判，**判准是读不读得懂**；要紧的是内容是否符合事实。审刑院打回时可以建议 key 名字——这属 LLM 角色的职掌，不在第 0 条禁令射程内。
