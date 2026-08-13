# #319 Preservation Ledger（逐断言）

> Batch 0 产物。庭定 `requiredPreservationLedger` 全项落成。  
> 用途：后续删/并/改造批次的否决真源——负向断言一条不得丢。  
> 不新增生产护栏；不改变调度或测试行为。  
> head 基线：`64e6f4c0`（审计报告落成点）。

图例：🔒 = 闸类负向（must-reject / abort-without-receipt / isolation / seatbelt / partition）。

---

## M1 — Coder canonical tdd 展开门禁

| # | 断言 | 承载 | 🔒 |
|---|------|------|:--:|
| M1.1 | completed 绑定**紧随**的 canonical native tdd 展开 | `test/contract/judge-role.test.ts` · `coder apply binds completion to the immediately following canonical tdd expansion` | 🔒 |
| M1.2 | malformed expansion 拒 completed（门禁样本） | 同上 · malformed-gate `assert.rejects(submitCompleted(...))` | 🔒 |
| M1.3 | later / 非紧随展开不得充当 completed 依据 | 同上（immediate-following 合同的反面） | 🔒 |
| M1.4 | 已有 skill 不重写 / 包内路径为准 | `test/package/package-entrypoint.integration.test.ts` · `packaged coder apply proves canonical native tdd expansion including colliding prefix`（空 home + package-owned path） | 🔒 |
| M1.5 | prefix collision（`/skill:tddfoo` ≠ `/skill:tdd`） | 同上 · colliding prefix 行 | 🔒 |

---

## M2 / M3 / R5 — cold/install 接缝门禁

| # | 断言 | 承载 | 🔒 |
|---|------|------|:--:|
| M2.1 | blank admission 拒（coder/fixer 缺 phase） | `test/package/public-cli-install.test.ts` · admits 共装案 `blank.code === 2` | 🔒 |
| M2.2 | malformed admission 拒 | 同上 · fixer malformed prerequisites `code === 2` | 🔒 |
| M2.3 | 无 ambient home skills | 同上 · empty home；`public-cli-cold-matrix.test.ts` · empty ambient home | 🔒 |
| M2.4 | 无自动 Internal `--ak-role` 注册 | `public-cli-install.test.ts` · admits 共装案 ordinary help；cold-matrix 同构 | 🔒 |
| M2.5 | Navigator 非 caller command（推荐 command 不含 task 路径等） | `package-entrypoint.integration.test.ts` · live-help / attendance 案 `command` 形态 | 🔒 |
| M2.6 | Merger fail-closed 与深链失败 | `test/integration/merger-role.test.ts` · `Merger terminal contract and singleton failures abort without accepting a receipt`；`public-cli-merger-run.test.ts` residual precedence | 🔒 |

---

## M4 — Reviewer fatal 两缝

| # | 断言 | 承载 | 🔒 |
|---|------|------|:--:|
| M4.1 | installed Reviewer fatal stages **abort without a receipt** | `test/integration/audit-failure-subprocess.test.ts` · `installed Reviewer fatal stages abort without a receipt` | 🔒 |
| M4.2 | in-process Reviewer fatal **fail closed without a receipt** | 同上 · `Reviewer fatal audit stages fail closed in-process without a receipt` | 🔒 |

两条缝均保留；不得并成零。

---

## R1 / R3 — observation / help / seatbelt / cause 隔离

| # | 断言 | 承载 | 🔒 |
|---|------|------|:--:|
| R1.1 | tool-execution JSONL **never for Navigator prepare** | `package-entrypoint.integration.test.ts` · `...never for Navigator prepare` | 🔒 |
| R1.2 | 无 `--ak-role` → **零** observation | 同上 · `without --ak-role emits no tool-execution observation records` | 🔒 |
| R1.3 | packaged fixer bash **seatbelt** + **singleton** output | 同上 · `packaged fixer applies its both-phase bash seatbelt...singleton output` | 🔒 |
| R3.1 | help 新旧 marker：二次 prepare 必见新 marker（live reread） | 同上 · `cold-installed live help...` · `first prepare must carry live help marker` / `second prepare must reread live help` | 🔒 |
| R3.2 | routebook/context cause 不串 | 同上 · `settled routebook diagnosis must not leak into the next preparation`；`unavailableSource === "context"` | 🔒 |

否决：产品 help 缓存（会破坏 R3.1 live reread）。

---

## R4 — 双独立 packaged Pi dossier

| # | 断言 | 承载 | 🔒 |
|---|------|------|:--:|
| R4.1 | 两独立 packaged Pi 进程 **不能交叉** auditor dossiers | `test/package/judge-auditor-fixture-tracer.test.ts`（由 `test/unit/` 迁入）· `two independent packaged Pi processes cannot cross auditor dossiers` | 🔒 |

单 tracer 案被双 tracer 每次完整 helper 调用包含，不单列保留义务。

---

## R6 — true-home 只读与独立 oracle

| # | 断言 | 承载 | 🔒 |
|---|------|------|:--:|
| R6.1 | true-home 只读（treeFingerprint 前后不变） | `test/contract/factory-board.test.ts` · `S3 true-home acceptance...` · `true-home acceptance stays read-only` | |
| R6.2 | 独立 oracle（非 board loader）做 trajectory / active-leg / cost | 同上 · independent scan helpers + `#127` / active leg / `#130` | |
| R6.3 | 缺账 **显式 skip**（非静默 return；非 opt-in-only） | 同上 · `t.skip(...)` when home `#130` ledger absent | |

否决：opt-in-only（会降低默认 owner 覆盖）。

---

## R7 — failure identity / precedence / no-Receipt

| # | 断言族 | 承载 | 🔒 |
|---|--------|------|:--:|
| R7.* | 全部 failure identity / precedence / no-Receipt cells | `test/unit/public-cli-failure-settlement.test.ts`（表驱动各案）；审计/角色深链中的 no-Receipt 闸 | 🔒 |

本批不改 R7；仅登记不得在后续简化中吞并。

---

## R8 / R9 — scheduler partition 与 harness process-fact

| # | 断言 | 承载 | 🔒 |
|---|------|------|:--:|
| R8.1 | ordinary ⊎ exact heavy 分区完备 | `test/contract/run-test-all.test.ts` · partition / live tree / missing manifest fail-closed | 🔒 |
| R8.2 | child 非零 exit / SIGTERM→143 诚实传播 | 同上 · propagate / SIGTERM 案 | 🔒 |
| R8.3 | subprocess process-fact 负向：localTimeout / signal / nonzero / clean / post-exit deadline / operational ENOENT / post-exit collection error | `test/package/pi-test-harness.test.ts` · `subprocess result seam classifies...` | 🔒 |
| R9.1 | heavy 三文件串行清单（#160） | `scripts/run-test-all.mjs` `HEAVYWEIGHT_MANIFEST` ↔ `run-test-all.test.ts` `TICKET_HEAVYWEIGHT` | 🔒 |

R8 可压缩 timeout 类 sleep；不得删 R8.1–R8.3 负向。R9 本批仅登记。

---

## 本批（Batch 1）触及面与保留核对

| 项 | 动作 | 本 ledger 必留项 |
|----|------|------------------|
| D1 | 删 `package-method-skill` 两行散文 includes | 无（digest pin 已覆盖字节完整性） |
| R3 | 删前置 direct help 双调用 | **R3.1 / R3.2 全留**；禁 help 缓存 |
| R4 | 迁 `test/package/` + 去单 tracer 重复 | **R4.1 全留** |
| R6 | 缺账改显式 `t.skip` | **R6.1–R6.3**；禁 opt-in-only |
| R8 | 压缩 harness 因果等待 | **R8.1–R8.3 全留** |

---

## Batch 2 触及面与保留核对（M2 / M3 / R5）

| 项 | 动作 | 本 ledger 必留项 |
|----|------|------------------|
| M2 | cold-matrix = 全角色冒烟真源；lifecycle 只留角色独有深链（Reviewer→auditor→Judge、Doctor audited output、Collector default gh receipt） | **M2.1–M2.6 全留**（blank/malformed、无 ambient、无自动 Internal、Navigator 非 command、Merger fail-closed/深链失败） |
| M3 | `public-cli-install` coder admits 只留 blank + bin/技能路径 argv；深链唯一承载 `public-cli-coder-installed-run` 🔒 | **M2.1 coder blank** + skill 路径不经 `.agents/skills`；深链失败面不迁入 install |
| R5 | install 确认共享 tarball（`getSharedIsolatedPack`）；discovery 一案独占 live `pi install`/settings；admits 矩阵共一次 install，禁每角色重装 | 不删 M2.1–M2.4；不把 settings 写路径断言从 discovery 案拿掉 |

承载对照（Batch 2 后）：

| 断言 | 承载 |
|------|------|
| M2.1 blank coder/fixer | `public-cli-install.test.ts` · admits 共装案 |
| M2.2 malformed fixer prerequisites | 同上 |
| M2.3 无 ambient home skills | 同上 + `public-cli-cold-matrix.test.ts` |
| M2.4 无自动 Internal `--ak-role` | 同上 + cold-matrix |
| M2.5 Navigator 非 caller command | cold-matrix + `package-entrypoint.integration.test.ts` |
| M2.6 Merger fail-closed / 深链失败 | `merger-role.test.ts` + `public-cli-merger-run.test.ts` |
| M3 coder 深链 | **仅** `public-cli-coder-installed-run.test.ts` 🔒 |

---

## 明确不执行（庭定）

- R2 单进程替代 fresh-process 续接
- R3 产品 help 缓存
- R6 opt-in-only
