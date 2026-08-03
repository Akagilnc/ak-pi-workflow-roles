> Historical record: this ADR predates Issue #28 Navigator attendance and is retained only for provenance.

# 删除包内自设的任意输入上限

Status: accepted（authority/provenance: ADR 0019）

统一删除输入输出格式中的包内任意大小、等待时长与分页上限，包括 F039 的 60,000 UTF-8 bytes、F040 的 15 分钟上限、F043 的 4096 read limit。只保留参数能够实际执行所必需的条件，以及真实外部系统不可绕开的硬限制。Navigator 的 F046 只把本裁决交给 #28，#58 不改其实现。
