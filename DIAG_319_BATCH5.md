# DIAG_319_BATCH5 — R7 / R9 纯诊断（零代码修改）

> 票：#319 Batch 5  
> head：`35eb0a86`（Batch 4 R1 package-entrypoint 主题拆分后）  
> 约束：**零产品/测试代码修改**；本文件为唯一交付物。  
> 主机：Darwin arm64 · Apple M5 · 10 逻辑核 · Node v22.23.0  
> 环境：`AK_LEGACY_CASE_A_LIVE_SOURCE=0`；诊断前无并行 `test:all` / heavy 大腿。  
> 原始证据目录（本机）：`/tmp/diag-319-batch5/`（`r9-summary.json` / `heavy-lane-summary.json` / `r7-summary.json` / `test-all-*.txt`）

---

## 0. 范围与方法

### 0.1 庭定 batchOrder 本批刀口

| 项 | 内容 |
|----|------|
| **R9** | heavy 清单**现有 6 文件**（含 Batch 4 拆出的四个 `package-entrypoint-*`）两两并行实测：cold lock / 共享资源冲突 vs 可安全并行；附实跑证据与建议分区 |
| **R9 附** | 若存在安全并行组合，估算 heavy wall 收益 |
| **R7** | `public-cli-failure-settlement` 51 案共享 session 起手可行性：起手成本分布、贵案（真 Pi provider stop）占比、共享后隔离性风险 → 可裁结论 |
| **附带** | 静机完整 `pnpm run test:all` 干净终线计时 |

### 0.2 Heavy 清单（现状真源）

`scripts/run-test-all.mjs` `HEAVYWEIGHT_MANIFEST` / `test/contract/run-test-all.test.ts` `TICKET_HEAVYWEIGHT`：

1. `test/integration/audit-failure-subprocess.test.ts` → **audit-fail**
2. `test/integration/public-cli-judge-run.test.ts` → **judge-run**
3. `test/package/package-entrypoint-cold-help.integration.test.ts` → **pe-cold-help**
4. `test/package/package-entrypoint-navigator.integration.test.ts` → **pe-navigator**
5. `test/package/package-entrypoint-observation.integration.test.ts` → **pe-observation**
6. `test/package/package-entrypoint-packaged-workers.integration.test.ts` → **pe-packaged-workers**

调度现状：ordinary 默认并行 → heavy 单子进程 `--test-concurrency=1` 串行。

### 0.3 共享资源图谱（静态）

| 资源 | 实现 | 谁用 | 跨进程？ |
|------|------|------|----------|
| cold pack lock | `getSharedIsolatedPack` → `FIXTURE_CACHE_ROOT/<fp>/pack/.lock` | 四个 pe-*（及 ordinary cold 消费方） | ✅ 目录锁 |
| cold install lock | `getSharedColdInstalledPackage` → `.../cold-install-v2/.lock` | pe-* via `withColdInstalledPackage` | ✅ 目录锁 |
| process-global lock | `withProcessGlobalLock`（串行化 `HOME`/`chdir`） | `withHermeticHome` / `withProcessCwd`（audit-fail 等） | ❌ 仅同进程 |
| 真 Pi 子进程 CPU/IO | `runPiSubprocess` / `runNodeSubprocess` / `runAkRole` | 全部 heavy | 机器饱和 |

诊断前已 **warm** 当前 HEAD 指纹的 pack + cold-install（首次 build ~3.2s），避免把「首构抢锁」误判为「稳态冲突」。

### 0.4 实测模式

1. **Solo**：每文件独立 `node --test --test-concurrency=1`（干净基线）  
2. **Pair · two-OS-process**：C(6,2)=15 对，两进程并行各跑一文件  
3. **Pair · same-process c=2**：同 15 对，单进程 `--test-concurrency=2`  
4. **Heavy lane**：全 6 文件 c=1 / c=2 / c=3；以及 2-lane LPT 双进程  
5. **R7**：51 案 TAP `duration_ms` + 源码静态分桶  
6. **test:all**：仓内 `pnpm run test:all` 一次

判定口径：

- **安全并行**：两腿均 pass，且无 `timed out waiting for fixture lock/readiness`  
- **抢锁/冲突**：fail / lock timeout / wall ≈ serial sum 且无加速（持续互斥）  
- **overhead_vs_max** = `(pair_wall − max(solo_a, solo_b)) / max(...)`（相对理想并行的膨胀）

---

## 1. 附带：静机 `pnpm run test:all` 干净终线

| 项 | 值 |
|----|----|
| 开始 (UTC) | 2026-08-13T18:22:53Z |
| 结束 (UTC) | 2026-08-13T18:25:50Z |
| **wall（`time -p real`）** | **176.21s** |
| exit | **0**（全绿） |
| ordinary | 499 leaf · suite `duration_ms` **45.29s** |
| heavy | 27 leaf · suite `duration_ms` **130.62s** |
| ordinary+heavy（suite 相加） | 175.91s ≈ wall（调度间隙可忽略） |
| loadavg（跑时附近） | ~4.4–6.0（无第二套 test:all） |

对照：

| 基线 | wall | 说明 |
|------|-----:|------|
| 本票审计初采（`d1e07c1d`，heavy 3 文件） | 236.7s | TEST_AUDIT_319 |
| **Batch 5 静机终线（`35eb0a86`，heavy 6 文件串行）** | **176.2s** | 本诊断；Batch 0–4 已落地后的干净线 |
| owner 参考尺 | 120s | 仍超 **+56s（1.47×）** |

> 终线证据：`/tmp/diag-319-batch5/test-all-meta.txt`、`test-all.stdout`（ordinary `# duration_ms 45292` + heavy `# duration_ms 130615`）。

---

## 2. R9 — heavy 两两并行实测

### 2.1 Solo 基线（warm cold 后）

| short | file | wall | pass |
|------:|------|-----:|:----:|
| audit-fail | `.../audit-failure-subprocess.test.ts` | **28.1s** | ✅ |
| judge-run | `.../public-cli-judge-run.test.ts` | **24.9s** | ✅ |
| pe-cold-help | `.../package-entrypoint-cold-help...` | **15.9s** | ✅ |
| pe-navigator | `.../package-entrypoint-navigator...` | **34.7s** | ✅ |
| pe-observation | `.../package-entrypoint-observation...` | **12.3s** | ✅ |
| pe-packaged-workers | `.../package-entrypoint-packaged-workers...` | **12.6s** | ✅ |
| **Σ solo** | | **128.4s** | |
| heavy_all c=1（同序整腿） | 6 files | **130.2s** | ✅ |

与 test:all heavy 段 130.6s 一致（量级闭合）。

### 2.2 全部 15 对 · two-OS-process

| # | A \|\| B | pair wall | solo max | solo sum | speedup | ovh vs max | lock hits | pass |
|--:|---------|----------:|---------:|---------:|--------:|-----------:|----------:|:----:|
| 1 | audit-fail \|\| judge-run | 29.3s | 28.1s | 53.0s | **1.81×** | 4% | 0 | ✅ |
| 2 | audit-fail \|\| pe-cold-help | 29.7s | 28.1s | 44.0s | 1.48× | 6% | 0 | ✅ |
| 3 | audit-fail \|\| pe-navigator | 35.3s | 34.7s | 62.8s | **1.78×** | 2% | 0 | ✅ |
| 4 | audit-fail \|\| pe-observation | 28.5s | 28.1s | 40.4s | 1.42× | 1% | 0 | ✅ |
| 5 | audit-fail \|\| pe-packaged-workers | 29.4s | 28.1s | 40.7s | 1.38× | 5% | 0 | ✅ |
| 6 | judge-run \|\| pe-cold-help | 28.1s | 24.9s | 40.8s | 1.45× | 13% | 0 | ✅ |
| 7 | judge-run \|\| pe-navigator | 35.1s | 34.7s | 59.6s | **1.70×** | 1% | 0 | ✅ |
| 8 | judge-run \|\| pe-observation | 24.9s | 24.9s | 37.2s | 1.50× | 0% | 0 | ✅ |
| 9 | judge-run \|\| pe-packaged-workers | 25.0s | 24.9s | 37.5s | 1.50× | 0% | 0 | ✅ |
| 10 | pe-cold-help \|\| pe-navigator | 34.7s | 34.7s | 50.5s | 1.45× | 0% | 0 | ✅ |
| 11 | pe-cold-help \|\| pe-observation | 16.0s | 15.9s | 28.1s | **1.75×** | 1% | 0 | ✅ |
| 12 | pe-cold-help \|\| pe-packaged-workers | 16.4s | 15.9s | 28.5s | **1.74×** | 3% | 0 | ✅ |
| 13 | pe-navigator \|\| pe-observation | 34.9s | 34.7s | 46.9s | 1.35× | 1% | 0 | ✅ |
| 14 | pe-navigator \|\| pe-packaged-workers | 35.7s | 34.7s | 47.2s | 1.32× | 3% | 0 | ✅ |
| 15 | pe-observation \|\| pe-packaged-workers | 12.9s | 12.6s | 24.8s | **1.92×** | 3% | 0 | ✅ |

**结论（two-OS-process）**：

- **15/15 全绿**；**0 次** cold lock / readiness timeout。  
- 无一对退化到「wall ≈ sum」（互斥串行化）；speedup 区间 **1.32×–1.92×**。  
- pe-* 互相对打（同抢 cold clone + 真 Pi）同样安全；最大 ovh 出现在 judge-run∥pe-cold-help（13%），仍远优于串行。  
- **未观察到「必须互斥、不可并行」的文件对。**

### 2.3 全部 15 对 · same-process `--test-concurrency=2`

| # | A + B | pair wall | speedup | ovh vs max | lock hits | pass |
|--:|-------|----------:|--------:|-----------:|----------:|:----:|
| 1 | audit-fail + judge-run | 28.6s | **1.86×** | 2% | 0 | ✅ |
| 2 | audit-fail + pe-cold-help | 29.7s | 1.48× | 6% | 0 | ✅ |
| 3 | audit-fail + pe-navigator | 35.2s | **1.79×** | 1% | 0 | ✅ |
| 4 | audit-fail + pe-observation | 28.1s | 1.43× | 0% | 0 | ✅ |
| 5 | audit-fail + pe-packaged-workers | 30.2s | 1.35× | 7% | 0 | ✅ |
| 6 | judge-run + pe-cold-help | 28.2s | 1.45× | 13% | 0 | ✅ |
| 7 | judge-run + pe-navigator | 34.8s | **1.71×** | 0% | 0 | ✅ |
| 8 | judge-run + pe-observation | 24.9s | 1.49× | 0% | 0 | ✅ |
| 9 | judge-run + pe-packaged-workers | 25.1s | 1.49× | 1% | 0 | ✅ |
| 10 | pe-cold-help + pe-navigator | 36.0s | 1.40× | 4% | 0 | ✅ |
| 11 | pe-cold-help + pe-observation | 17.5s | 1.61× | 10% | 0 | ✅ |
| 12 | pe-cold-help + pe-packaged-workers | 18.1s | 1.57× | 14% | 0 | ✅ |
| 13 | pe-navigator + pe-observation | 37.3s | 1.26× | 8% | 0 | ✅ |
| 14 | pe-navigator + pe-packaged-workers | 36.7s | 1.29× | 6% | 0 | ✅ |
| 15 | pe-observation + pe-packaged-workers | 14.0s | **1.77×** | 11% | 0 | ✅ |

**结论（same-process）**：

- 同样 **15/15 全绿、0 lock timeout**。  
- `withProcessGlobalLock`（audit-fail 的 hermetic HOME）**未**把整文件对打回串行：重活在子进程，锁持有窗口短。  
- 同进程 pe-* 对偶有略高 ovh（最高 14%），仍稳定加速。  
- **含义**：不必为并行性先拆成多 OS lane；**直接把 heavy 子进程 concurrency 从 1 提到 2（或 3）在本机已成立**。

### 2.4 冲突清单 vs 安全并行清单

| 类别 | 组合 | 证据 |
|------|------|------|
| **抢 cold lock 致失败** | **无** | 30 次 pair 跑（15×2 模式）lockHits 全 0 |
| **必须保持互斥** | **无**（在 warm 稳态下） | 无 fail、无 wall≈sum |
| **可安全并行** | **全部 C(6,2) 组合** | §2.2–2.3 |
| **首构冷启动注意** | 任意两 pe-* 在 **空 cache** 上同时 `getShared*` | 设计为目录锁等待（非 fail）；本批已 warm，未把首构等待算进冲突 |

### 2.5 建议分区（供后续执行批，本批不改调度）

**推荐主方案（最小改动）— heavy `concurrency=2`**

- 改动面：`scripts/run-test-all.mjs` heavy 子进程 `--test-concurrency=2`（+ contract 期望同步）。  
- 实跑：`heavy_all_c2` wall **66.7s**（vs c=1 **130.2s`）。  

**可选加强 — heavy `concurrency=3`**

- 实跑：`heavy_all_c3` wall **52.5s**。  
- 机器 10 核足够；CI `ubuntu-latest` 2 核时需复测（本诊断未跑 CI）。

**等价双 lane（LPT 装箱，各 lane 内 c=1）**

| Lane | 文件 | 实跑 wall |
|------|------|----------:|
| A | pe-navigator · pe-cold-help · pe-observation | 63.6s |
| B | audit-fail · judge-run · pe-packaged-workers | 67.5s |
| **双 lane 并行 wall** | | **67.5s** |

与 c=2 同阶；实现成本更高（调度要双 heavy 子进程），**无额外收益** → 不优先。

**不建议**

- 为「避锁」再把 pe-* 拆回互斥串行清单——与本批证据相反。  
- 在未测 CI 双核前直接上 c≥4（收益递减 + 噪点）。

---

## 3. R9 附 — heavy wall 收益估算

### 3.1 实跑整腿

| 配置 | wall | vs c=1 | 备注 |
|------|-----:|-------:|------|
| heavy c=1（现状） | **130.2s** | — | 与 test:all heavy 130.6s 闭合 |
| heavy c=2 | **66.7s** | **−63.5s（−48.8%）** | 全绿 · 0 lock |
| heavy c=3 | **52.5s** | **−77.7s（−59.7%）** | 全绿 · 0 lock |
| two-lane LPT | **67.5s** | **−62.7s（−48.2%）** | ≈ c=2 |

### 3.2 投影到 test:all 终线

以本批静机 ordinary **45.3s** + heavy 替换：

| 场景 | ordinary | heavy | **投影 test:all** | vs 本批 176.2s | vs 参考尺 120s |
|------|----------:|------:|------------------:|---------------:|---------------:|
| 现状 c=1 | 45.3s | 130.6s | **176s** | — | +56s |
| heavy c=2 | 45.3s | 66.7s | **≈112s** | **−64s** | **≈−8s（贴尺内）** |
| heavy c=3 | 45.3s | 52.5s | **≈98s** | **−78s** | **≈−22s** |

> 投影假设 ordinary 与 heavy 仍串行衔接（现状调度）。若 ordinary 已是并行墙钟主导段，heavy 压缩直接减总 wall。  
> **未含 CI 复测**；CI 核数更少时 c=2 更稳妥。

### 3.3 R9 可裁摘要

| 问题 | 裁决建议 |
|------|----------|
| 哪些组合抢 cold lock？ | **稳态下无**；锁仅保护首构，并行等待不失败 |
| 哪些可安全并行？ | **全部 6 文件两两均可**（双模式证据） |
| 建议分区 | **优先 heavy concurrency=2**（或 3）；无需互斥子清单 |
| wall 收益 | c=2 **≈ −64s** heavy / test:all 投影 **≈112s**（贴 120s 尺） |

---

## 4. R7 — failure-settlement 共享 session 起手

### 4.1 实测总览（`test/unit/public-cli-failure-settlement.test.ts`）

| 项 | 值 |
|----|---:|
| leaf 案 | **51**（TAP `1..51`，全 pass） |
| 文件 wall（c=1） | **6.0s** |
| Σ case `duration_ms` | **5.23s** |
| 对照审计初表 Σ | 18.4s（他机/他 SHA；本批机器上该文件已明显更轻） |

### 4.2 起手成本分布（51 案 `duration_ms`）

| 分位 | ms |
|------|---:|
| min | 0.2 |
| p10 | 0.8 |
| p25 | 2.1 |
| **p50** | **103.4** |
| p75 | 105.9 |
| p90 | 110.5 |
| p95 | 119.2 |
| **max** | **943.9** |
| mean | 102.5 |

**形态**：双峰——

1. **纯 unit / 无 home**（~5 案）：亚毫秒–数毫秒  
2. **public entry + 独立 temp home**（主峰 ~30+ 案）：**~100–120ms** 紧簇  
3. **长尾贵案**：真 Pi / 多角色 wiring（见下）

### 4.3 分桶（源码静态 × TAP 合并）

| bucket | n | Σ | mean | max | 含义 |
|--------|--:|--:|-----:|----:|------|
| **injected-runner-public-entry** | 32 | 3.61s | 113ms | 352ms | `runAkRole` + 注入 `piRunner`；每案自建 home |
| **fixture-home-only** | 11 | 0.32s | 29ms | 104ms | temp home / 文件夹具，无完整 public 注入主路径或更轻 |
| **real-default-pi** | **3** | **1.30s** | 434ms | **944ms** | **无 piRunner**，走生产 default Pi runner / 真 provider 边界 |
| **pure-unit-no-session** | 5 | 0.002s | 0.4ms | 0.8ms | 纯函数/分类器 |

### 4.4 贵案（真 Pi / provider stop）占比

| 案名 | ms | 占 Σ |
|------|---:|-----:|
| **Judge publicly retains a real default-Pi auditor provider stop across retention failure** | **943.9** | **18.0%** |
| real Coder/Fixer runs require a legal execution status before accepted settlement | 247.6 | 4.7% |
| default runner empty-auth retains provider cause, identity, and primary diagnostic | 110.3 | 2.1% |
| **real-default-pi 合计（3/51 = 5.9% 案数）** | **1301.8** | **24.9% Σ** |

另：`fast four-role public wiring matrix settles an injected auditor provider stop`（352ms）是**注入** provider stop，不是 default-Pi 真链，但同属「provider stop 语义」贵案。

### 4.5 共享 session 起手 — 隔离性风险

下列案**故意污染** run/session/artifact 拓扑（闸类 🔒 语义依赖「本案私有目录」）：

| 风险模式 | 例案（名摘要） |
|----------|----------------|
| 主 artifact 路径占成目录 → EISDIR | `artifact publication EISDIR...` / `Error Artifact primary collision...` / `exhausted fixed Error Artifact names...` / `post-admission stderr.log EISDIR...` |
| run 目录 chmod 不可写 | `unwritable run directory retains activation cause...` |
| 损坏 session JSONL | `malformed session JSONL settles as typed session...` |
| 空/缺 session | `zero-exit missing session...` |
| retention 路径 EISDIR + 真 Pi | `...real default-Pi auditor provider stop across retention failure` |
| 多角色 / 凭证矩阵 | empty-auth 真 runner、four-role wiring、Coder/Fixer legal status |

若「共享一个 session/home 起手」：

1. **污染写穿**：前案 EISDIR/chmod/malformed 会破坏后案前提 → 假红或假绿。  
2. **runId / book 路径碰撞**：多案写同一 `runs/<id>` 时 artifact 身份与 attendance 断言失真。  
3. **真 Pi 贵案**必须保留独立 agentDir/凭证面；与 injected-runner 混共享会洗 cause。  
4. 主峰 ~100ms 里可摊销的大致是 `mkdtemp + seedGit + 脚手架`；**settlement 本体与故意失败注入不可合并**。

### 4.6 收益上界（即使强行共享）

| 口径 | 假设 | 可省 Σ | 新 Σ | 对文件 wall |
|------|------|-------:|-----:|------------:|
| 乐观 | 46 个 home 案各省 ~74ms 起手 | ~3.3s | ~1.9s | wall 或降到 ~3s 级 |
| 保守 | 仅省 mkdtemp+git ~40ms | ~1.8s | ~3.4s | wall 或降 ~2s |
| 对 test:all | 该文件在 **ordinary 并行**池 | | | **墙钟临界路径贡献通常 ≪ 文件 Σ** |

对比 R9：heavy c=2 单刀 **−64s** 总 wall。R7 全成功也只在 ordinary 池里抠 **1–3s 级**。

### 4.7 R7 可裁结论

## **不值得做**（共享 session 起手改造）

**理由（可核验）**：

1. **绝对收益小**：本机该文件 wall 仅 **6s**，乐观共享省 **~3s Σ**，且 ordinary 并行下对 test:all wall 多半不可见。  
2. **隔离性风险高**：大量闸类案依赖私有 run/session 污染面；共享起手易破坏 🔒 语义或逼出复杂「每案 clone dirty tree」——复杂度≈重写夹具，收益不对等。  
3. **贵案不能吃共享红利**：真 default-Pi provider stop（单案 ~0.9–1s，占 Σ ~18%）必须独享进程/home；共享主峰 100ms 案省不下这条长尾。  
4. **杠杆排序**：同票 R9 heavy 并行是 **−60s 级**；R7 是 **−2s 级**且风险大。应把施工额度留给 R9 分区，而非 failure-settlement 共享 session。

**若未来仍动 R7，更稳的窄刀（非本批范围，仅备忘）**：

- 只对**无磁盘污染**的 injected-runner 表驱动案做 `before` 级 shared pack of pure helpers（不是 shared session）。  
- 真 Pi 三案保持现状独跑。  
- 禁止跨案复用被 chmod/EISDIR/malformed 碰过的目录。

---

## 5. 总裁决表（供大理寺 / 下批施工）

| ID | 诊断题 | 结论 | 证据锚点 |
|----|--------|------|----------|
| R9 | 谁抢 cold lock？ | **稳态无冲突对** | §2.2–2.3 lockHits=0 |
| R9 | 谁可并行？ | **6 文件任意两两** | 15+15 全绿 |
| R9 | 建议分区 | **heavy concurrency=2（可选 3）**；不必互斥子清单 | §2.5、§3.1 |
| R9 附 | heavy wall 收益 | c=2 **−63.5s**；test:all 投影 **≈112s** | §3 |
| R7 | 共享 session 起手 | **不值得做** | §4.7 |
| 附带 | 静机 test:all | **176.2s** 全绿 | §1 |

---

## 6. 证据索引

| 产物 | 路径 |
|------|------|
| R9 汇总 | `/tmp/diag-319-batch5/r9-summary.json` |
| R9 solo/pair meta+tap | `/tmp/diag-319-batch5/solo__*.meta.json` · `pair2p__*` · `pair1p__*` |
| Heavy lane | `/tmp/diag-319-batch5/heavy-lane-summary.json` |
| R7 汇总 | `/tmp/diag-319-batch5/r7-summary.json` |
| R7 TAP | `/tmp/diag-319-batch5/r7-failure-settlement.tap` |
| test:all | `/tmp/diag-319-batch5/test-all-meta.txt` · `test-all.stdout` · `test-all.stderr` |
| 诊断脚本（非仓内） | `/tmp/diag-319-batch5/run-r9.mjs` · `run-r7.mjs` |

---

## 7. 本批未做（边界）

- 不修改 `HEAVYWEIGHT_MANIFEST` / concurrency（R9 仅诊断）。  
- 不改 `public-cli-failure-settlement.test.ts`（R7 仅诊断）。  
- 未在 GitHub Actions 复测 c=2/c=3。  
- 未测 cold cache 全空时的并行首构 wall（锁语义已知为 wait-not-fail）。
