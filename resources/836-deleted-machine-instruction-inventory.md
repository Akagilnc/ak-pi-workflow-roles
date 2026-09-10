# #836 删 5：从代码迁出的机器指令句清单

供陛下过目。不改 soul。确需对角色说的话归入本包资源（ADR 0073）。指针句（附件路径、卷宗指针、「请重读」）保留为中立机器文本，不在本表。

| 原位点 | 原句（代码自写） | 处置 |
|---|---|---|
| `role-envelope.ts` `buildSkillExpansion` | `References are relative to ${dirname}.` | 删。方法体原文即可。 |
| `role-runtime.ts` reviewer parent prompt | `权威 Spec 不存在；未启动 Spec 取证腿。` | 删。Spec 有无由本席读材料自判。 |
| `compliance-transport.ts` `AUDITOR_DOSSIER_PROMPT` | `本 run 卷宗已就绪。` | 改为察院同形路径指针。 |
| `doctor-role.ts` case catalog | `provenance: "由留存 session 字节推导，封入受理回执。"` | 仍在 catalog JSON；属材料字段非指令句。若再删另案。 |
| `collector-role.ts` bounceInfrastructure | `请省略该字段后重新提交。` | 代码打回推翻自报已删。 |
| `reviewer-role.ts` output description | `Standards/Spec 评审腿由 runtime 以取证子会话代跑…` | 改为「本席自调 code-review skill」。方法步骤在 `resources/methods/code-review/SKILL.md`。 |
| `run-lifecycle.ts` A4.1 | `[ak-role:resume-continue]` | 不再写入新 resume prompt；常量只认历史卷。 |
| `run-lifecycle.ts` A4.2 | `重新读 <path>` | 前轮已删改写。 |
| `submission-correctable-error.ts` A4.5 | `终局交卷并非本轮唯一工具调用。` | 删。Pi/ACP `deliverSubmissionRejection` 不再注入该句。 |
| `role-runtime.ts` 催交 | `本会话尚无已接受的 typed 回执。` | **留**（轮次/预算，Q2）。 |

催交句与 2.1–2.3 打回文、重问三句不在删除列。
