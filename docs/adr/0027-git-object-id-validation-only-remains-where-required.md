# Git OID 校验只留在必需对象身份上

Status: accepted（owner 大扫除裁决，2026-08-02）

F010 不再作为全车间通用格式契约。Merger 的 `targetObjectId`、`sourceObjectId` 与 completed `mergeCommitId` 是确认一次真实 merge 所必需的对象身份，继续校验完整 Git OID 并与实时 Git 状态绑定。Navigator 中的 OID 格式属于 #28，#58 不改。
