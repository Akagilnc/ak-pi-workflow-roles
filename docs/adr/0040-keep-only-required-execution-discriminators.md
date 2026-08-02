# 只保留必需的执行判别值

Status: accepted（authority/provenance: ADR 0019）

作为 ADR 0036 的保留例外，继续验证机器选择实际执行分支所必需的判别字段，例如角色名、Coder/Fixer phase、各角色终态 status/kind、Collector PR number。

特别理由：未知判别值没有可执行含义，consumer 只能猜。判别字段只负责选择分支；不得据此禁止额外字段，每个分支只要求自身真正需要的材料。
