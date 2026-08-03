# 保留 Coder 与 Fixer 的必需 phase 输入

Status: accepted（authority/provenance: ADR 0019）

保留 F020/F023 的 `plan | apply`：它们决定本次 Coder/Fixer 调用是规划还是施工，属于必需输入。只验证值为二者之一，其他内容按 ADR 0025 不管。

陛下同时授权 #58 对后续同类格式按已拍定的“只验证必须有的”原则批量裁决，无需逐条回问；只有机制存废或存在明显权衡时再升级陛下。
