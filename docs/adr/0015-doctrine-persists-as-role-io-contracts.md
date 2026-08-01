# 0015 — 打法持久化走角色 I/O 合同，不走流程文档

Status: proposed（2026-07-31，owner grill 拍定）

裁类修理打法以三份角色合同承载：判词类字段（`classes[]: name/owner/boundary/disposition`）、Fixer 按 finding 的结算项（`classResults[]`，完成项绑定 `searchScope/exceptions/commitSha`，拒绝项绑定 `remainingScope/blocker`）、圈界输入参数（`scopeKeys[]`）；循环次序是合同的推论，不另立流程文档规定。`partially_completed` 仅表示完成项与合法拒绝项并存，不表示未完进度。playbook（#25）为过渡物，随合同落地废除。理由：调用者拥有拓扑（ADR 0010）+ 锚定宪法（机器咬 typed 契约）+ 流程文档与合同并存必漂移成双真源。
