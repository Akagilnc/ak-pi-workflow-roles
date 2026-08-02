# 保留实时目标、授权范围与证据对象绑定

Status: accepted（owner 大扫除裁决，2026-08-02）

作为 ADR 0036 的保留例外，继续验证一次工作所引用的实时目标、授权范围和证据对象确为同一个：Merger 的当前 merge 与完成 commit、Reviewer 的冻结 target、Collector 的 snapshot/report evidence refs、Doctor finding 的已读本案证据均属此类。

特别理由：若不绑定，格式完整的回执仍可能安静地对应错误 commit、PR 或证据并误导下游。只保留对象同一性与授权语义；大小写、排序、文本身份壳和精确字段集合不随之保留。
