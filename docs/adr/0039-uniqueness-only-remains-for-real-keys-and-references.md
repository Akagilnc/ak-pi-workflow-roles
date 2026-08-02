# 唯一性只留给真实映射键与引用目标

Status: accepted（authority/provenance: ADR 0019）

作为 ADR 0036 的保留例外，仅当 consumer 真正按字段建表、查找或归属时，保留身份唯一性与引用存在性，例如 Collector `legId`、evidence ID、Reviewer 实际 axis 及回执引用。

特别理由：重复真实键会被覆盖、串腿或误归证据，流程仍可能安静结束。普通数组、展示名称、check 名称等重复不再拒绝。
