# 打回须给理由的要求由 runtime 迁至 auditor soul

Status: accepted

ADR 0033 中 bounce 须非空 violations 的 runtime 强制迁至各 auditor soul；runtime 不再因 violations 为空而拒收。bounce 必须逐条给出违反条目与原因，由各 auditor soul 承担；没有具体证据不得连续打回，由 audit-law 单一承接。现役审计对象见 `src/auditor-soul.ts` 的 `AUDITOR_SOUL_ROLES`；fixer LLM auditor 按 ADR 0066 退役，soul 文件仅 dormant 留盘。
