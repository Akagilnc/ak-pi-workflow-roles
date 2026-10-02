# 打回须给理由的要求由 runtime 迁至 auditor soul

Status: accepted

ADR 0033 中 bounce 须非空 violations 的 runtime 强制迁至各 auditor soul；runtime 不再因 violations 为空而拒收。理由与取证判断引用现行 [审计 Soul 装载真源](../../src/auditor-soul.ts) 及其法典，本页不复述席位规则。现役审计对象见 `src/auditor-soul.ts` 的 `AUDITOR_SOUL_ROLES`；fixer LLM auditor 按 ADR 0066 退役，soul 文件仅 dormant 留盘。
