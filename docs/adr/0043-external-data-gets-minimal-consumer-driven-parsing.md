# 外部数据只做 consumer 驱动的最小解析

Status: accepted（authority/provenance: ADR 0019）

作为 ADR 0036 的保留例外，不可信外部数据进入项目时保留最小解析，包括 GitHub API payload、Pi session JSONL/stderr 与 Git 命令输出。只提取 consumer 必须使用的字段并验证其可用；未知字段忽略，不建立完整外部镜像 schema，不验证展示格式，也不对解析后由 runtime 生成的内部对象再次做格式复核。

特别理由：完全不解析可能把“没有读懂外部数据”静默伪装成业务事实。
