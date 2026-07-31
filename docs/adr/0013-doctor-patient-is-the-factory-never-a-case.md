# 0013 — 医生的病人是工厂,不是案子

Status: accepted(owner ruling,2026-07-31)
Date: 2026-07-30

方子只许指向活跃、可复用的系统件，且目标种类封闭为法条(`law`)、闸(`gate`)、包模板(`template`)、流程站点(`station`)、席位(`seat`)。目标 key 保留调用方原始字节，不做规范化。案子、回执、manifest、处置、修理和单个 bug 只能是证据或症状，不能成为 catalog target。

读数按跨案人口统计。环内的同类 finding 升级归 recurrence 受理机制(issue #13)，不归医生；本决策不实现或路由该机制。如此环内席位保持 fresh 无记忆，纵向判断集中在唯一的环外席位。
