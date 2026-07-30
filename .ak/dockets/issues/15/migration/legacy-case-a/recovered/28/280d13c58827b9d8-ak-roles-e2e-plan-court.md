# Judge repair packet

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


# Fixer plan receipt

# Repair plan

## Investigated state

- Confirmed all five findings in `src/role-runtime.ts`, `src/soul-auditor.ts`, `souls/judge.md`, `README.md`, and the current tests.
- Read authority clauses 1–17, `CONTEXT.md`, ADR 0003/0004/0005/0006/0007/0008, the relevant Pi extension contract, and path history. The prior hardening commit `c206022` established the persisted-assistant-batch singleton pattern; the Fixer repair should reuse that seam rather than introduce another acceptance mechanism.
- Baseline checks pass but do not cover the reported contracts: `npm test` (36 tests) and `npm run typecheck` both passed.
- Important concurrent-state evidence: the actual opening HEAD is `5d5d02382cd18f3c1d20324ae721681b354471d9`, a strict descendant of the packet’s pinned `18c57b0`; it changes only ADR 0004 wording. The worktree also already contains an unstaged owner change to `docs/adr/0007-no-audit-retry-brake.md`. I made no edits or commits. Apply must preserve and never stage that pre-existing ADR change, and must record its true opening HEAD.

## Minimal implementation plan

1. **Add red-capable tests first.** Extend `test/judge-role.test.ts` and the real package lifecycle coverage before implementation so each missing invariant fails independently. For the infrastructure case, add a deterministic CLI/subprocess fixture that drives the installed package entrypoint with a faux provider: the Judge emits a valid receipt, the separate audit call fails, and a possible later provider response would be success prose. Assert non-zero exit, an errored audit submission, no accepted Judge receipt, and no later prose. This is the diagnosing-bugs feedback loop and will verify the actual Pi termination/exit seam rather than only a rejected Promise.

2. **Implement static `targetHead` and binding at the Judge seam.** In `src/role-runtime.ts`, add optional nonblank `targetHead` to the static TypeBox schema and all three `JudgeVerdict` variants. Adapt exact-key validation to allow it without weakening status-specific shapes. Read only `AK_JUDGE_TARGET_HEAD`; after verdict validation and before `auditSoulCompliance`, fail closed when a bound value is missing or not exactly equal. Keep standalone calls optional and add no generic binding framework. Unit tests will cover all three shapes, standalone present/absent, bound equality, bound missing/mismatch, and zero audit calls on failures; package-entrypoint integration will cover a bound path.

3. **Narrow Judge tools only at role activation.** After dynamically registering `ak_judge_output`, derive the active set by filtering `pi.getAllTools()` to the fixed names `read`, `grep`, `find`, `ls`, `bash`, and `ak_judge_output`, then call `pi.setActiveTools` once. Do not add command inspection. Leave the Fixer branch untouched so it retains its pre-activation tool surface. Expand the harness with tool-registry APIs and assert exact active names; extend real lifecycle integration with built-ins plus write/edit/arbitrary sibling to prove those are inactive, Judge output remains active, and a separate Fixer lifecycle is not contaminated. Update `README.md` to state the exact list and explicitly say role gating is not a security boundary.

4. **Replace the bundled Judge Soul with generic package law.** Rewrite `souls/judge.md` narrowly around: current-head evidence, deletion/simplification preference and the three guard questions, direct test-quality review, explicit disposition/no silent downgrade, the three verdict states, infrastructure failure outside verdicts, stuck-work escalation, and repair-surface audit. Remove Ming host institutions, ticket/ADR numbers, `family`, `stationReceiptContracts`, legacy verify/runner routing, ledgers, `blocked_by`, and OPEN-ticket suppression. Add no overlay mechanism. Expand `test/judge-soul.test.ts` into positive kernel assertions plus explicit forbidden host terms/numbering, while preserving the existing package test that verifies byte-complete Soul injection.

5. **Close the audit infrastructure failure through Pi’s real Action seam.** Keep `revise` as the existing ordinary errored tool result so the model may resubmit, with no retry/brake. For exceptions from the separate auditor (provider/auth/toolchain/malformed auditor response), abort the current agent action and mark non-interactive `print`/`json` execution non-zero before rethrowing; the thrown error remains an `isError` tool result, while abort prevents a follow-up model turn. Do not apply this fatal path to singleton checks, verdict validation, target binding failures, or `revise`. Unit tests will distinguish revise from an auditor exception and verify abort/exit behavior; the subprocess test from step 1 is the acceptance authority. Any process exit-code mutation in in-process tests will be restored in cleanup.

6. **Enforce the Fixer’s unique final call using the proven persisted-batch seam.** Generalize only the existing singleton-call helper enough to accept the expected submission tool name, then invoke it at the start of Fixer `execute` before envelope/phase validation. Pass the real `ExtensionContext` into Fixer execution. Test one legal call, two Fixer calls, and Fixer+sibling in both orders, ensuring no ambiguous receipt is accepted. Add a real package lifecycle test with a Fixer packet and persisted assistant batch, not only a synthetic context.

7. **Verify and commit only authorized paths in apply.** Run the focused unit/integration/subprocess tests, then `npm test` and `npm run typecheck`; inspect the diff for collateral changes and confirm `docs/adr/`, `CONTEXT.md`, and authority remain untouched by this repair. Stage only the authorized runtime, auditor (if required by the minimal fatal typing), Soul, README, tests, and CLI fixture. Create one new forward commit without amend/rewrite, verify it is a strict descendant of the true apply-opening HEAD, and report the pre-existing ADR worktree change separately rather than including it.


# Concurrent Git evidence

Pinned review HEAD: 18c57b033ab7e3eac1b276c8c0524f0c38fdcfcc
Fixer observed opening HEAD: 5d5d02382cd18f3c1d20324ae721681b354471d9
Current live HEAD before plan approval: 5825396317fb15e23f398eb62ef8d6995356a244
