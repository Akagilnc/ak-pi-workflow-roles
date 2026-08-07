# 交卷 schema 收窄的是必填集合，不是声明集合

Status: proposed

交卷工具 schema 的改造为：**只有记账位是 `required`**；其余字段**保留声明、保留 description**、一律可选；顶层允许额外属性。删除的是手写校验器与跨字段状态机，不是字段声明。

理由：仓级 `CLAUDE.md` 内容分层把「字段名称、类型、可选性和字段语义」判给 Tool / output schema，本决定不改该归属；锚定宪法要求机器要消费的信息以键或 typed 字段提供。`settlement` 今日读的 `fix.summary` / `classes` / `remainingScope` 需要有产出通道，而 `souls/` 全目录只有 `judge.md` 提到 `classes`，无任何 soul 提到 `fix.summary` 或 `remainingScope`——删掉声明等于切断唯一的产出指引，并默删 [ADR 0050](0050-unfinished-terminal-state-reports-fact-not-diagnosis.md) Decision 节对 typed 剩余范围的要求。

声明不是检查：schema 声明「这里期望一个数组」是产出指引；代码不得因模型没给、给成字符串、或键名写歪而拒收——那是 CLAUDE.md 第 0 条所禁。
