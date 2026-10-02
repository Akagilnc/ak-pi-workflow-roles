# 审刑院各状态只要求自身必需字段

Status: accepted

本次撤除审核状态无关的字段要求；原 bounce 非空 violations 的 runtime 强制后由 [ADR 0056](0056-revise-reason-requirement-moves-from-runtime-to-auditor-souls.md) 迁至审计席。本页不继续维护状态字段集合，现行声明与必填边界见 [ADR 0057](0057-schema-narrowing-cuts-the-required-set-not-the-declared-set.md) 及 [审计输出契约](../../src/package-contracts/auditor-output.ts)；额外内容适用 [ADR 0025](0025-input-output-validation-only-checks-what-is-required.md)。
