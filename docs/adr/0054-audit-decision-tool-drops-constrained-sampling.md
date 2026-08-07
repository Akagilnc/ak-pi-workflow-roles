# 审刑院决策工具关闭约束采样

Status: proposed

`createComplianceDecisionTool`（`src/compliance-transport.ts`）不再声明 `constrainedSampling`。

理由：厂商 strict 结构化输出在 API 层要求闭合对象与全属性必填，与开放 schema 直接冲突；`3152698` 的「require every Codex decision property」正由此而来，把一个 provider 的接口约束升格成了全体模型的通用法。

代价明记：审刑院失去约束采样，记账位靠模型自觉。八条对照腿 `judgeStatus` 全对（其中 glm-5.2 在其余字段全写错的情况下四次四对）；写错时 Pi 原生把校验错误当 tool result 回喂，模型自改无上限。

附带事实（防后人误查）：`ak_<role>_output` 交卷工具一个都没设 `constrainedSampling`，依 `pi-ai` 的 `resolveJsonSchemaStrictSampling`（无 config 即返回 `undefined`）本就不进厂商 strict 通道，无需处置。
