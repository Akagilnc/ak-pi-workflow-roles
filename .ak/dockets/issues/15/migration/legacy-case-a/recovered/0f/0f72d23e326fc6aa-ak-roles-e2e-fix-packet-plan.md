## 立案与裁决

**Pinned target:** `18c57b033ab7e3eac1b276c8c0524f0c38fdcfcc`（已亲验当前 HEAD 全等，工作树无已报告改动）。

**Authority set:** owner authority `/tmp/ak-roles-e2e-authority.md` clauses 1–17（其中 latest owner decisions 5–12 优先）；其未冲突部分由 committed `README.md`、`CONTEXT.md`、ADR 0001–0009 补充。当前活单直接适用 clauses 2–3、8、13–17，以及 ADR 0004/0005/0008；Fixer 单信封另适用 clauses 8–9 和 ADR 0003。`npm test` 与 `npm run typecheck` 在 pinned HEAD 均绿，但现有测试未覆盖下列契约缺口，不能据此放行。

评审中的 Standards/Spec 两组 `targetHead` 与 tool-gating 记录分别是同一根缺陷的重复视图；全部记录均已裁决，合并送修而非静默降级。结论为 **5 个活缺陷：4×P1、1×P2，全部 `fix_now`；无 refute、无 suppress、无需 owner 决策。**

## 修理包

1. **P1 — 实现 Judge `targetHead` 静态字段与绑定校验** (`fix_now`)
   - **Authority:** authority clause 14；`docs/adr/0004-targethead-binding-check.md:6`；`CONTEXT.md` 的“绑定”。
   - **Evidence:** `src/role-runtime.ts` 的 `judgeVerdictSchema`、`JudgeVerdict` 与 `validateVerdict` 均无 `targetHead`；Judge execute 在 verdict validation 后直接进入 Soul audit，仓库无 `AK_JUDGE_TARGET_HEAD` 读取。
   - **Required boundary:** 三种 verdict 均支持可选 `targetHead`。当 `AK_JUDGE_TARGET_HEAD` 在场时，缺失或不全等必须在 Soul audit **之前** fail-closed；未绑定的 standalone 调用保持可选。不要建立通用 binding framework。
   - **Tests:** 覆盖三种合法 shape、standalone 有/无字段、bound 相等成功、bound 缺失/不等失败且 audit 调用数为 0，并在真实 package entrypoint 边界覆盖至少一条绑定路径。

2. **P1 — 激活 Judge 时机械收窄工具集，并修正文档** (`fix_now`)
   - **Authority:** authority clause 15；`docs/adr/0008-role-gating-judge-toolset-narrowing.md:6`；`CONTEXT.md` 的“角色门禁”。
   - **Evidence:** `src/role-runtime.ts` Judge activation 从未调用 `setActiveTools`; `README.md:10` 仍称 Judge 使用 “normal tools”。
   - **Required boundary:** Judge 仅激活已注册的取证工具 `read`, `grep`, `find`, `ls`, `bash` 与 `ak_judge_output`，移除 `write`/`edit` 及其他非取证工具；Fixer 不受此收窄。README 明示该名单以及“role gating，不是 security boundary”。不要新增 bash 命令启发式拦截。
   - **Tests:** harness 与真实 entrypoint 都要断言 Judge 的 active tool names；证明 write/edit/任意 sibling 不活跃、judge output 仍活跃，并证明 Fixer 工具面没有被 Judge gate 污染。

3. **P1 — 将 bundled Judge Soul 改为通用包法** (`fix_now`)
   - **Authority:** authority clause 13；`docs/adr/0005-soul-layering-generic-law-plus-host-overlay.md:6`；`CONTEXT.md` 的 Soul 两层定义。
   - **Evidence:** `souls/judge.md` 仍包含“容器全局”、票/ADR 编号、`family`、`stationReceiptContracts`、`blocked_by`、legacy verify/runner 路由和台账等 Ming 宿主制度。
   - **Required boundary:** 按 ADR 0005 保留通用内核：主张须证据且证据指向当前 head、删压过加与护栏三问、测试质量亲审、每条记录明确裁决且无安静降级、三态判词、工具链故障不冒充判词、卡死上抛、修复面审计。移除全部宿主机构/编号/编排拓扑及 OPEN-ticket/blocked_by suppress 机制；宿主法只由 Pi 原生 `--append-system-prompt` / project skills overlay，不增加包内 overlay 机制。
   - **Tests:** 将 `test/judge-soul.test.ts` 从当前单一弱正则扩为正向内核检查和明确的宿主词/编号禁用检查，同时保留 package integration 对完整 Soul 注入的贯穿验证。

4. **P1 — Soul-audit 基础设施故障必须导致非零 Action 失败** (`fix_now`)
   - **Authority:** authority clause 3（temporary provider/toolchain failure is non-zero Action failure）、clause 4；`CONTEXT.md` 三态判词定义。
   - **Evidence:** `src/role-runtime.ts` 中 auditor exception 仅从 custom tool `execute` 抛出；Pi extension contract 明定 tool execute exception 会变成 `isError: true` 的 tool result并继续 agent。现有 `test/package-entrypoint.integration.test.ts` 也展示普通 tool error 后仍有下一模型回合。因此当前模型可继续输出散文/再行动，CLI Action 不保证非零退出。
   - **Required boundary:** 保持 audit `revise` 为可重交、且不加自动 retry/brake；仅 provider/auth/toolchain/invalid-auditor-response 等基础设施失败走 fatal Action 通道，并确保非交互 `print/json` 调用最终非零退出且无权威 receipt。此处涉及 Pi tool-error、termination 与进程退出接缝，施工前用 `diagnosing-bugs` 最小复现并确认可测试的退出机制；不要把基础设施故障编码成 `continue`/`escalate`，也不要把所有普通 verdict validation/revise 错误升级为进程故障。
   - **Tests:** 单元测试区分 `revise` 与 thrown infrastructure error；更关键的是增加真实 CLI/subprocess 验收，模拟 audit provider/auth failure，断言非零 exit、没有 accepted Judge receipt、没有后续成功散文掩盖失败。只断言 rejected Promise 或 `isError` tool result 不足以闭合本条。

5. **P2 — Fixer 交卷必须是唯一最终 tool call** (`fix_now`)
   - **Authority:** authority clause 8（one thin envelope）、clauses 9–11；`docs/adr/0003-per-role-submission-tools.md:6`；`souls/fixer.md`“最终只调用一次”。
   - **Evidence:** Fixer execute 在 `src/role-runtime.ts` 只做 envelope/phase validation；不像 Judge 的 `requireSingletonJudgeCall`，它不检查持久化 assistant batch。两个并行 `ak_fixer_output` 或 Fixer output 加 sibling 均可被接受，产生多份/歧义回执。
   - **Required boundary:** 在 validation/acceptance 前利用当前 persisted assistant batch，要求 `ak_fixer_output` 是唯一最终 tool call；保留现有 phase/status/commitSha 规则，不新增 envelope 字段或 hard-check live HEAD。
   - **Tests:** 覆盖单次合法调用、两个 Fixer output、Fixer+sibling 的两种排列，失败路径不得接受任何歧义 receipt；补一条真实 package lifecycle integration，避免只用人工 context mock 证明。

## 修复约束与复验

- 不修改 `docs/adr/`、`CONTEXT.md` 或 authority；本轮已有足够授权。README 与 bundled Soul 的上述改动在授权内。
- 采用最小实现，避免通用 binding 框架、命令启发闸、审计重试帽或新的编排机制。
- 完成后运行 `npm test`、`npm run typecheck`，并运行新增的 CLI 非零退出验收；创建 forward commit。必须由新 HEAD 上的新一轮机械重跑与 self-review 证据决定是否收敛，不能以 Fixer 自述替代。
