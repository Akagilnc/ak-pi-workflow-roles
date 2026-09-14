# 审刑院各状态只要求自身必需字段

Status: accepted

pass 只要求 status；bounce 的非空 violations 要求已由 ADR 0056 迁至 auditor soul，runtime 不再因空 violations 拒收。其他内容按 ADR 0025 一概不管。
