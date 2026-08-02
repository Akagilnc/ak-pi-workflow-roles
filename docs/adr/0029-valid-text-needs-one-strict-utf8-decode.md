# 文本只需一次严格 UTF-8 解码

Status: accepted（authority/provenance: ADR 0019）

F012 的“精确 UTF-8 round-trip”及其全车间通用契约删除。输入确实必须作为文本读取时，只验证字节能够被严格 UTF-8 解码；解码成功后不再重新编码并逐字节比较。
