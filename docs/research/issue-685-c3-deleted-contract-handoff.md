# #685 C3 删案承接表（owner 2026-09-06 r13；r10 证据边界收窄）

口径（owner 御批选项 1）：

- **不再点火**真宿主 / 冷装 / 聚合脚本；不为证明修复换形再造测试。
- 承接只用**既有真实卷宗**或**留存 CI 确定性 call-input 案**逐案指认：具名 `runId` + **绝对路径**（或留存测试路径）；该证据必须确实证明该原行为。
- **真实卷存在 ≠ 原契约已证**。健康 terminal / public-cli 入口旁证**单列**，不得吞掉专用未结项。
- 证不了的明确标 **未结**。诚实未结不是缺陷；用旁证或同名 Error 冒充原观察才是。
- **自拟聚合摘要不算 run**（含 `runs/01a072fc-685-c3-agg-*@fixer/aggregation-dossier.json` 及其 checks）。
- 七处伪 run 目录原地保全，本表不引用、不删除。
- 因**盯文 / 呈现锁 / 失效行为**合法删除的断言：写法源与处置，不为其造证明。

前缀 `BOOK` = `/Users/akagilnc/.ak-roles/books/ak-pi-workflow-roles/runs`  
范围：`git diff --name-only d9801a3c...8c2f309f` 中全部删除测试文件 + 修改文件中删除的行为（只读原断言反查，不恢复宿主测试、不写 src）。

---

## A. Collector 公开入口与 #641

原文件：`test/integration/collector-real-entry.test.ts`、`test/integration/public-cli-collector-run.test.ts`；包生命周期见 H。

| 原案（行为） | 必要性 | 同根 | 处置 | 精确承接 | 结态 |
| --- | --- | --- | --- | --- | --- |
| Collector 公开入口 settle / observe-only 无 request manifest 成功 | 真宿主 | 生产 collector | 删 | runId `01a07280-5ba5-7554-b8a3-2ab8294ce0d9`；`BOOK/01a07280-5ba5-7554-b8a3-2ab8294ce0d9@collector`：`entryMode=public-cli`，`rolePackageRoot`→`~/.pi/agent/npm/…/pi-workflow-roles`，`state=terminal`，`artifacts/report.json` 在盘 | **健康 settle 旁证已结** |
| optional request 执行后**重观测**入 receipt（collector-real-entry + public-cli-collector-run 同根） | 真宿主 | 上列 | 删 | 上列健康卷仅证入口+terminal，**无** request→re-observe 专用观察 | **未结** |
| wait 遵守真实 eligibility cutoff | 真宿主 | — | 删 | 无 cutoff 专用卷 | **未结** |
| failed reactivation 清除先前成功激活 | **非真宿主**：原 `collector-real-entry.test.ts:147–155` 手构 fake `pi` + `createFakeGitHubTransport`，直接 `activate`/`tool.execute`，**无**真 Pi / `withInProcessPi` 启动。断言含 `/requires --ak-collector-repo/`、`/通进司未激活/` **错误文案正则** | — | 文案断言 → **合法删**（quality-law 盯生成物禁止；锚定宪法不咬呈现）；清除既存激活之**行为**无对等 call-input/生产卷 → 不恢复、不造测 | 不以文件名 `*-real-entry*` 推定真宿主。文案锁与清激活行为分列 | 文案 **合法删**；清激活行为 **未结** |
| #641 chain① 全文指针可开、receipt 不落原文；未知/不可开指针 correctable bounce 后 retry seal；zero-finding attendance-only；不可解 finding 不污染后续合法提交 | 真宿主 | #641 | 删 | 无 #641 指针/纠错专用生产卷 | **未结** |
| #641 chain② 误报 infrastructureFailure bounce；unassemblable receipt 走共享 host failure | 真宿主 | #641 | 删 | 无 | **未结** |
| #641 P2 read tool 真失败写入 typed host fact 供 settlement 分类 | 真宿主 | #641 | 删 | 无 | **未结** |
| activation **恢复**非空 session dossier 后再 resume observe/output | 真宿主 | resume | 删 | 健康 terminal **不**证 restore-before-resume | **未结** |
| output candidate **同轮禁止** request（GitHub POST 前拦截） | 真宿主 | — | 删 | 无 | **未结** |
| public Collector **HTTP 404** → typed activation failure + Error Artifact | 真宿主失败面 | ADR 0019 | 删 | 无 404 activation 专用卷（既有 collector error 卷为 identity drift / 402 等，**不是** HTTP 404 activation） | **未结** |

---

## B. Gatekeeper 直召官

原文件：`test/integration/gatekeeper-real-entry.test.ts`。

| 原案（行为） | 必要性 | 同根 | 处置 | 精确承接 | 结态 |
| --- | --- | --- | --- | --- | --- |
| worker 完成**直接召** Inspector（无 Gatekeeper child）；dossier tool 在、subject body tool 不在 | 真宿主/直召关系 | 生产 gate 接缝 | 删 | 独立 `@inspector` 健康入口 **不是**「worker 完成后直召」关系证明。留存 call-input：`test/contract/judge-role.test.ts`「coder completed submissions traverse the direct Inspector gate until pass」等（进程内 gate 投影，非原 real-entry 子进程） | 直召关系 **未结**；进程内 gate 投影由留存案另担 |
| judge draft **直接召** Notary 且 **preserve bounce** | 真宿主 | 同上 | 删 | 独立 `BOOK/01a0628a-c182-7887-98a7-085af456ac63@notary` 只证 Notary 公开健康入口，**不**证 draft→Notary 直召或 bounce 保留 | **未结** |
| direct officer **escalate**（reason + findings typed） | 真宿主 | 同上 | 删 | 无 escalate 专用卷 | **未结** |
| countersign verdict 直接召 Notary | 真宿主 | 同上 | 删 | 同上，独立 notary 健康卷不够 | **未结** |
| direct officer **无回执** → loud typed `no_receipt` | 真宿主失败面 | 同上 | 删 | 留存：`test/integration/public-cli-notary.test.ts`「layer ③ no_receipt…」为共享 lifecycle 投影，**不是** gatekeeper-real-entry 直召无回执 | 直召无回执 **未结** |
| missing arguments → one-shot serializable **transport_failure**；transport failure **点名被召 seat** | 真宿主失败面 | 同上 | 删 | 无 | **未结** |
| `runGatekeeper` **持久化** in-memory tool-call leaf，dossier 解析 candidate body | 真宿主+持久叶子 | 同上 | 删 | 无 leaf 持久专用卷 | **未结** |
| （旁证，非上列专用契约）Inspector/Notary 公开入口可 terminal | 真宿主 | 生产官席 | — | Inspector：`BOOK/01a07237-8bab-7606-ab2f-ea2f181fbfe7@inspector`（public-cli，terminal；注意该卷 `rolePackageRoot` 为 worktree trial 根，非 npm 安装根）。Notary：`BOOK/01a0628a-c182-7887-98a7-085af456ac63@notary` | **健康入口旁证已结**；**不得**合并结清上列直召/bounce/escalate/无回执/transport/叶子 |

---

## C. Fixer 双 method 装载 / Merger session B / worker gates 耐久

| 原案（行为） | 原文件 | 必要性 | 处置 | 精确承接 | 结态 |
| --- | --- | --- | --- | --- | --- |
| Fixer production activation args 到达真实 Pi loader：**initial-apply** 与 **resume-apply** 两种 optional method 均装入 `diagnosing-bugs` + `tdd` skill（user 首条无 skill 标签） | `fixer-pi-loader-methods.test.ts` | 真宿主 method 装载 | 删 | `BOOK/01a07240-fc0d-7ef3-8bd5-7fb38f346220@fixer` 只证 public-cli + terminal + accepted completed，**不**证 initial/resume 两种 method 装载轨迹 | 健康 settle **旁证已结**；**双 method 装载未结** |
| production extension 观察 **session repository B**，非 ambient repository A（激活到 completion） | `merger-role.test.ts`（删案） | 真宿主 cwd 隔离 | 删 | merger 健康卷 `BOOK/01a06fa5-aaf0-7b19-a67f-7c86c3e09530@merger`、`BOOK/01a06bde-2e3e-7f92-85a8-369fef08fd41@merger` 不区分 session B vs ambient A。留存：`merger-role.test.ts` 其余案为 host-neutral / Git state call-input，**不含**原 session-B 宿主案 | session B≠A **未结**；健康 merger **旁证已结** |
| ①② durability：真实 `createRecordSession` **resume 后不再 false bounce** | `worker-submission-gates.test.ts`（删案） | 真宿主 recordSession | 删 | fixer 健康卷 session+artifacts 在盘只是耐久旁证。留存 gate arm（reason/zero-commit/prefix/uninstall）**不含** resume 后二次 bounce 否定 | resume 无二次 false bounce **未结**；非宿主 gate arm **已结**（留存 CI） |

---

## D. Judge / Reviewer engine-detour（ADR 0071）

| 原案（行为） | 原文件 | 必要性 | 处置 | 精确承接 | 结态 |
| --- | --- | --- | --- | --- | --- |
| AC1 **成功**：PATH fake engine → detour → typed judge receipt（两 detour toolCall/Result，stdout/stderr 分流，judge output+closure） | `public-cli-judge-engine-detour.test.ts` | 真宿主成功劳务 | 删 | 生产 judge 健康/裁决卷（如 `BOOK/01a07246-0999-7ec9-a422-fb06dad57d18@judge` continue、`BOOK/01a0726d-5d67-713f-956e-81c201907e59@judge` escalate）**无** detour 成功双调用观察 | **成功劳务返回未结** |
| engine **非零退出**真错误卷：公开入口停 run、无 accepted Receipt（`EngineDetourInfrastructureError`，`details.exitCode=1`） | 同上 | 真宿主失败面 | 删 | `BOOK/01a00dd4-679c-7031-8553-c2a41a871e07@judge`：`artifacts/error.json` diagnostic=`engine detour exited with code 1`，`exitCode=1`，`state=terminal`，无 accepted report。同形：`…/01a00dd4-b672-752d-8ae3-9bad6c713842@judge`、`…/01a00dd5-5e7a-7b82-9b09-2fc81daecfd5@judge` | **仅** exitCode=1 非零退出真错误卷窄观察 **已结**；**不得**覆盖下列未证分支 |
| 同失败表 **empty-output**：fake engine `exit 0` + 空白/空白类 stdout，公开终局 failure | 同上 | 真宿主失败面 | 删 | 具名 judge error 卷只证 `exitCode=1`，**无** empty-output（exit 0 空白）卷。留存 `engine-detour-cancel-idle.test.ts` 只含 abort / spawn miss / silent idle，**不**承接空输出 | **未结** |
| 同失败表 **exit 23 + engine cause 贯穿**公开终局（diagnostic 含 engine stderr cause） | 同上 | 真宿主失败面 | 删 | 具名卷 `exitCode=1` 且 diagnostic 为 exited-with-code 模板，**无** exit 23、**无** cause 字符串贯穿公开终局。`engine-detour-cancel-idle` spawn/abort seam **不**证该公开 cause 贯穿 | **未结** |
| AC4 **治理**：无 engine → 无 detour tool；默认 typed path 仍 accepts | 同上 | 真宿主治理分支 | 删 | `test/integration/public-cli-engine-axis.test.ts`「ambient AK_ROLE_ENGINE does not activate detour…」等为配置/信号 call-input，**不是**原「无 engine 整跑仍 accepts 且 session 无 detour」宿主观察 | **治理分支未结** |
| reviewer：evidence legs 内 **engine 进程失败**，原 **cause 贯穿**公开终局（exit≠0，diagnostic 含 engineCause） | `public-cli-reviewer-engine-detour.test.ts` | 真宿主失败面 | 删 | `BOOK/01a067dd-924f-74a1-9d56-e068df06be4d@reviewer`：`EngineDetourInfrastructureError`，diagnostic=「**本激活内劳务引擎已使用**」，`details.exitCode=0`——与原案「进程失败 + cause 贯穿 + 非 0」**不是同一观察**，**不得**作该失败案已结证明。同 identity 其他 reviewer error 卷同形时亦然 | **未结** |
| reviewer AC with-notes：cursor engine → leg detour → typed reviewer receipt | 同上 | 真宿主成功劳务 | 删 | 健康 reviewer `BOOK/01a07244-6de6-7cda-856d-8de0cecb3a13@reviewer` 不证 leg detour 成功路径 | **未结** |

---

## E. 公开 CLI Judge/Coder 真跑与 failure-evidence

原文件：`public-cli-judge-run.test.ts`、`public-cli-coder-installed-run.test.ts`。

| 原案（行为） | 必要性 | 处置 | 精确承接 | 结态 |
| --- | --- | --- | --- | --- |
| Judge 公开入口达 gate 并 registry command settle Terminal | 真宿主 | 删 | `BOOK/01a07246-0999-7ec9-a422-fb06dad57d18@judge`（continue）、`BOOK/01a0726d-5d67-713f-956e-81c201907e59@judge`（escalate）：public-cli + npm 安装根 + terminal | 健康/裁决路径 **已结** |
| public Coder **rejected / never-called abandonment → typed no-receipt** | 真宿主失败面 | 删 | 无该 no-receipt 形态专用卷 | **未结** |
| public Coder **aborted stop** → infrastructure nonzero、无 receipt delivery | 真宿主失败面 | 删 | 无 | **未结** |
| Judge retained **unreadable compliance** 走 failure channel | 真宿主失败面 | 删 | 无 | **未结** |
| Judge public **failure-evidence tracer**（同根三 scenario：`missing-dossier` / `missing-subject` / `notary-no-pass`） | 真宿主失败面 | 删 | 无逐 scenario 专用卷；不得用健康 judge 冒充。三身份同根一行，不复制矩阵 | **未结**（`missing-dossier` / `missing-subject` / `notary-no-pass` 均未结） |
| cold-installed coder：**provider-stop then resume** → accepted terminal | 真宿主+冷装 | 删 | 健康 coder `BOOK/01a07257-43a1-7f09-ac08-d0d7d67ca20a@coder`、`BOOK/01a07222-0cb7-72f1-b1ae-6ded5aa3cf89@coder` 只证已装入口 completed | 健康已装入口 **旁证已结**；provider-stop/resume **未结** |

---

## F. packaged-workers 与跨进程 dossier

原文件：`package-entrypoint-packaged-workers.integration.test.ts`；跨进程案在 `judge-auditor-fixture-tracer.test.ts`（**归属纠正**：不是 packaged-workers 文件内的案）。

| 原案（行为） | 原文件归属 | 必要性 | 处置 | 精确承接 | 结态 |
| --- | --- | --- | --- | --- | --- |
| cold-installed 从 **editable Souls** 审计 active auditor seats | packaged-workers | 真宿主+冷装 | 删 | 健康 worker 卷不证 editable Souls 审计 | **未结** |
| packaged judge 跨 Pi **loader / schema / persisted batch / auth-resolved audit / termination** offline | packaged-workers | 真宿主边界 | 删 | 不得概括为「健康 worker」 | **未结** |
| packaged judge escalation → 一条 typed human decision | packaged-workers | 真宿主 | 删 | 生产 escalate 卷（上列 judge）非原 offline packaged 边界矩阵 | **未结**（与 E 健康 escalate 旁证分列） |
| packaged coder apply：**canonical native tdd expansion + colliding prefix** | packaged-workers | 真宿主 | 删 | 留存：`test/contract/judge-role.test.ts`「coder apply binds completion to the immediately following canonical tdd expansion」为 call-input，**不含** colliding prefix 冷装宿主 | colliding prefix 宿主 **未结** |
| packaged fixer：**both-phase bash seatbelt** + tool surface 保留 + **singleton output** | packaged-workers | 真宿主 | 删 | 健康 fixer 旁证不证 seatbelt/singleton 矩阵 | **未结** |
| **两独立 packaged Pi 进程** dossier 不串（trace 互不含对方 runDirectory；installedRoot 不同） | **`judge-auditor-fixture-tracer.test.ts`** | 真宿主+隔离 | 删 | 留存：`test/unit/dossier-resolution.test.ts`「concurrent pointers keep two runs from crossing dossiers」= **顺序环境指针**隔离，**不是**双 packaged 进程。生产两 run 目录并存可观察，同非原案 | 指针隔离 **已结**（留存案）；**原 packaged 双进程隔离未结** |

---

## G. public-cli merger / failure-provider-stop 删案

| 原案（行为） | 原文件 | 必要性 | 处置 | 精确承接 | 结态 |
| --- | --- | --- | --- | --- | --- |
| public Merger **residual failure precedence** 落共享表 | `public-cli-merger-run.test.ts`（删） | 真宿主失败优先级 | 删 | 留存 merger-run 为 sealed→Terminal / non-sole / post-seal 共享入口，**不含** residual failure precedence 宿主表 | **未结** |
| public Merger clean completed merge 共享表 | 同上 | 真宿主 | 删 | 健康 merger 卷旁证入口；非原「共享表 clean merge」专用矩阵 | 健康旁证 **已结**；共享表 clean merge 专用 **未结** |
| Pi real-entry singleton table **rejects non-sole-final** | 同上 | 真宿主 | 删 | 留存：`host-neutral typed turns reject non-sole output…` 为进程内，非 Pi real-entry singleton 表 | real-entry non-sole-final **未结** |
| #307 navigator institutional：durable archivist session + **typed 503** observation | `public-cli-failure-provider-stop.test.ts`（删） | 真宿主 | 删 | 留存同文件其余 #307（aborted raw / SDK payload / 2xx clear / ENOENT / non-absence）仍在；**本条 503+archivist 已删且无对等生产卷** | **未结**（具名；不得用「#307 异常面仍在」总称掩盖） |

---

## H. 安装 / 冷装 / 包生命周期 / observation / idle

| 原案（行为） | 原文件 | 处置 | 精确承接 | 结态 |
| --- | --- | --- | --- | --- |
| 隔离 Pi home **install** packed artifact + private npm bin 发现 ak-role | `public-cli-install.test.ts` | 删 | 多角色 `rolePackageRoot` 落在 `~/.pi/agent/npm/…` 只证**已装可加载**。留存：`npm-identity-metadata.test.ts` pack 清单 / optional peer **元数据**声明 | 已装加载面 **旁证已结**；**install 过程/隔离 home/private bin 未结** |
| ordinary **npm install** 后 `HOST_PEERS` 路径 **ENOENT**（peers 仍由 Pi host 供给、不落 consumer `node_modules`） | `npm-identity-metadata.test.ts:327–362`（删行为） | 删 | 留存同文件仅 **optional/* peer 元数据** call-input，**不是** ordinary install 后路径 ENOENT，也**不是** Pi 私有 bin 安装 | **未结**（专用；与 optional peer 元数据、private bin install 分列） |
| cold-installed **live help** 随 extension 重读变化 | `package-entrypoint-cold-help.integration.test.ts` | 删 | 无 `ak-role … --help` 生产归档 | **未结** |
| 一次冷装练完 public roles + Navigator gates；documented update 刷新 | `public-cli-cold-matrix.test.ts` | 删 | 无版本矩阵真跑卷 | **未结** |
| shared cold install 嵌套未跟踪字节变化时重建 | `shared-cold-install-construction.test.ts` | 删 | 无 | **未结** |
| Doctor：fresh Pi 加载已装 extension 并 **完成一次 audited output**（soul/audit/closure/ledger） | `doctor-package-lifecycle.test.ts` | 删 | `BOOK/01a06625-5bfd-738f-8214-d402cb84a5f1@doctor`（public-cli，terminal，status=refused）只证入口+拒绝 settle | 入口/拒绝 **部分旁证**；audited 完成轨迹 **未结** |
| Collector 冷装默认 **gh transport** 出 receipt | `collector-package-lifecycle.test.ts` | 删 | 健康 collector 不证 gh transport 冷装矩阵 | lifecycle/gh **未结** |
| Reviewer 已装 tarball：**Reviewer→Judge 链** + frozen report/evidence | `reviewer-package-lifecycle.test.ts` | 删 | 健康 reviewer/judge 分卷并存 ≠ 原冷装链式案 | 链专用 **未结** |
| tool-execution observation：stderr JSONL、永不打 Navigator prepare；无 `--ak-role` 则零记录 | `package-entrypoint-observation.integration.test.ts` | 删 | 无 | **未结** |
| package-owned tool idle **已移除**（silent tool 越过原 183s backstop 仍 pending） | `package-tool-idle-removed.test.ts` | 删 | 留存：`engine-detour-cancel-idle.test.ts`「silent detour child is not cut by package-owned tool idle backstop」= detour 路径 call-input，**部分**旁证移除 | package-owned idle 移除（detour 路径）**部分已结**；原 183s **角色注册**宿主时序 **未结** |
| compliance **stream idle** 有限重试，耗尽后 typed tool `isError`（`StreamIdleTimeoutError`；非 package-owned idle） | `package-tool-idle-removed.test.ts:190–320`（删行为） | 删 | 留存 detour cancel-idle **不**含 compliance child stream 重试/耗尽。`stream-idle-guard` unit 只锁默认 183s 常数与 guard 本身，**不是** compliance 耗尽→judge tool isError | **未结**（专用；与 package-owned idle 移除分列） |

---

## I. Navigator / OAuth / activation 宿主删案

| 原案（行为） | 原文件 | 处置 | 精确承接 | 结态 |
| --- | --- | --- | --- | --- |
| ordinary attendance 时序；print/JSON 独立呈现；一 prepare 跨 recommendation/silent；pre-output failure 后仍健康 prepare；cause matrix typed+Receipt；cross-role continuity；authority 外 input；fresh process resume route memory | `package-entrypoint-navigator.integration.test.ts`（多案） | 删 | **无**具名 `@navigator` run 目录。生产腿内嵌 Navigator 不可反查为上列专用矩阵 | **逐案未结**（不得用「Navigator 异常面/矩阵」总称已结） |
| exact-session resume 保 principal；terminal 开下一 invocation；非 UUIDv7 拒；durable terminal 分类；mid-turn prepare；prompt failure rethrow；institutional close；dispose close rejection | `navigator-lifecycle-real-session.test.ts` | 删 | 同上 | **未结** |
| host-neutral native factory：opens / thinking / HTTP classify / institutional seat 优先 | `navigator-attendance*.test.ts`（删行为） | 删 | 留存 routes/attendance 为 call-input；注释已标 C3 未结 | **未结** |
| #351 e2e ≥2 expiry refresh；non-target provider 过滤；**shutdown** 后零 tick；**unexpired** 零网络；production setting seam 驱动 filter | `oauth-keepalive.test.ts`（删行为） | 删 | 留存：single-flight / error warning / dual surface / notify fallback / 部分 setting——**不含** e2e 双窗、shutdown、unexpired、production setting 宿主刷新 | 上列删行为 **未结**；留存 route/cause 身份 **已结** |
| 注册 inventory（terminating/support tools provider-open）；每角色一条 accepted-activation；unselected/unsupported 零事实；whole-activation rejection 非 0+named cause 先于 model；**O_APPEND 8+8** 与 **16-worker mkdir race**；malformed Fixer 前置真实子进程失败；observation writer 经 ExtensionRunner 原 cause abort；Reviewer skill expansion envelope | `activation-envelope-contract.test.ts`（删行为） | 删 | 留存：book key / git spawn identity / **symlink escape 四向量**。健康激活旁证：`BOOK/01a07246-0999-7ec9-a422-fb06dad57d18@judge` | 健康旁证与 symlink **已结**；inventory/admission 计数/拒绝矩阵/race/malformed 子进程/observation emit/Reviewer expansion 宿主 **未结** |
| gleaner-left 真链 seal 空弹章 / pointer+statement | `gleaner-left-real-entry.test.ts` | 删 | `BOOK/01a06fa4-2f99-7df8-92c8-f70c1f24061b@gleaner-left` public-cli terminal | 健康入口 **旁证已结**；弹章字段专用 **未结** |
| reviewer activation rejection → books 内 violation+diagnostic | `reviewer-activation-rejection-books.test.ts` | 删 | 健康 reviewer 只证健康路径 | 拒绝面 **未结** |
| coder missing skill-expansion → 真宿主 session typed non-pass | `judge-role.test.ts`（删） | 删 | 无 | **未结** |
| audit-failure-subprocess：fatal Judge audit abort print/JSON；no-receipt audit + Navigator drain；coder 无 skill expansion non-receipt；Reviewer fatal stages 无 receipt | `audit-failure-subprocess.test.ts` | 删 | 见下节 no-call 收窄；健康 judge **不**承接 | 原 subprocess 失败矩阵 **未结** |

---

## J. no-call / dossier 留存收窄（判牒专项）

| 项 | 观察 | 结态 |
| --- | --- | --- |
| `test/integration/judge-auditor-dossier.test.ts` missing-dossier / missing-subject | 负向**未配** institutional seat；计数加在 faux **provider HTTP response** 钩上；断言 `childCalls()===0` = **provider HTTP 响应次数为零**，在 materials gate 先于 child 打开的实现下成立。注释/断言说明已收窄为该计数，**不**写「child open / child provider 未打开」 | **provider HTTP 调用数为零已结**（留存案） |
| 更强原契约「整个 child/auth 未打开 / 真 Pi 子进程 audit 失败矩阵」 | 现 childCalls **只数** provider 响应；健康路径才 `armPassResponse`+seat。`src/evidence-child-executor.ts` 先读 runDirectory/seat 再开 scratch/child——负向未配 seat 时的更强「未开 child session」**无**对等宿主证明 | **更强 child/auth 未打开、原 subprocess 矩阵：未结** |
| 不得宣称 | 不得写「已证明整个 child/auth 未打开」或用 no-call 绿灯结清 `audit-failure-subprocess` / fixture-tracer 失败矩阵；不得把 empty-output / exit23-cause 并入 exitCode=1 真错误卷 | — |

---

## K. 盯文 / 呈现锁 / 失效行为合法删除（不造证明）

法源：`souls/quality-law.md`「盯生成物一律禁止」；锚定宪法「机器只咬契约，不咬呈现」；ADR 0016 tests-follow-logic-not-format。

| 删除类 | 样本原位置 | 处置 |
| --- | --- | --- |
| systemPrompt / soul 原文 / assignment 措辞 match | `judge-role`「production audit transcript preserves assignment…」「injects its soul…」等；grok「opening materials inject soul exactly once」；多处 `assert.match(systemPrompt, …)` | **合法删**；留存改走 typed 工具/裁决结果，不锁散文 |
| 错误文案正则（failed reactivation `/requires --ak-collector-repo/`、`/通进司未激活/`） | `collector-real-entry.test.ts:147–155` | **合法删**；清激活行为本身见 §A 未结，不因文案删而冒充行为已结 |
| help/stdout 表头、roles 表行正则、live help marker 字符串 | install/cold-help/cold-matrix | 随真宿主案删；呈现面不另造 CI |
| session 自定义 message 文案 / attendance 可见措辞 | navigator 包入口 | 随案删；typed disposition 留存于 contract 层 call-input |
| fixtures 仅服务已删宿主案 | `test/fixtures/*-provider.ts` 八件 | 随案删；无独立契约 |

---

## L. runner / 调度删案（非宿主契约）

| 原案 | 处置 | 结态 |
| --- | --- | --- |
| run-test-all heavy 分区 / manifest 闭包 / 子进程退出传播 | 随 heavy 空置改写；现 `scripts/run-test-all.mjs` heavy 空、默认并行一子进程 | 调度行为以**现行** runner+`test/integration/run-test-all.test.ts` 为准；旧 heavy 分区契约 **作废**（产品决策：空 heavy），非未证明宿主行为 |

---

## 明确排除

- 任何 `aggregation-dossier.json` / `deletedContractHandoff` / scratch 聚合脚本输出。
- `BOOK/01a072fc-685-c3-agg-*@fixer` 七伪目录（owner：原地保全）。
- 通配 `01a072*@{role}` 或「同角色任意 terminal」冒充专用契约。

## 聚合脚本

worktree 内无聚合脚本、无向 `~/.ak-roles/books` 写伪 run 的提交代码。r7 scratch 未入仓；不复跑、不复写。

## 与既有代码的关系

- **保留**：C4 primary-aware-cleanup / hermes 边界；C3 judge-auditor no-call（**仅** provider HTTP 调用数为零，见 J）；engine-detour cancel-idle（**仅** abort/spawn-miss/silent-idle 窄 seam，**不**承接 empty-output / exit23-cause / 公开 CLI 失败表）与 engine-axis 配置案；worker gate 非宿主 arm；activation symlink；oauth 留存 warning/single-flight 等；npm optional peer **元数据** call-input（**不**承接 ordinary install HOST_PEERS ENOENT）。
- **作废为承接**：r7 自拟聚合摘要；凡「健康 terminal ⇒ 专用契约已结」的跳连；用 `exitCode=0`「本激活内劳务引擎已使用」冒充 reviewer engine 进程失败 cause 贯穿；用 exitCode=1 真错误卷或 cancel-idle seam 合并结清 empty-output / exit23-cause；用 optional peer 元数据或 detour idle 旁证合并结清 HOST_PEERS ENOENT / compliance stream 耗尽。

---

## M. r13 日常 CI 残留真实宿主复演（判官 continue 送修）

原文件：`test/integration/judge-auditor-retention-real-pi.test.ts`（整文件删除）。

调用链（删前实证）：`runAkRole` **未**注入 `roleTurnHost` / `hostAdapters` → `resolveRoleTurnHost` → `createPiRoleTurnHost` → `createDefaultPiSpawnRunner` **真 spawn Pi**；`credentials` 双 true 越过 pre-dispatch；`judgeExtraPiArgs: ["-e", tracer.extension]` 挂真 HTTP provider + session principal 替换注入。专用夹具 `createJudgeAuditorRetentionTracer`（HTTP server、fs.watch、setInterval 恢复、EISDIR 目录替换）仅服务本文件，随文件删除，**无**跨文件共用方。不改生产、不 skip、不迁 adjudication、不造 mock 证明。

| 原案（行为） | 必要性 | 同根 | 处置 | 精确承接 | 结态 |
| --- | --- | --- | --- | --- | --- |
| Judge 公开入口在 **retention 失败**下仍如实保留真实默认-Pi **auditor provider stop**：`details.httpStatus=500` | 真宿主+真 HTTP 500 wire | provider-stop 族 | 删 | 生产 `BOOK/**/artifacts/error.json` 全扫 **无** `"httpStatus": 500` 与本复合观察同形的 judge auditor stop 卷。留存 `test/integration/public-cli-failure-provider-stop.test.ts` 为 **faux runner / 手构 session custom** 投影（含预置 retentionFailure 形状），**不是**默认 Pi 真 spawn + 真 500 Response 观察 | **未结** |
| 同上路径 `details.retentionFailure.name=ComplianceResponseRetentionError` | 真宿主 retain 失败面 | 上列 | 删 | 生产 error 卷 **无** `ComplianceResponseRetentionError` 具名 identity。BOOK 内同名字符串仅出现于 admitted-request / 报告附件叙述，**不是** typed error 产物。留存 provider-stop 案手写 `retentionFailure: { name: "ComplianceResponseRetentionError", cause: { code: "EISDIR" } }` 只证 settlement **读已写入 session** 的形状，不证 retainComplianceResponse 真失败 | **未结** |
| 同上路径 `details.retentionFailure.cause.code=EISDIR`（sitian `auditor/records.jsonl` 被换成目录） | 真宿主 retain errno | 上列 | 删 | 无 EISDIR-on-retain 专用生产 error 卷。留存 provider-stop「typed-HTTP sidecar 为目录 → readFile EISDIR」是 **observation 读路径** 非 absence，与 sitian retain 写路径 **不是同一观察** | **未结** |

### r13 调用链全扫摘要（test/{unit,contract,integration,package} + helper）

按真实调用区分，不按文件名：

| 命中 | 实际路径 | 处置 |
| --- | --- | --- |
| `judge-auditor-retention-real-pi.test.ts` | 无 host 注入 + credentials 过门 + 真 spawn + 真 provider | **已删** |
| `public-cli-failure-real-entry`「default runner empty-auth」 | 无 `roleTurnHost`，但 `credentials` 双 false → `missingCredentialPreDispatchFailure` **先于** `executeTurn`；不 spawn | **留存**（确定性 pre-dispatch） |
| `public-cli-engine-axis` 无 host 的 judge/roles 案 | 语法非法 engine / 非法 persistent config → exit 2 结构拒，不进 turn | **留存** |
| `public-cli-notary` / `countersign` 无 host 案 | 入场参数/source-run 结构拒，不进 turn | **留存** |
| `public-cli-host-axis` | `hostAdapters` 或注入 counting `roleTurnHost` | **留存**（确定性 adapter 表） |
| 大量 `roleTurnHostFromLegacyPiRunner` / `createMinimalHost` 调用方 | 确定性 faux spawnRunner，不调默认 Pi 二进制 | **留存** |
| `public-cli-explicit-internal` 用 `createDefaultPiSpawnRunner` | PATH/`PI_BINARY` 指向 **自写 stub 可执行文件**，测 runner 解析/就绪/失败身份，非真 Pi 宿主会话 | **留存** |
| `package-home-cli-seam` `runAkRole(["roles"])` | 不进 role turn / 不 spawn Pi | **留存** |
| cold-install / `getSharedIsolatedPack` / `runPiSubprocess` / `installPackedArtifact` | 日常 test 树 **已无** 调用（heavy 空；既有删案见 §H） | 无新增命中 |
| helper `role-turn-host-fixture` / `failure-settlement-kit` | 共享确定性夹具；本删案无独占 helper 文件 | **留存** |

### 必要性列全扫（r10）

| 命中 | 处理 |
| --- | --- |
| §A failed reactivation 误标真宿主（手构 fake pi，文案正则） | 已按实际行为改必要性；文案合法删 / 清激活未结 |
| 其余 §A 行 | 公开入口/HTTP 404 等契约面仍属宿主失败或生产卷可旁证者保持原标；专用未结已单列，不因文件名 `real-entry` 扩已结 |
| §B–G、I 原标真宿主 | 抽核 gatekeeper/detour/judge-run 等：要么真 `runAkRole`/`runPiSubprocess`，要么 in-process 宿主缝且结态已是未结/旁证分列；**无**第二处「纯 fake + 文案锁却标真宿主并已结」 |
| §H package-tool-idle / npm peers | 见上：拆出 HOST_PEERS ENOENT 与 compliance stream 耗尽专用未结 |
| §D empty-output / cause 合并已结 | 见上：拆行，保留 exitCode=1 窄已结 |
