# 删除 Assisted Runner，保留 Navigator

Status: accepted（owner 大扫除裁决，2026-08-02；取代 ADR 0017 中 Assisted Runner 的决定）

Navigator 作为持续导航席保留：票面与 authority 给出目的地，Navigator 根据每次角色调用前后的真实位置建议下一站；调用者仍可偏离，建议与实际动作仍应可审计。删除 Assisted Runner 整个实现及其专属公开面，包括 `ak-assisted-run` CLI、Assisted 配置与结果契约、`runId`/`callId` 旅程身份、acquisition wrapper、账本与 hash chain、并发仲裁、恢复协议、发布 Schema、专属测试和使用文档。只被 Assisted 消费的适配与辅助代码随同删除。

#28 证明了持续分诊职责的必要性，但没有证明 Assisted Runner 这一实现产生增量收益。当前保留的 `.ak/work` 中没有 Assisted run 目录、run index、ledger generation，也没有 Pi session 工具调用实际执行 `ak-assisted-run enter|resume`。真实角色仍经直接 `pi --ak-role ...` 调用。因此 Assisted 为未接入的假想多调用旅程预建了持久状态、密码学完整性、并发竞选与崩溃恢复，却没有把导航装进真实驾驶路径；保留这些机制只会维护一个无人消费的第二调用面。

本裁决只清理无消费者的 Assisted 实现，不把 Navigator 降格为按需顾问，也不在本次大扫除内修改或重建 Navigator。现有 Navigator 与 #28 立票目的之间的设计、实现偏差由 #28 自行修正，明确不属于 #58；不得以未来接线为由保留 Assisted 残件。
