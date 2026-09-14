# #631 unit 档外部资源名实不符 — 扫描处置账

票庭 run `01a09f5b-b21a-722e-91ff-81dce8631870@countersign` r3 `converged`（sealed `2026-09-14T10:31:00.037Z`）。
缮修大理寺 run `01a09f9b-eb26-7d07-b177-c63fdb7f8f20@judge` continue（处置账逐案 / relative ledgerHome 无副作用 / 无据新测 / 合 main #884）。

## 可重放命令与判据

### 基线扫描（`dadb5318`，本账实测）

```bash
git worktree add /tmp/631-baseline-dadb5318 dadb5318
cd /tmp/631-baseline-dadb5318
# node_modules → 本仓
node --import tsx --import ./scripts/test-process-env-preload.mjs \
  --test --test-reporter=tap \
  test/unit/**/*.test.ts test/contract/**/*.test.ts
```

- **资源命中判据（代码面，去 `//` 行注释）**：`mkdtemp`|`tmpdir(`|`child_process`|`spawn(Sync)?`|`execFile(Sync)?`|`writeFile`|`mkdir`|`rm(Sync)?`|`copyFile`|`chmod`|`symlink`|`from "node:fs"`。
- **耗时判据**：TAP `duration_ms`；`> 100` 为预警项（quality-law「预警参考线」，非硬闸）。
- **suite 墙钟**：TAP footer `duration_ms`（并发，与单案合计不可直接相减）。

本账基线实测：unit+contract **314 pass**；suite 墙钟 **6548 ms**；`duration_ms > 100` → **33 案**（票面 runner 曾报 38；同命令并发计时有方差，本账以 dadb5318 重测 33 案为可复算真源，逐案列下）。

### 最终扫描（本分支 HEAD）

```bash
# 代码面资源命中（去行注释）
python3 - <<'PY'
# 同基线判据扫 test/unit/**/*.test.ts
PY

node --import tsx --import ./scripts/test-process-env-preload.mjs \
  --test --test-reporter=tap test/unit/**/*.test.ts
```

- unit 文件数：26
- 代码面资源命中：**0 文件 / 0 案**（假阳性注释/字符串不算命中）
- `duration_ms > 100`：**0**
- unit suite：84 pass（改纯后案数）

---

## 一、基线资源命中 — 逐案处置

计时口径：上节基线 TAP。资源形态按**该案实际执行**计（同文件纯案不因邻居 FS import 被算命中）。

### 1.1 改纯（路径不透明坐标 / 死 import；案仍留 unit）

| 文件 | 完整案名 | 资源形态 | 基线 ms | 外部行为契约 | ADR/spec | 处置 | 理由 |
|---|---|---|---:|---|---|---|---|
| `test/unit/acp-set-model-provider-model.test.ts` | hermes set_model RPC modelId is seat provider:model | mkdtemp | 5.3 | #644 hermes `session/set_model` 收到 seat `provider:model`；假 ACP | host-descriptions modelPassing；quality-law 小型不碰外部资源 | **改纯** | fake connection 不落盘；`runDirectory` 改不透明字符串 |
| `test/unit/host-retry-verdict-relay.test.ts` | ACP resume delivers opaque retry.message unchanged | mkdtemp | 6.6 | #813 ACP resume 原样投递 `retry.message` | 同左；headless 面已在 integration | **改纯** | 同上 |
| `test/unit/public-cli-option-definitions.test.ts` | table→helpDocument: per-command structured option semantics are equivalent | 死 execFile import（未调用） | 1.2 | #342 option table→help 结构化等价 | option-definitions | **改纯** | 删未用 import；案体本已纯解析。大理寺驳回「scope creep」 |
| 同上 | unconditional required: table required:true is the sole missing-option gate | 死 import | 0.5 | required:true 唯一缺项闸 | 同左 | **改纯** | 同左 |
| 同上 | real parsers: phase from table; repeatable:false rejects; repeatable:true admits | 死 import | 0.8 | phase/repeatable 真 parser | 同左 | **改纯** | 同左 |
| 同上 | rejected spellings: absent from public surfaces; parsers refuse them | 死 import | 0.3 | 拒收拼写双向 | 同左 | **改纯** | 同左 |
| 同上 | analyst structured mode contracts drive parseAnalystArgv (pos/neg matrix) | 死 import | 0.9 | analyst 条件契约矩阵 | 同左 | **改纯** | 同左 |
| 同上 | public dashed options admitted; shared project/attach owner-binding preserved | 死 import | 0.7 | 公开 dashed 选项 + project owner 绑定 | 同左 | **改纯** | 同左 |
| `test/unit/engine-material.test.ts` | assertLegalEngineName rejects only real path hazards; consecutive dots pass | （基线文件含 FS；**本案不触 FS**） | 1.1 | #376 引擎名只拒路径危害 | engine-material / ADR 0069 | **保留 unit 纯** | 本案始终纯语法 |
| 同上 | appendEngineSessionMaterial: engine name line; notes also carry path | （同上） | 0.2 | session 行含 engine 名；有 notes 时带 path | #495 S4 / ADR 0073 不锁呈现头 | **保留 unit 纯** | 本案始终纯；**未**加 engineModel 呈现锁（r2 删回） |
| `test/unit/activation-envelope-module.test.ts` | resolved ledger home rejects relative process home… | withTempRoot+existsSync（基线） | 18.8 | relative home → `AK_ACTIVATION_LEDGER`；**拒绝在任何 FS 副作用前** | ADR 0038；activation-ledger | **拆** | unit 留纯路径/错误码；**无副作用** 真缝 → integration tracer |

### 1.2 移 integration（契约必须观察本机资源 / 子进程）

| 原路径 | 现路径 | 完整案名 | 资源形态 | 基线 ms | 外部行为契约 | ADR/spec | 理由 |
|---|---|---|---|---:|---|---|---|
| `test/unit/gate-submission-candidate.test.ts` | `test/integration/gate-submission-candidate.test.ts` | dossier locator points at whole run directory session, not a preferred leaf (#836) | mkdir/write session | 11.6 | dossier 工具指向整 run session，无 preferred leaf | #836 A7.2 | `createAuditorDossierTool` 实读树 |
| `test/unit/run-terminal-artifacts.test.ts` | `test/integration/…` | parent-dir unique error fallback binds body.runId — sibling runs do not cross-adopt | mkdir/write error json | 27.1 | parent unique error 按 body.runId 绑定，兄弟不串 | T10 run-terminal-artifacts | 实读 artifacts |
| `test/unit/activation-ledger-nofollow-missing.test.ts` | `test/integration/…` | activation ledger append refuses fail-closed when O_NOFOLLOW is unavailable | mkdtemp+hooks+append | 44.4 | 无 O_NOFOLLOW 时 fail-closed，不建 ledger 文件 | activation-ledger TOCTOU | 真 append 缝 |
| `test/unit/collector-handbook.test.ts` | `test/integration/…` | #677 handbook store: write general+repo, second store reads same bytes | mkdir/write/read | 21.4 | handbook 写后读同字节 | #677 | 真 handbook I/O |
| 同上 | 同上 | #677 handbook store: missing session topology fails closed | （路径） | 0.4 | 缺 session 拓扑 fail-closed | #677 | 同左 |
| 同上 | 同上 | #677 handbook root uses platform separators only (literal backslash stays in bookKey on POSIX) | mkdir | 7.9 | POSIX 上 `\` 留在 bookKey | #677 | 同左 |
| 同上 | 同上 | #677 handbook write and read share UTF-8 byte ceiling | write/read | 4.2 | 读写共享 UTF-8 字节顶 | #677 | 同左 |
| 同上 | 同上 | #677 handbook read refuses pre-existing leaf symlink (ADR 0038) | write+symlink+read | 4.1 | 拒预置 leaf symlink | ADR 0038 | 真 symlink 缝 |
| `test/unit/host-pi-runtime.test.ts` | `test/integration/…` | links every host-provided package from the host pi on PATH when local resolution fails | outside mkdtemp+symlink+write | 3.3 | 本地不可解析时从 PATH host pi 链接包 | host-pi-runtime | 真 PATH/node_modules 隔离 |
| 同上 | 同上 | leaves an install with locally resolvable packages untouched | 同上 | 1.3 | 本地可解析则不动 | 同左 | 同左 |
| 同上 | 同上 | fails loud when neither local packages nor a host pi exist | 同上 | 0.5 | 两者皆无则响失败 | 同左 | 同左 |
| 同上 | 同上 | ancestor node_modules under the package tree count as local presence | 同上 | 0.8 | 祖先 node_modules 算本地 | 同左 | 同左 |
| `test/unit/host-session-live-records.test.ts` | `test/integration/host-session-acp-write-fail.test.ts` | ACP host-session write failure aborts pending prompt without waiting for it | chmod 冻目录 | 10.1 | #811 ACP 写失败中止 pending prompt | #811 | 真 FS 权限竞态；改名避与既有 headless 文件撞名 |
| `test/unit/human-format.test.ts` | `test/integration/…` | S2 board projects full-precision machine attrs and human-formatted spans (no raw ms) | mkdir/write ledger | 21.4 | #162 board data-* 全精度；人读 span 非 raw ms | factory-board | `renderFactoryBoardHtml` 读 ledger |
| 同上 | 同上 | S2 board formats zero/edge metric inputs without inventing machine values | mkdir | 5.7 | 零/边界不发明机器值 | 同左 | 同左 |
| `test/unit/package-method-skill.test.ts` | `test/integration/…` | packaged tdd method loads from package root in empty home with upstream identity and current-byte provenance | read package + home | 13.7 | 空 home 从 package root 装 tdd + provenance | method skill | 真 package 树 |
| 同上 | 同上 | provenance without immutable upstream commit is rejected | 写坏 provenance | 13.3 | 无 immutable commit 拒 | 同左 | 同左 |
| 同上 | 同上 | packaged diagnosing-bugs loads adapted boundary method without external skill-chain handoff | read | 1.9 | diagnosing-bugs 无外部 skill 链 | 同左 | 同左 |
| 同上 | 同上 | packaged tdd binding captures expansion against package skill path only | read | 2.7 | tdd binding 只对 package skill 路径 | 同左 | 同左 |
| 同上 | 同上 | packaged code-review loads adapted two-axis method without Matt setup | read | 2.1 | code-review 两轴、无 Matt setup | 同左 | 同左 |
| 同上 | 同上 | packaged code-review binding captures expansion against package skill path only | read | 2.3 | 同 binding | 同左 | 同左 |
| 同上 | 同上 | packaged resolving-merge-conflicts loads merge-only method that escalates new authority | read | 1.9 | merge-only，新权威上呈 | 同左 | 同左 |
| `test/unit/ticket-trajectory-binding.test.ts` | `test/integration/…` | flat run with typed invocation ticketNumber is included for that ticket | mkdir/write runs | 7.3 | 带 ticketNumber 的 flat run 入票视图 | ticket-trajectory | 真 book 树 |
| 同上 | 同上 | flat run without ticketNumber is isolated unbound (not joined, not board-wide error) | 同上 | 3.5 | 无 ticketNumber → unbound 隔离 | 同左 | 同左 |
| 同上 | 同上 | legacy issues/\<n\>/runs is still included | 同上 | 2.7 | legacy issues/n/runs 仍收录 | 同左 | 同左 |
| 同上 | 同上 | unrelated unbound flat runs stay isolated from every ticket view | 同上 | 12.9 | 无关 unbound 不进任何票 | 同左 | 同左 |
| 同上 | 同上 | book index is reusable across tickets without re-scanning semantics | 同上 | 5.8 | book index 跨票可复用 | 同左 | 同左 |
| 同上 | 同上 | bare runId lookup is loud when the same id exists under multiple leaves | 同上 | 3.7 | 多叶同 id 响失败 | 同左 | 同左 |
| 同上 | 同上 | migration-derived ticket page places a run into the ticket view without board pages | 同上 | 4.6 | 迁移票页不经 board 放入 | 同左 | 同左 |
| 同上 | 同上 | subject-tree ticket runs are indexed (not only flat legacy runs) | 同上 | 3.0 | subject-tree runs 入索引 | 同左 | 同左 |
| `test/unit/test-process-env.test.ts` | `test/integration/…` | isolatedTestProcessEnv: options.home wins over default and env.HOME | withTempRoot | 3.9 | #549 options.home 优先 | test-process-env | 测试基建；中型 |
| 同上 | 同上 | isolatedTestProcessEnv: default home is removed when owning process exits | spawnSync+mkdtemp | 36.3 | #612 默认 home 随进程删 | #612/#685 | 真进程生命周期 |
| 同上 | 同上 | isolatedTestProcessEnv: explicit options.home is not deleted on process exit | spawnSync | 37.6 | 显式 home 不随进程删 | 同左 | 同左 |
| `test/unit/test-user-profile-preload.test.ts` | `test/integration/…` | parent process packageMachineHome still follows real user profile | （读 os） | 0.5 | 父进程仍跟真实 profile | #604 | 测试基建 |
| 同上 | 同上 | withTestUserProfileEnv child: package home = temp; realMachineHome stays operator | mkdtemp+subprocess | 95.6 | 子进程 package home=temp；real 仍操作者 | #604 | 真 `--require` 子进程 |
| 同上 | 同上 | unavailable mode: userInfo / packageMachineHome throw ERR_SYSTEM_ERROR | subprocess | 72.4 | unavailable → ERR_SYSTEM_ERROR | #604 | 同左 |
| `test/unit/engine-material.test.ts`（拆出） | `test/integration/engine-material.test.ts` | #883 engineSessionMaterialFromOptions: engineModel is optional opaque coordinate | mkdir/write notes | 10.0 | engineModel 可选 opaque；有 notes 时带 path | #883 engine-material | 真 existsSync/发现 |
| 同上 | 同上 | packaged notes directory is discovery-only; missing notes is not an error | mkdir/write/readdir | 5.0 | 发现 only；缺 notes 不抛 | #376 | 真 readdir |

### 1.3 同文件纯案（基线文件命中、本案不触外部资源 → 留 unit）

`activation-envelope-module.test.ts` 下列案基线与文件共处但只做内存/注入 writeSync mock，**不** mkdtemp/真实目录写：

| 完整案名 | 基线 ms | 契约 | 处置 |
|---|---:|---|---|
| accepted-activation fact is closed at the typed API and omits injected content keys | 3.3 | fact 构造闭包，剔除注入 content 键 | **保留 unit** |
| dispatch stub fact is closed at the typed API and omits injected content keys | 0.1 | dispatch stub 同左 | **保留 unit** |
| normal dispatch + accepted activation reconciles as matched | 0.1 | reconcile matched | **保留 unit** |
| activation without a matching dispatch stub is activation-without-dispatch | 0.1 | 无 stub → activation-without-dispatch | **保留 unit** |
| default trace and tool observation writers retry short writes and reject schema-invalid records | 1.6 | 短写重试；非法 schema 拒（注入 writeSync） | **保留 unit** |
| tool-execution observation contract retains reader-required events and output-driven updates | 0.4 | observation 事件/心跳契约 | **保留 unit** |
| observation face emits start/end always, throttles producing updates per toolCallId, and ignores non-admitted sessions | 3.5 | face 节流与 admitted | **保留 unit** |
| observation face rejects throttleMs override at the typed call site and ignores it at runtime | 0.6 | 无 throttleMs 覆盖 | **保留 unit** |
| tool observation writer failure does not fake success on the face | 0.6 | write 失败不上报成功 | **保留 unit** |
| production observation mono clock is monotonic and not wall-clock Date.now | 0.1 | mono 钟 | **保留 unit** |

### 1.4 扫描假阳性（注释或路径字符串；非资源命中；非残余）

| 文件 | 说明 | 处置 |
|---|---|---|
| `test/unit/collector-github-parse.test.ts` | 注释写「真 spawn 留 integration」；代码纯 normalize | **保留**；不入命中、不入残余 |
| `test/unit/user-dialogue-stdin.test.ts` | 仅 `/tmp/...` 路径字符串；#879 纯编解码 | **保留**；不入命中、不入残余 |
| `test/unit/submission-status-open-domain.test.ts` | 纯 TypeBox 开域；基线代码面无命中 | **保留** |

---

## 二、基线 `duration_ms > 100` 全表（33 案专项审视）

命令/口径见上。票面曾报 38；本账 dadb5318 重测 33。全部入账；**不因超线判违例**。

| ms | 完整案名 | 所在档（基线） | 专项审视 | 与本票处置关系 |
|---:|---|---|---|---|
| 1073.9 | legal existing-version moves latest dist-tag only | contract/package 类 | 真 npm dist-tag；中型/大型本色 | **非 unit 资源类**；超线因真 I/O，保留在原档 |
| 966.6 | latest channel publishes monotonic version without shortsha suffix | 同上 | 真 publish 语义 | 同上 |
| 895.6 | resolveAnalystBookKey: dubious-ownership exit 128 stays loud with its real cause, never a root: key (#413 r2 U5) | contract/analyst | 真 git exit 128 | 同上 |
| 849.2 | analyst gate-cycles via runAnalyst: damaged auditor volume → unreadable leg | contract | 真 volume 读 | 同上 |
| 760.8 | analyst gate-cycles via runAnalyst: current English faces + rejected/no-result terminals | contract | 多 round fixture | 同上 |
| 760.3 | malicious CHANNEL is data to real npm and fails Invalid version without shell execution | contract/package | 真 npm 拒 | 同上 |
| 496.5 | analyst gate-cycles via runAnalyst: historical 7-round + zero-round siblings | contract | 历史 fixture | 同上 |
| 462.3 | analyst gate-cycles via runAnalyst: accepted-then-rejected same volume keeps accepted | contract | volume 语义 | 同上 |
| 451.8 | analyst gate-cycles via runAnalyst cohort: merges byOfficer from ensured pages | contract | cohort 合并 | 同上 |
| 407.5 | analyst B2 via runAnalyst: PRD five-frame + overlap fixture hand-equal (union/complement/median/bash first line) | contract | B2 计算 | 同上 |
| 399.5 | analyst gate-cycles via runAnalyst: accepted non-dispatch Gatekeeper status is omitted not unreadable (#836/#622) | contract | Gatekeeper 投影 | 同上 |
| 399.3 | every packaged role records original payload through the production ledger host (#836) | contract | 真 ledger host | 同上 |
| 399.3 | analyst gate-cycles via runAnalyst: rejected volume missing timestamps is omitted | contract | volume 省略 | 同上 |
| 362.9 | analyst gate-cycles via runAnalyst: continuous volume multi-binding keeps per-summons wall | contract | multi-binding | 同上 |
| 287.2 | station-child shared lifecycle omits Navigator attendance; top-level still creates it | contract | 真 lifecycle | 同上 |
| 234.8 | coder apply unfinished without reason bounces then accepts reasoned resubmit; max two bounces then accept | contract | 真 bounce 环 | 同上 |
| 223.9 | undeclared prerequisite ids are recorded as-is; declared references still pass Gatekeeper | contract | prerequisite 记录 | 同上 |
| 204.0 | production lifecycle regenerates within refresh boundary and stops | contract | lifecycle 再生 | 同上 |
| 176.4 | Fixer activation rejects malformed prerequisites and blank instructions before installing its tool | contract | activation 拒 | 同上 |
| 174.3 | public CLI audit-incomplete keeps gate read damage off the publication-failure label | contract | CLI 投影 | 同上 |
| 173.2 | public CLI resumable failure projects gate without re-disclosing runId outside resume | contract | CLI resume 投影 | 同上 |
| 159.8 | public CLI projects normal gate dispatch + officer findings | contract | CLI gate | 同上 |
| 144.8 | public CLI does not wash damaged auditor-roles into no-gate | contract | 损坏不洗白 | 同上 |
| 139.7 | fixer role loads opaque instructions and returns a thin report envelope | contract | fixer 装载 | 同上 |
| 136.0 | public CLI keeps accepted Terminal when auditor-roles holds lawful province pass | contract | Terminal 投影 | 同上 |
| 132.8 | page lifecycle writes only outside the ledger; hard link cannot smuggle bytes back | contract | page 写界 | 同上 |
| 130.0 | #412 public entry tracer: bare N hits cwd book (legacy row); book:N other book; wrong book absent | contract | 票入口 | 同上 |
| 129.6 | public CLI failure path keeps damaged auditor-roles loud (not silent no-gate) | contract | 失败响 | 同上 |
| 124.4 | public CLI failure Terminal still projects accepted gate facts | contract | failure Terminal | 同上 |
| 119.8 | public CLI omits gate when no auditor-roles gate ran | contract | 无 gate 省略 | 同上 |
| 117.8 | declared plan refusal passes structure then Gatekeeper | contract | plan 拒 | 同上 |
| 111.4 | coder plan loads its task without construction skill and returns planned | contract | plan 装载 | 同上 |
| 108.0 | public CLI no_receipt Terminal projects accepted gate facts | contract | no_receipt 投影 | 同上 |

**结论**：本重测 33 个超线案**全部在 contract（及 package 真 I/O）档**，无一落在基线 `test/unit` 资源命中案集合内（unit 命中案最慢 95.6 ms 的 preload 子进程案，未过 100）。故超线专项审视：**不构成本票 unit 名实类的淘汰依据**；unit 资源类按名实移/改后，最终 unit 全量 **0** 案 >100ms。未因超线放松断言或删除必要失败路径。

---

## 三、最终树对账

### 3.1 基线命中 → 最终去向

| 基线命中来源 | 最终 |
|---|---|
| 全部 §1.2 移档案 | 已不在 `test/unit/`；在 `test/integration/` 仍在，名实中型 |
| §1.1 改纯案 | 仍在 unit，代码面无 mkdtemp/写/spawn |
| engine-material FS 两案 | `test/integration/engine-material.test.ts` |
| relative ledgerHome 无副作用 | unit 只留错误码；integration `activation-envelope-contract` 新增 tracer 断言自有 temp 下目标未创建 |
| public-cli 死 import | 已删；案行为不变 |

### 3.2 最终 unit 残余资源扫描

判据同基线代码面。结果：**0 命中文件、0 命中案**。

**保留账**（非资源命中，勿作残余）：

- `collector-github-parse.test.ts` — 注释假阳性
- `user-dialogue-stdin.test.ts` — 路径字符串
- `submission-status-open-domain.test.ts` — 从未命中
- `activation-envelope-module` / `engine-material` 纯案 — §1.3 / §1.1

**无「保留为 unit 但仍碰外部资源」项。**

### 3.3 本票未新增机制

- 无新 harness/夹具/分档框架
- 仅 git mv、删死 import、路径字符串、既有 integration 目录承接
- `host-session-acp-write-fail.test.ts` 仅为避文件名碰撞
- r2：删除曾新增的 `assertLegalEngineModel`/`pickEngineAxis` helper 案与 `engineModel` 呈现字符串锁

### 3.4 分支整合

- `git merge origin/main`（d1d69063）：带入 #884 `checkout@v7` / `setup-node@v7` / `pnpm/action-setup@v6`（ci.yml + publish-registry.yml 六处），无改 #631 设计

---

## 四、验证（本轮聚焦，非全量）

- unit：`node … --test test/unit/**/*.test.ts` → pass；>100ms = 0；代码面资源 0
- integration 触及：activation-envelope-contract（含 relative tracer）、engine-material、移档文件 → pass
- workflow：`rg 'checkout@v7|setup-node@v7|pnpm/action-setup@v6' .github/workflows` 六处在
