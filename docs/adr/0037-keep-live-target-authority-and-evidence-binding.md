# 保留实时目标、授权范围与证据对象绑定

Status: accepted（authority/provenance: ADR 0019）

> **Supersession / 部分取代 (#836, 陛下 2026-09-10「2.13/2.15/2.16/2.17/2.20 删」):** 代码对 Collector/Doctor/Reviewer 等角色交卷的目标/授权/证据同一性拒收收回给判官/察院读原卷。本 ADR 不再授权代码因 admitted 身份不符而拒收或中止。

作为 ADR 0036 的保留例外，继续验证一次工作所引用的实时目标、授权范围和证据对象确为同一个：Merger 的当前 merge 与完成 commit、Reviewer 的冻结 target、Collector 的 snapshot/report evidence refs、Doctor finding 的已读本案证据均属此类。

特别理由：若不绑定，格式完整的回执仍可能安静地对应错误 commit、PR 或证据并误导下游。只保留对象同一性与授权语义；大小写、排序、文本身份壳和精确字段集合不随之保留。
