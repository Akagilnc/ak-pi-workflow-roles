# TEST_AUDIT_319 — 角色包测试计时审计 + 五尺分类

> 票：#319（S7 前置；参考尺 120s）  
> 分支：`audit/issue-319-test-timing` @ `d1e07c1d`  
> 本轮约束：**零删除、零测试修改**；kill-list 仅建议，待大理寺过庭后另批执行。  
> 采集时间（UTC）：2026-08-13T16:12:32.953Z → 2026-08-13T16:16:29.631Z

---

## 0. 方法与范围

### 0.1 计时采集

- 调度真源：`scripts/run-test-all.mjs`（ordinary 默认并行 → heavy `concurrency=1` 串行）。
- Heavyweight 清单（串行腿）：
  1. `test/integration/audit-failure-subprocess.test.ts`
  2. `test/integration/public-cli-judge-run.test.ts`
  3. `test/package/package-entrypoint.integration.test.ts`
- 为拿到逐案 TAP `duration_ms`，本轮用**同构采集器**（同一 discovery / partition / `isolatedTestProcessEnv` / 同序 heavy），仅追加 `--test-reporter=tap`。  
  **不是**改仓内 `test:all`；刀口与 `pnpm run test:all` 一致。
- 环境：`AK_LEGACY_CASE_A_LIVE_SOURCE=0`（与 CI 一致）。
- 发现测试文件：**74**（tier：unit/contract/integration/package）。  
  不在 `test:all` 内：`test/adjudication/**`、`test/primary-aware-cleanup.test.ts`。
- 本地主机：Darwin arm64（Apple M5，10 逻辑核）/ Node v22.23.0。
- CI 对照：GitHub Actions run [`31711243886`](https://github.com/Akagilnc/ak-pi-workflow-roles/actions/runs/31711243886)（`main` merge #317 = 本 base `d1e07c1d`，`ubuntu-latest`）。

### 0.2 读表口径

| 口径 | 含义 |
|------|------|
| **wall** | 子进程墙钟（ordinary 段 + heavy 段） |
| **Σ case** | 该文件全部 leaf 案 `duration_ms` 之和（并行时 Σ ≫ wall） |
| **max case** | 该文件最慢单案 |
| **🔒** | 文件内含闸类契约负向（must-reject / abort-without-receipt / seatbelt / isolation 等）；**不可删**，只可改造承载 |

---

## 1. 计时总览

| 段 | 本地 wall | CI wall（同 SHA） |
|----|----------:|------------------:|
| ordinary（71 files，默认并行） | **87.0s** | ~130.0s（CI TAP 段计） |
| heavy（3 files，串行） | **149.7s** | ~154.8s |
| **test:all 合计** | **236.7s** | **~286.0s** |
| CI job 总墙钟（含 install/typecheck） | — | **5m8s**（gh run list） |
| leaf 案数 | 530 | 531 |
| leaf Σ duration | 617.5s | 401.3s |

**对照参考尺（owner 2026-08-14「全量 >120s 即不正常」）**：

- 本地 test:all wall **236.7s ≈ 2.0×** 参考尺。
- CI test:all wall **~286.0s ≈ 2.4×** 参考尺。
- 终线数值仍待 owner 据本表拍板；本票不改预算。

### 1.1 本地 Top 15 单案（leaf）

| ms | file | case |
|---:|------|------|
| 58.8s | `test/integration/public-cli-coder-installed-run.test.ts` | cold-installed ak-role coder apply retains production chain to lawful Terminal artifacts |
| 34.1s | `test/package/reviewer-package-lifecycle.test.ts` | installed npm tarball runs public ak-role Reviewer→auditor→Judge chain |
| 24.8s | `test/integration/audit-failure-subprocess.test.ts` | installed Reviewer fatal stages abort without a receipt |
| 24.6s | `test/unit/judge-auditor-fixture-tracer.test.ts` | tarball-installed .bin judge auditor locates and reads its real run dossier |
| 23.7s | `test/package/package-entrypoint.integration.test.ts` | fresh packaged processes resume cross-role Navigator route memory and isolate subjects |
| 23.3s | `test/package/doctor-package-lifecycle.test.ts` | fresh Pi process loads the installed Doctor extension and completes one audited output |
| 23.2s | `test/unit/judge-auditor-fixture-tracer.test.ts` | two independent packaged Pi processes cannot cross auditor dossiers |
| 22.7s | `test/package/public-cli-install.test.ts` | isolated Pi home installs packed artifact and discovers ak-role via private npm bin |
| 19.0s | `test/integration/public-cli-collector-run.test.ts` | public Collector request manifest executes request, re-observes it, and publishes the receipt |
| 15.1s | `test/contract/factory-board.test.ts` | S3 true-home acceptance: \#127 accepted trajectory, active leg, \#130 cost reconciliation |
| 14.6s | `test/contract/judge-role.test.ts` | coder apply binds completion to the immediately following canonical tdd expansion |
| 14.6s | `test/package/collector-package-lifecycle.test.ts` | cold-installed npm package uses its default gh transport to produce a Collector receipt |
| 14.6s | `test/integration/public-cli-merger-run.test.ts` | public Merger accepts a clean completed merge |
| 14.2s | `test/integration/public-cli-merger-run.test.ts` | public Merger preserves residual failure precedence |
| 11.9s | `test/package/package-entrypoint.integration.test.ts` | cold-installed live help follows the loaded extension and changes on the next hint |

### 1.2 逐文件计时总表 + 五尺 + 🔒

> Σ = leaf `duration_ms` 合计。Δ = 本地 Σ − CI Σ（正值 = 本地更慢）。

| # | file | lane | n | local Σ | max | CI Σ | Δ | 五尺 | 🔒 |
|--:|------|------|--:|--------:|----:|-----:|--:|------|:--:|
| 1 | `test/package/package-entrypoint.integration.test.ts` | heavy | 19 | 67.1s | 23.7s | 71.1s | -4.0s | 真行为契约 | 🔒 |
| 2 | `test/integration/public-cli-coder-installed-run.test.ts` | ordinary | 1 | 58.8s | 58.8s | 47.6s | 11.3s | 真行为契约 | 🔒 |
| 3 | `test/package/public-cli-install.test.ts` | ordinary | 5 | 49.1s | 22.7s | 26.2s | 22.9s | 真行为契约 | 🔒 |
| 4 | `test/integration/audit-failure-subprocess.test.ts` | heavy | 5 | 48.4s | 24.8s | 49.9s | -1.5s | 真行为契约 | 🔒 |
| 5 | `test/unit/judge-auditor-fixture-tracer.test.ts` | ordinary | 2 | 47.9s | 24.6s | 37.8s | 10.1s | 真行为契约 | 🔒 |
| 6 | `test/package/reviewer-package-lifecycle.test.ts` | ordinary | 1 | 34.1s | 34.1s | 29.5s | 4.6s | 真行为契约 | 🔒 |
| 7 | `test/integration/public-cli-merger-run.test.ts` | ordinary | 2 | 28.8s | 14.6s | 15.6s | 13.2s | 真行为契约 | 🔒 |
| 8 | `test/integration/public-cli-judge-run.test.ts` | heavy | 4 | 28.6s | 11.4s | 28.6s | -8ms | 真行为契约 | 🔒 |
| 9 | `test/package/doctor-package-lifecycle.test.ts` | ordinary | 1 | 23.3s | 23.3s | 14.0s | 9.3s | 真行为契约 | 🔒 |
| 10 | `test/integration/public-cli-collector-run.test.ts` | ordinary | 2 | 21.9s | 19.0s | 14.8s | 7.2s | 真行为契约 |  |
| 11 | `test/contract/factory-board.test.ts` | ordinary | 36 | 21.3s | 15.1s | 3.4s | 18.0s | 真行为契约 |  |
| 12 | `test/contract/judge-role.test.ts` | ordinary | 23 | 20.1s | 14.6s | 2.0s | 18.1s | 真行为契约 | 🔒 |
| 13 | `test/package/public-cli-cold-matrix.test.ts` | ordinary | 3 | 19.8s | 9.9s | 11.1s | 8.7s | 真行为契约 | 🔒 |
| 14 | `test/unit/public-cli-failure-settlement.test.ts` | ordinary | 51 | 18.4s | 3.1s | 7.9s | 10.4s | 真行为契约 | 🔒 |
| 15 | `test/package/collector-package-lifecycle.test.ts` | ordinary | 1 | 14.6s | 14.6s | 5.3s | 9.3s | 真行为契约 | 🔒 |
| 16 | `test/integration/activation-envelope-contract.test.ts` | ordinary | 23 | 10.7s | 1.9s | 6.5s | 4.2s | 真行为契约 | 🔒 |
| 17 | `test/unit/public-cli-explicit-internal.test.ts` | ordinary | 7 | 9.9s | 2.6s | 818ms | 9.1s | 真行为契约 | 🔒 |
| 18 | `test/unit/worker-submission-gates.test.ts` | ordinary | 6 | 9.5s | 6.3s | 1.0s | 8.5s | 真行为契约 | 🔒 |
| 19 | `test/unit/public-cli-merger.test.ts` | ordinary | 8 | 9.2s | 1.8s | 1.0s | 8.1s | 真行为契约 | 🔒 |
| 20 | `test/unit/merger-git-state.test.ts` | ordinary | 5 | 8.7s | 2.6s | 654ms | 8.0s | 真行为契约 | 🔒 |
| 21 | `test/unit/public-cli-fixer.test.ts` | ordinary | 8 | 7.7s | 4.4s | 5.8s | 1.8s | 真行为契约 | 🔒 |
| 22 | `test/unit/public-cli-resume.test.ts` | ordinary | 16 | 6.0s | 624ms | 831ms | 5.2s | 真行为契约 | 🔒 |
| 23 | `test/contract/run-test-all.test.ts` | ordinary | 6 | 5.5s | 2.7s | 570ms | 5.0s | 只测 helper | 🔒 |
| 24 | `test/contract/reviewer-pinned-reader.test.ts` | ordinary | 6 | 5.0s | 2.4s | 961ms | 4.0s | 真行为契约 | 🔒 |
| 25 | `test/package/npm-identity-metadata.test.ts` | ordinary | 7 | 4.8s | 3.3s | 843ms | 4.0s | 真行为契约 | 🔒 |
| 26 | `test/unit/public-cli-reviewer.test.ts` | ordinary | 8 | 4.4s | 2.1s | 1.7s | 2.7s | 真行为契约 | 🔒 |
| 27 | `test/package/pi-test-harness.test.ts` | ordinary | 4 | 3.8s | 3.0s | 3.1s | 663ms | 只测 helper |  |
| 28 | `test/integration/merger-role.test.ts` | ordinary | 7 | 3.6s | 3.3s | 2.1s | 1.5s | 真行为契约 | 🔒 |
| 29 | `test/integration/ticket-snapshot-live.test.ts` | ordinary | 1 | 3.5s | 3.5s | 3.0s | 561ms | 真行为契约 |  |
| 30 | `test/unit/public-cli-doctor.test.ts` | ordinary | 8 | 3.2s | 717ms | 392ms | 2.8s | 真行为契约 | 🔒 |
| 31 | `test/contract/collector-github.test.ts` | ordinary | 17 | 2.7s | 1.1s | 129ms | 2.6s | 真行为契约 | 🔒 |
| 32 | `test/unit/public-cli-coder.test.ts` | ordinary | 6 | 2.3s | 584ms | 313ms | 2.0s | 真行为契约 | 🔒 |
| 33 | `test/contract/navigator-attendance.test.ts` | ordinary | 39 | 2.1s | 462ms | 865ms | 1.3s | 真行为契约 | 🔒 |
| 34 | `test/unit/reviewer-workspace.test.ts` | ordinary | 2 | 2.1s | 1.7s | 258ms | 1.9s | 真行为契约 | 🔒 |
| 35 | `test/unit/public-cli-cli.test.ts` | ordinary | 7 | 2.0s | 1.6s | 408ms | 1.6s | 真行为契约 | 🔒 |
| 36 | `test/unit/public-cli-judge.test.ts` | ordinary | 20 | 2.0s | 547ms | 295ms | 1.7s | 真行为契约 | 🔒 |
| 37 | `test/package/public-cli-bin-artifact.test.ts` | ordinary | 1 | 1.2s | 1.2s | 791ms | 441ms | 真行为契约 | 🔒 |
| 38 | `test/contract/ticket-trajectory.test.ts` | ordinary | 9 | 1.2s | 355ms | 445ms | 746ms | 真行为契约 | 🔒 |
| 39 | `test/integration/package-owned-tool-idle.test.ts` | ordinary | 3 | 747ms | 395ms | 241ms | 506ms | 真行为契约 | 🔒 |
| 40 | `test/integration/collector-real-entry.test.ts` | ordinary | 5 | 546ms | 182ms | 300ms | 246ms | 真行为契约 | 🔒 |
| 41 | `test/unit/auditor-lifecycle.test.ts` | ordinary | 16 | 496ms | 115ms | 444ms | 52ms | 真行为契约 | 🔒 |
| 42 | `test/contract/doctor-case.test.ts` | ordinary | 14 | 448ms | 175ms | 77ms | 372ms | 真行为契约 | 🔒 |
| 43 | `test/contract/canonical-skill-binding.test.ts` | ordinary | 3 | 356ms | 250ms | 102ms | 254ms | 真行为契约 | 🔒 |
| 44 | `test/unit/public-cli-collector.test.ts` | ordinary | 2 | 337ms | 335ms | 72ms | 266ms | 真行为契约 |  |
| 45 | `test/unit/judge-auditor-dossier.test.ts` | ordinary | 4 | 201ms | 159ms | 150ms | 51ms | 真行为契约 | 🔒 |
| 46 | `test/unit/archivist-record-entry.test.ts` | ordinary | 1 | 191ms | 191ms | 80ms | 110ms | 真行为契约 | 🔒 |
| 47 | `test/contract/collector-identity.test.ts` | ordinary | 11 | 162ms | 91ms | 56ms | 106ms | 真行为契约 |  |
| 48 | `test/unit/package-method-skill.test.ts` | ordinary | 7 | 129ms | 48ms | 65ms | 64ms | 真行为契约 | 🔒 |
| 49 | `test/contract/activation-reconciliation.test.ts` | ordinary | 4 | 118ms | 115ms | 69ms | 49ms | 真行为契约 | 🔒 |
| 50 | `test/contract/collector-config.test.ts` | ordinary | 2 | 91ms | 83ms | 19ms | 72ms | 真行为契约 | 🔒 |
| 51 | `test/unit/judge-auditor.test.ts` | ordinary | 1 | 84ms | 84ms | 37ms | 47ms | 真行为契约 | 🔒 |
| 52 | `test/unit/public-cli-config.test.ts` | ordinary | 4 | 83ms | 64ms | 19ms | 65ms | 真行为契约 |  |
| 53 | `test/unit/public-run-credentials.test.ts` | ordinary | 4 | 48ms | 34ms | 12ms | 36ms | 真行为契约 | 🔒 |
| 54 | `test/unit/reviewer-child-failure-projection.test.ts` | ordinary | 2 | 38ms | 37ms | 1ms | 37ms | 真行为契约 |  |
| 55 | `test/unit/human-format.test.ts` | ordinary | 2 | 32ms | 29ms | 26ms | 5ms | 真行为契约 |  |
| 56 | `test/unit/host-pi-runtime.test.ts` | ordinary | 3 | 21ms | 13ms | 9ms | 12ms | 真行为契约 | 🔒 |
| 57 | `test/contract/doctor-role.test.ts` | ordinary | 2 | 15ms | 13ms | 5ms | 10ms | 真行为契约 | 🔒 |
| 58 | `test/unit/dossier-resolution.test.ts` | ordinary | 2 | 15ms | 12ms | 22ms | -8ms | 真行为契约 | 🔒 |
| 59 | `test/unit/public-cli-terminal-classifier.test.ts` | ordinary | 1 | 13ms | 13ms | 5ms | 8ms | 真行为契约 |  |
| 60 | `test/contract/fixer-prerequisite-contract.test.ts` | ordinary | 6 | 10ms | 6ms | 14ms | -4ms | 真行为契约 | 🔒 |
| 61 | `test/unit/fixer-contract.test.ts` | ordinary | 1 | 8ms | 8ms | 6ms | 2ms | 真行为契约 | 🔒 |
| 62 | `test/contract/judge-posture-recordings.test.ts` | ordinary | 12 | 5ms | 2ms | 8ms | -3ms | 真行为契约 |  |
| 63 | `test/contract/reviewer-runtime-receipt.test.ts` | ordinary | 5 | 5ms | 2ms | 7ms | -2ms | 真行为契约 | 🔒 |
| 64 | `test/unit/merger-contract.test.ts` | ordinary | 3 | 4ms | 2ms | 3ms | 1ms | 真行为契约 | 🔒 |
| 65 | `test/contract/audit-escalation.test.ts` | ordinary | 7 | 3ms | 2ms | 4ms | 0ms | 真行为契约 | 🔒 |
| 66 | `test/unit/reviewer-dispatch.test.ts` | ordinary | 4 | 3ms | 2ms | 4ms | -1ms | 真行为契约 |  |
| 67 | `test/unit/stream-idle-guard.test.ts` | ordinary | 8 | 3ms | 1ms | 5ms | -2ms | 真行为契约 | 🔒 |
| 68 | `test/unit/public-cli-registry.test.ts` | ordinary | 3 | 2ms | 1ms | 2ms | 0ms | 真行为契约 | 🔒 |
| 69 | `test/unit/canonical-json.test.ts` | ordinary | 3 | 2ms | 1ms | 3ms | -1ms | 真行为契约 |  |
| 70 | `test/unit/judge-output-contract.test.ts` | ordinary | 2 | 1ms | 1ms | 1ms | 0ms | 真行为契约 |  |
| 71 | `test/unit/missing-receipt-policy.test.ts` | ordinary | 4 | 1ms | 1ms | 2ms | -1ms | 真行为契约 | 🔒 |
| 72 | `test/unit/judge-recording-anti-forge.test.ts` | ordinary | 1 | 1ms | 1ms | 1ms | 0ms | 真行为契约 | 🔒 |
| 73 | `test/contract/class-contracts.test.ts` | ordinary | 1 | 1ms | 1ms | 1ms | 0ms | 真行为契约 |  |
| 74 | `test/unit/doctor-auditor.test.ts` | ordinary | 1 | — | — | 1.9s | — | 真行为契约 | 🔒 |

#### 五尺汇总（文件级主标签）

| 五尺 | 文件数 | 说明 |
|------|------:|------|
| 真行为契约 | 72 | 产物/角色/发布/进程边界上的接受-拒绝不变式 |
| 盯文 | 0（文件级） | 无整文件以散文/Soul 措辞为唯一真源；见 kill-list 案级边缘 |
| 重复 | 0（文件级） | 无整文件可标纯重复；见 kill-list **主题重叠**（不同 seam） |
| 只测 helper | 2 | 调度器/夹具自身，非产品角色行为 |
| mock 伪行为 | 0（文件级） | fauxProvider 多锚在真实 tool/session/Terminal 断言，不构成「只演 mock」整文件 |

🔒 文件数（含闸类负向）：**59** / 74

文件级注记（非穷尽）：

- `test/package/package-entrypoint.integration.test.ts`：打包入口×Navigator/Judge/Coder/Fixer 多边界；内含多条闸类负向。文件过胖，见 kill-list 拆/并建议。
- `test/integration/public-cli-coder-installed-run.test.ts`：cold-install coder apply 全链 Terminal；与 package-entrypoint coder 案有主题重叠但 seam 不同（ak-role bin vs -e entrypoint）。
- `test/package/public-cli-install.test.ts`：Pi private npm bin 发现 ak-role；安装面闸。
- `test/integration/audit-failure-subprocess.test.ts`：Reviewer fatal abort without receipt 🔒 典型闸类负向。
- `test/unit/judge-auditor-fixture-tracer.test.ts`：tarball .bin auditor dossier 隔离 🔒；名 unit 实为 package 级。
- `test/package/reviewer-package-lifecycle.test.ts`：tarball Reviewer→auditor→Judge 链。
- `test/package/doctor-package-lifecycle.test.ts`：Doctor 冷装生命周期。
- `test/contract/factory-board.test.ts`：factory-board 真路径；本地最慢案含 live-ish S3 trajectory。
- `test/contract/judge-role.test.ts`：judge 角色契约含 tdd expansion 绑定；本地单案 ~14s。
- `test/package/public-cli-cold-matrix.test.ts`：cold matrix 多角色；与 lifecycle 有构造重叠。
- `test/unit/public-cli-failure-settlement.test.ts`：failure settlement 大表；含闸类。可能有同构重复格。
- `test/package/collector-package-lifecycle.test.ts`：Collector 冷装+默认 gh transport。
- `test/unit/public-cli-explicit-internal.test.ts`：explicit internal 入口；本地偏慢需查是否重复起 Pi。
- `test/contract/run-test-all.test.ts`：调度器自身契约：heavyweight 清单完备/不重/串行；含 must-fail 分区负向。不是产品角色行为。
- `test/package/npm-identity-metadata.test.ts`：npm 身份/files/bin/peer 发布面；非散文盯文。
- `test/package/pi-test-harness.test.ts`：测 pi-test-harness 夹具本身（pack/cold-install memo、隔离）。产品契约在消费方。
- `test/package/public-cli-bin-artifact.test.ts`：pack 后 bin 入口与 shebang/可执行边界；发布面闸。
- `test/unit/human-format.test.ts`：格式投影纯函数；若只比对长散文则边缘盯文，需逐案看。
- `test/contract/audit-escalation.test.ts`：escalation 投影闸 🔒
- `test/unit/stream-idle-guard.test.ts`：idle guard 闸。
- `test/unit/canonical-json.test.ts`：canonical JSON 稳定性。
- `test/unit/missing-receipt-policy.test.ts`：no-receipt 策略闸 🔒
- `test/unit/judge-recording-anti-forge.test.ts`：anti-forge 闸 🔒
- `test/contract/class-contracts.test.ts`：类契约登记。
- `test/unit/doctor-auditor.test.ts`：local leaf names not file-mapped in this pass; CI suite ~1.9s

---

## 2. 点名：`package-entrypoint.integration.test.ts` 慢因（#215 ~565s）

### 2.1 本轮实测（不再是 565s）

| 口径 | 本地 | CI（同 SHA） |
|------|-----:|-------------:|
| 文件 leaf Σ | **67.1s**（19 案） | **~71.1s**（19 案） |
| 最慢单案 | 23.7s | ~23.7s |
| 占 heavy 串行腿 | 与另两 heavy 文件串行，heavy 段 wall 149.7s | ~155s |

**结论：#215 庭审「~565s」描述的是历史构造税，不是当前 HEAD 的稳态成本。** 当前该文件已回到 ~70s 量级（仍远超参考尺份额，但是可审计的真实 Pi/进程成本，不是 pack 死循环）。

### 2.2 共享夹具微剖面（同机器，`getShared*` API）

| 步骤 | ms | 含义 |
|------|---:|------|
| `cold-getSharedIsolatedPack` | 4600 | 首次 npm pack（物化树 + pack） |
| `warm-getSharedIsolatedPack` | 0 | 同进程 memo 命中 |
| `cold-getSharedColdInstalledPackage` | 2608 | 首次 npm install 消费树 |
| `warm-getSharedColdInstalledPackage` | 0 | 同进程 memo 命中 |
| `cloneSharedColdInstall` | 1767 | cp 共享冷装树到私有 consumer |
| `cloneSharedColdInstall-2` | 1660 | cp 共享冷装树到私有 consumer |

本轮全量跑时指纹 `505542fdd1c60c5c3f6281af`（HEAD `d1e07c1d`）落在 macOS 用户临时目录  
`$TMPDIR/ak-pi-workflow-roles-cold-fixtures/`（非 `/tmp` 旧缓存）。  
冷装路径已是 **一次 pack + 一次 install + 每案 clone**（`test/helpers/pi-test-harness.ts` `getSharedIsolatedPack` / `getSharedColdInstalledPackage` / `withColdInstalledPackage`）。

### 2.3 逐案（本地 TAP）— 慢在哪

| ms | case | 慢因（源码级） |
|---:|------|----------------|
| 23.7s | fresh packaged processes resume cross-role Navigator route memory and isolate subjects | 两条独立 node 子进程各跑完整 withInProcessPi（coder→fixer），外加 git fixture + porcelain 字节级比对（L1866–1958）。进程边界本身 ~24s。 |
| 11.9s | cold-installed live help follows the loaded extension and changes on the next hint | withColdInstalledPackage + 多次真实 runPiSubprocess(... --help) + 改写已装 runtime 字节验证 live reread（L899+）。字符串 Activate a packaged workflow role: 是 live-reload 探针锚点，不是纯盯文。 |
| 11.2s | installed composition emits admitted-role tool-execution JSONL on stderr for real bash output and never for Navigator prepare | 真实 runPiSubprocess + bash fixture provider；断言 stderr JSONL 且 Navigator prepare 永不出现在 observation（L2449）🔒。 |
| 11.0s | ordinary Navigator attendance persists preparation, settlement, and visible ordering | in-process/packaged Navigator 全路径 settlement 时序。 |
| 3.2s | cold-installed package audits active auditor seats from editable Souls | 冷装后动态 import 已装 auditor 模块（L300）；pack/install 已被共享夹具摊销，本案 ~3s。 |
| 1.2s | installed composition without --ak-role emits no tool-execution observation records | 对偶负向：无 --ak-role 时零 observation（L2538）🔒。 |
| 927ms | normal packaged Navigator failures remain typed, native-cause, and Receipt-preserving across the cause matrix | in-process Pi / 断言产品边界；非网络 registry。 |
| 725ms | packaged coder apply proves canonical native tdd expansion including colliding prefix | packaged 缝上的 tdd 扩展；与 judge-role.test.ts 主题相关但 seam 不同。 |
| 717ms | normal packaged roles retain typed cross-role Navigator continuity and isolate subjects | in-process Pi / 断言产品边界；非网络 registry。 |
| 541ms | packaged fixer applies its both-phase bash seatbelt, retains its tool surface, and enforces singleton output | Fixer seatbelt 闸 🔒（L2234）。 |
| 482ms | normal packaged Navigator presents independently in print and JSON and reuses one subject session | in-process Pi / 断言产品边界；非网络 registry。 |
| 318ms | normal packaged Navigator drains one healthy preparation across recommendation and silent settlements | in-process Pi / 断言产品边界；非网络 registry。 |
| 285ms | packaged role-input outside /.ak/work/ with no authority file projects exact input bytes | in-process Pi / 断言产品边界；非网络 registry。 |
| 229ms | packaged judge crosses Pi's loader, schema, persisted batch, auth-resolved audit, and termination boundaries offline | in-process Pi / 断言产品边界；非网络 registry。 |
| 177ms | ongoing packaged session keeps healthy Navigator prepare across pre-output role failure for the next accepted terminal | in-process Pi / 断言产品边界；非网络 registry。 |
| 166ms | packaged judge escalation emits one typed human decision | in-process Pi / 断言产品边界；非网络 registry。 |
| 148ms | role outputs run nested audits through pass, revise, and escalation | in-process Pi / 断言产品边界；非网络 registry。 |
| 127ms | normal packaged context-loader failure is typed unavailable and preserves the role Receipt | in-process Pi / 断言产品边界；非网络 registry。 |
| 65ms | packed package includes Doctor role, evidence flag, and runtime dependencies | 只读共享 tarball 路径清单（~65ms）— 已是便宜构造。 |

### 2.4 #215 ~565s 历史差值还原

| 因子 | 证据 | 对 565s 的贡献判断 |
|------|------|-------------------|
| **重复 npm pack / 冷装** | 旧构造每案独立 pack；现 `getSharedIsolatedPack` 一次 ~4.6s | **主因（历史）**：多案 × 全量 pack+install 可堆到数分钟 |
| **真实 Pi 子进程** | 本轮仍有 4 案 >10s，皆 `runPiSubprocess` / 多进程 | **主因（当前）**：~40–50s 量级硬成本 |
| **网络 registry** | 冷装依赖 `file:` tarball + 本地 `file:` peers + 钉死 typebox@1.3.8 | **非主因**（无远程 pack 拉取） |
| **文件系统 clone** | macOS 上 `cloneSharedColdInstall` ~1.7s/次；install 类文件本地显著慢于 Linux CI | **次因**（放大 cold 消费案） |
| **测试逻辑忙等** | live-help timeout 常量有限（assert ≤60s），本案未睡满 | **非主因** |

**可裁改造方向（建议，本轮不施工）**：

1. **拆文件**：按 seam 把 2566 行/19 案拆成 Navigator / cold-help / observation / worker-gates 四文件，便于 ordinary 并行（现整文件锁在 heavy 串行腿）。
2. **保持共享 pack**：禁止回归每案 pack；harness 自测已覆盖 memo（`pi-test-harness.test.ts`）。
3. **fresh-process 案**：评估是否可用更轻的 process 边界（单子进程双 role 串行 vs 双进程）而不削弱「跨进程 route memory」契约。
4. **live-help 案**：`--help` 子进程次数可合并/缓存角色 help 字节，保留「改字节后二次 prepare 必读新值」闸。
5. **不要**为了速度把闸类负向（observation never Navigator / 无 role 零 observation / seatbelt）改成 mock 内断言。

---

## 3. CI ~5 分钟 vs 本地差值来源

### 3.1 先对齐「5 分钟」指什么

| 层 | CI（run 31711243886） | 本地本轮 |
|----|----------------------:|---------:|
| job 总墙钟 | **5m8s** | n/a（未跑完整 GHA 步骤） |
| checkout + pnpm + node setup + install + typecheck | ~17s | install 已 frozen 完成（311ms 提示 hit store） |
| **`pnpm run test:all` 墙钟** | **~285s** | **~237s** |

**本轮事实：同 SHA 下本地 test:all 墙钟快于 CI ~48s**，不是「本地更慢」。  
票面「CI ~5 分钟 vs 本地」在历史语境里常把 job 总时长与本地恶例（#215 单文件 565s）对比；**当前数据应改读为：全量已收敛到 4–5 分钟量级，本地与 CI 同阶，本地略快。**

### 3.2 差值分解

1. **调度形状**  
   - ordinary 并行 + heavy 串行。  
   - 本地 ordinary wall **87s** vs CI ordinary **~130s**（CI 并行度/CPU 较弱，ordinary 更拖）。  
   - heavy 串行两边接近（本地 150s / CI 155s）— 三文件 Σ 主导，机器差影响小。

2. **OS / 文件系统**（本地更慢的文件，Σ 口径）  
   - `public-cli-install`：**+22.9s**（Pi private npm 安装 + 多角色 admits；macOS cp/npm 更重）  
   - `factory-board`：**+18.0s** — 本地执行 **true-home** 案 `S3 true-home acceptance: #127...`（L2526，读 `~/.ak-roles/books/...` 真账并 `cp` 大 ledger）；CI 无该 home 时 **early return 跳过**  
   - `judge-role`：**+18.1s** — 本地 `coder apply binds completion to the immediately following canonical tdd expansion` ~14.6s（真 git + tdd 扩展）；CI 同案明显更快  
   - lifecycle/cold 消费：doctor/collector/coder-installed/merger 各 **+7–13s**

3. **CI 不慢于本地的部分**  
   - `package-entrypoint` CI 甚至略慢（+4s）  
   - heavy 闸类 subprocess 两边同阶

4. **环境旗标**  
   - 两边 `AK_LEGACY_CASE_A_LIVE_SOURCE=0`  
   - CI 额外 `GH_TOKEN` — 影响 live GitHub 案（如 ticket snapshot）；非 package-entrypoint 主路径

5. **历史 565s 与今 237s**  
   - 主差：共享 pack/cold 夹具落地 + heavy 分区（#160）避免多文件互相打满机器  
   - 次差：用例本身收敛（issue-92 重建波次）

### 3.3 对 owner 预算的含义

- 想靠近 **120s** 参考尺：砍/并的主要杠杆在 **heavy 串行三文件 + ordinary 里 ≥20s 的 cold/install 单案**，不是 unit 里毫秒级表驱动。  
- 仅优化 CI 机器或仅优化本地 true-home，都不够单独达标。

---

## 4. kill-list（建议；带一手证据；本轮不执行）

> 三类：`删` / `合并` / `改造`。  
> 🔒 = 闸类负向，**删列不得吸收**；只能改承载或合并到仍保留断言的更便宜构造。

### 4.1 建议 `删`（高门槛；本轮仅候选）

| ID | 目标 | 证据 | 理由 | 风险 |
|----|------|------|------|------|
| D1 | `package-method-skill.test.ts` 内两行散文 includes | L91–92：`tests.includes("Good and Bad Tests")` / `mocking.includes("When to Mock")` | **案级盯文边缘**：同文件已有 sha256/gitBlob 钉扎（L80–85）；标题字符串不增加字节完整性 | 低：删 includes 不影响 pin |
| D2 | （无整文件建议删） | — | 74 文件主标签无「纯盯文/纯重复/纯 mock」整文件 | — |

> 不把 🔒 闸类负向放入删列。

### 4.2 建议 `合并`（主题重叠 → 单承载）

| ID | 目标 | 证据 | 建议 | 预估节省 |
|----|------|------|------|----------|
| M1 | Coder tdd 扩展双缝 | `judge-role.test.ts` L935 `coder apply binds completion to the immediately following canonical tdd expansion`（本地 ~14.6s）× `package-entrypoint` L2045 `packaged coder apply proves canonical native tdd...`（~0.7s） | **保留 packaged 缝一条**作发布面；contract 缝改为轻量「扩展绑定 API」或并入 packaged 断言 | 本地 ordinary 可回 ~10–14s（若 contract 重案可降级） |
| M2 | cold 安装 × 单角色 lifecycle 矩阵 | `public-cli-cold-matrix.test.ts` L312 七角色一冷装；与 `reviewer/doctor/collector-package-lifecycle.test.ts`、`public-cli-install.test.ts` L296/417/532 单角色 admits 主题重叠 | 以 cold-matrix 为「全角色冒烟」真源；lifecycle 只留 **该角色独有** 深链（如 Reviewer→auditor→Judge、Doctor audited output） | ordinary Σ 可降，wall 视并行而定 |
| M3 | Coder 冷装生产链 × install admits | `public-cli-coder-installed-run.test.ts` 单案 **58.8s**（全链 Terminal）× `public-cli-install` L296 coder admits（较浅） | install 案只断言 bin/技能路径；深链只留 coder-installed-run 🔒 | install 文件本地 ~数秒 |
| M4 | Reviewer fatal 双承载 | `audit-failure-subprocess.test.ts` L523 installed fatal without receipt 🔒 × L556 in-process fatal without receipt 🔒 | **两条都是闸**，不可删并成零；可合并为表驱动同一断言函数、共享一次 cold 夹具 | heavy 壁钟小幅 |

### 4.3 建议 `改造`（降构造 / 纠分层 / 拆锁串行）

| ID | 目标 | 证据 | 改造 | 预估 |
|----|------|------|------|------|
| R1 | 拆 `package-entrypoint.integration.test.ts` | 2566 行 / 19 案 / heavy 清单整文件串行；Σ ~67s | 拆为 navigator / cold-help / observation / packaged-workers；**仅**仍互斥打满机器的留 heavy | heavy wall 可降，部分案进 ordinary 并行 |
| R2 | `fresh packaged processes...` | L1866–1958：双 `runNodeSubprocess` 各起全 Pi；本地/CI 皆 ~23–25s | 证「跨进程 route memory」是否可用：单 OS 进程 + 两次 isolated agentDir，或一次子进程写盘二次读 | 有望 −15s heavy |
| R3 | `cold-installed live help...` | L899+ 多次真实 `role --help` 子进程；Σ 贡献 ~12–18s | 缓存 help 字节、减少角色遍历次数；保留改文件后二次 prepare 必见新 marker 🔒 | −5–10s heavy |
| R4 | 错层 `unit/` 实为 package | `judge-auditor-fixture-tracer.test.ts` 2 案 Σ **47.9s**（tarball .bin + 双进程隔离 🔒） | 移入 `test/package/`，并进 heavy 或与 auditor lifecycle 共享冷装 | 分类诚实；wall 视调度 |
| R5 | `public-cli-install` Pi install 路径 | 本地 Σ 49s / CI 26s；L31 真 `pi install` | 确认是否已用共享 tarball；避免每案重复 pi install 写 settings | 本地 ordinary 明显 |
| R6 | factory-board true-home | L2526 true-home 案本地 ~15s；CI skip | 标显式 skip 条件；或拆到可选 suite，避免「同文件 CI/本地行为静默分叉」被误读成 flakiness | 本地 −15s；CI 无变 |
| R7 | failure-settlement 大表 | 51 案 Σ 18.4s；含 real default-Pi auditor provider stop ~3s | 表驱动共享 session 起手；贵案（真 Pi stop）单列 | ordinary 小幅 |
| R8 | helper 自测成本 | `run-test-all.test.ts` 本地 5.5s（含调度负向 🔒）；`pi-test-harness.test.ts` 3.8s | 保留 🔒 分区完备性；压缩 timeout 类子进程 sleep（harness 子进程 seam ~3s） | −2–4s |
| R9 | heavy 清单再分区 | 三文件串行合计 ~150s | 实测两两并行冲突后再定；**不可**为速度并行已知互相抢 cold lock 的文件 | 潜在 −30–60s 若安全并行 |

### 4.4 明确 **不可动**（🔒 样例，过庭时作否决表）

| 案 | 位置 | 为何锁 |
|----|------|--------|
| installed Reviewer fatal stages abort without a receipt | `audit-failure-subprocess.test.ts` L523 | 无 receipt 的 must-reject 闸 |
| Reviewer fatal audit stages fail closed in-process without a receipt | 同文件 L556 | 同上，in-process 缝 |
| tool-execution JSONL ... never for Navigator prepare | `package-entrypoint` L2449 | observation 面不得泄露私 Navigator |
| without --ak-role emits no tool-execution observation records | L2538 | 无角色零观察 |
| packaged fixer ... bash seatbelt ... singleton output | L2234 | seatbelt + 单例输出闸 |
| two independent packaged Pi processes cannot cross auditor dossiers | `judge-auditor-fixture-tracer.test.ts` | 卷宗隔离闸 |
| Merger terminal ... abort without accepting a receipt | `merger-role.test.ts` L150 | 收据拒收闸 |
| run-test-all 分区/清单完备负向 | `run-test-all.test.ts` | 调度器自身闸（只测 helper，但 🔒） |

---

## 5. 证据索引（一手）

| 产物 | 路径 |
|------|------|
| 本地 ordinary TAP | 采集机 `/tmp/test-audit-319/ordinary.tap` |
| 本地 heavy TAP | 采集机 `/tmp/test-audit-319/heavy.tap` |
| 本地 summary | `totalMs=236677` exit 0；started 2026-08-13T16:12:32.953Z |
| CI log | gh run 31711243886 / 采集机 `/tmp/test-audit-319/ci-main-31711243886.log` |
| pack 微剖面 | 采集机 `/tmp/test-audit-319/pack-cold-profile.json`（at 2026-08-13T15:43:41.373Z） |
| 调度真源 | `scripts/run-test-all.mjs` |
| 共享冷装真源 | `test/helpers/pi-test-harness.ts`（`getSharedIsolatedPack` / `getSharedColdInstalledPackage`） |

复现采集（只读，不改仓）：

```bash
pnpm install --frozen-lockfile
# 同构于 scripts/run-test-all.mjs，仅 --test-reporter=tap
# ordinary 71 files → heavy 3 files concurrency=1
# env: isolatedTestProcessEnv() + AK_LEGACY_CASE_A_LIVE_SOURCE=0
```

---

## 6. 验收对照

| 票面 AC | 状态 |
|---------|------|
| 审计报告于仓根 `TEST_AUDIT_319.md` | ✅ 本文件 |
| 含计时总表 | ✅ §1.2 |
| 含五尺分类 | ✅ §1.2 + 汇总 |
| 含带证据 kill-list | ✅ §4 |
| 含 CI vs 本地差值分析 | ✅ §3 |
| 点名 package-entrypoint / #215 | ✅ §2 |
| 本轮零删除、零测试修改 | ✅ 仅新增本 MD |
| kill-list 过庭后方可执行批次 | ⏳ 交大理寺 |
| 参考尺 120s / 终线 owner 拍板 | 📊 数据已给出：本地 ~237s / CI test ~285s / job ~5m8s |

---

## 7. 给后续执行批的优先级（非授权，仅导航）

1. **R1+R2+R3**（拆 package-entrypoint + 砍双进程/help 子进程）— 直击 heavy ~150s。  
2. **M2+M3+R5**（cold/install 矩阵去重）— 直击 ordinary 里 20–60s 单案。  
3. **R4+R6**（分层诚实 + true-home 显式）— 降误读与本地独有税。  
4. **D1** 等案级盯文 — 便宜清理，对 wall 几乎无感。

**未授权前禁止删 🔒 案。**
