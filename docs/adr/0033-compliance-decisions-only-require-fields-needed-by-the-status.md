# 合规审计各状态只要求自身必需字段

Status: accepted（authority/provenance: ADR 0019）

削薄 F016：`pass` 只要求 `status: "pass"`；`revise` 要求 `status: "revise"` 与非空 `violations`。不再要求 pass 携带无意义的 `violations: []`，其他内容按 ADR 0025 一概不管。
