# Judge 与 Merger 输出各用一个 Schema 真源

Status: accepted（authority/provenance: ADR 0019）

Judge 的工具 Schema 直接表达 `converged | continue | escalate` 三个输出叶，Merger 的工具 Schema 直接表达 `completed | escalate` 两个输出叶。删除同一边界上另行手写的字段集合、字段类型及 presentation validator；工具注册实际消费的 Schema 是唯一 shape owner。

runtime 继续拥有无法由字段 Schema 代替的行为验证：Judge 的裁决状态语义，以及 Merger 对实时 parents、冲突集、worktree cleanliness、resolution scope 和 merge commit 的核验均保留。非法 shape 更早由标准工具参数校验拒绝，不再穿过宽松 transport 后被隐藏的第二合同拒绝。
