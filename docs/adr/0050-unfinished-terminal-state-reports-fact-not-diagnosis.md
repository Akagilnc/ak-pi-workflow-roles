# 未完终态报事实不报诊断

Status: accepted

Coder 与 Fixer 在施工阶段可交 `unfinished`：仅当前置条件缺失或违宪导致本次调用无法完成时合法，须非空报告、非空 typed 剩余范围，并说明理由；它只陈述本次调用未结清，不诊断原因到调用者之外的处置。该终态走 status 枚举而非 blocker cause；partially_completed 与 class 结算语义不变。provider/工具/runtime 故障仍以非零退出结束，不得表达为 unfinished。审刑院判准与 Fixer Soul 冲突句须同批适应「有没有说实话」；未见理由说明时可同 run 打回催全，至多两次后照收。
