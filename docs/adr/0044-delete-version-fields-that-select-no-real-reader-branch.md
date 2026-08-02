# 删除不参与真实分支的固定 version 字段

Status: accepted（authority/provenance: ADR 0019）

删除输入输出中不参与 consumer 实际分支选择的固定 `version: 1/2` 字段。只有同一 consumer 真实同时读取多个版本，或已有持久数据需要迁移时，version 才作为 ADR 0036 的保留例外。

为尚不存在的第二版本预留字段不构成特别理由；未来出现真实分支时届时再引入区分方式。
