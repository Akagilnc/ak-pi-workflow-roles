# 0013 — 医生的病人是工厂,不是案子

Status: accepted(陛下 ruling,2026-07-31)
Date: 2026-07-30

方子只许指向活跃、可复用的系统件，且目标种类封闭为法条(`law`)、闸(`gate`)、包模板(`template`)、流程站点(`station`)、席位(`seat`)。目标 key 保留调用方原始字节，不做规范化。案子、回执、manifest、处置、修理和单个 bug 只能是证据或症状，不能成为 catalog target。

**Forward amendment (2026-08-01):** ADR 0017 将读数改为先从单个保留的 Pi session-dir 产出过程成本诊断；跨案趋势是读取多案后的独立输出，不再是 `completed` 前提。病人仍是工厂，案子仍只提供症状证据。

环内的同类 finding 升级归 recurrence 受理机制(issue #13)，不归医生；本决策不实现或路由该机制。如此环内席位保持 fresh 无记忆，纵向判断集中在唯一的环外席位。
