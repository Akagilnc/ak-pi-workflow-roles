# 打回须给理由的要求由 runtime 迁至四席审刑院 soul

Status: proposed

**这是对 [ADR 0033](0033-compliance-decisions-only-require-fields-needed-by-the-status.md) 的具名修订，不是默删。**

被修订的一句：0033 中「`revise` 要求 `status: "revise"` 与非空 `violations`」的 **runtime 强制**部分。修订后：该要求由四席审刑院 soul 承担，runtime 不再因 `violations` 为空而拒收。0033 的其余部分（`pass` 只要求 `status`，其他内容一概不管）不变。

为何不能默删：它防的是「打回却不说理由」。配合 [ADR 0007](0007-no-audit-retry-brake.md)「审计重交不设重试帽」，一个空 `violations` 的 revise 即无理由死循环——真实可复现的失败，护栏三问全过。删除它必须有承接者（CONTEXT.md「承接者判据」）。

准入依据：仓级 `CLAUDE.md` Soul 准入检查第 2 题已同批限定为「能否由 schema 或 runtime **合法且**更准确地表达或强制（第 0 条禁止的形状拒收不算『能』）」——本要求在 runtime 侧的强制形态正是第 0 条所禁的形状拒收，故第 2 题答「否」，内容合法进入 bundled Soul。

承接接缝为四席，因 `createComplianceDecisionTool` 被 `judge-auditor` / `reviewer-auditor` / `fixer-auditor` / `doctor-auditor` 共用同一 schema 与同一校验器，删除 runtime 检查对四席同时生效。四席 soul 现状与所需补法：

| soul | 现状 | 补法 |
| --- | --- | --- |
| `souls/judge-auditor.md` | 已含「逐条指出违反的条目以及你查到的原因；没有具体证据不得连续打回」 | 无需改 |
| `souls/fixer-auditor.md` | 仅「明确违反 Soul 则 `revise` 并逐条指出」，缺后半句 | 补齐后半句 |
| `souls/doctor-auditor.md` | 同 fixer，缺后半句 | 补齐后半句 |
| `souls/reviewer-auditor.md` | 「须指出具体条目与证据」，措辞另成一套 | 与其余三席对齐措辞 |
