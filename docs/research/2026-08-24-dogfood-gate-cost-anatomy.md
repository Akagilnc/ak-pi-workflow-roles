# 2026-08-24 dogfood 日票庭/复核时长解剖（#446 首单）

> OWNER 2026-08-24：「本指标族建成后的第一单分析任务＝解剖 2026-08-24 dogfood 日全部票庭/复核 run 的时长构成」。
> 本报告只消费 Analyst 已交付指标族（gate-cycles / leg-wall-clock / b2-frame-buckets-actions）与 sole-scan / 官卷上的 typed toolIntervals；不新增生产扫描、写端或 typed 契约字段。

## 取数口径（闭合）

| 项 | 值 |
| --- | --- |
| asOf（冻结时刻） | `2026-08-24T19:40:21.655Z` |
| 时区（实际 dogfood 墙钟） | **Asia/Tokyo (JST, UTC+9)** |
| 日历日标签 | `2026-08-24` |
| **完整已结束日历日窗** | `[2026-08-23T15:00:00.000Z, 2026-08-24T15:00:00.000Z)` |
| 观测窗 | 与日历日窗相同（全日已在 asOf **之前**结束，无截断） |
| 全日是否在 asOf 已结束 | **是**（JST 日终 = `2026-08-24T15:00:00.000Z`，在 asOf **之前**；`dayEndRelativeToAsOf=before`） |
| 入总体判据 | 候簿 `books/*/runs/<runId>@<role>` 目录存在，且 runId UUIDv7 嵌入时间 ∈ 日历日窗，且 `role ∈ {judge, reviewer}` |
| 簿 | 日历日内实际出现票庭/复核腿的簿：`ak-pi-workflow-roles`、`Ming_LLM` |
| 指标入口 | 目录总体对账后，仅对 **readable** 子集跑 `scanAnalystIssueRuns({ bookKey })` → metric family `contribute`（gate-cycles / leg-wall-clock / b2-frame-buckets-actions） |
| 官子会话总墙钟 `officerWall` | 配对官卷 first→last 可用时间戳差（gate-cycles；含模型间隙） |
| 官取证工具墙钟 `officerEvidenceToolWall` | 配对官卷内 **closed typed toolIntervals** 裁到该卷 span 后的 **merge-union** 占用（与 b2 工具桶同核）；**与 `officerWall` 分列，不得互相冒充** |
| 官 bash 次数 | 同上官卷内 `toolName === "bash"` 的 closed intervals 计数（typed toolName，非 command 文本） |
| 父腿 test suite / 全量·聚焦 | **typed 区间底账（机械）＋报告层 LLM 逐条语义分类**（御批 2026-08-25 释宪：统计/分析对已冻结卷宗可由 LLM 分类；引证为卷宗指针 runId/toolCallId/class，命令原文留冻结 session，不誊进报告；shell 为形式语言；**零新生产机制 / 无 typed test-kind 写端**）。判据见下节 |
| 闸终局合法性 | 仅同卷内获得 `toolResult.isError === false` 的终局 toolCall 可分类为 dispatch/officer；拒收或无结果不形成轮次 |

**「全部」的定义**：完整已结束日历日内候簿目录总体，不是「Analyst 已接纳腿」的同义反复。进入指标汇总的只有 readable；其余类别逐 runId 列排除理由，总数守恒。

> 口径变更说明（r3）：r2 曾用 UTC 标签并以 asOf 截断未闭合的 UTC 日（`fullUtcDayClosedAtAsOf=false`）。本机 dogfood 墙钟时区为 JST；JST `2026-08-24` 的日终 `15:00Z` 已在 asOf `19:40Z` **之前**完整结束，故改以 JST 完整日历日为「该日全部」，不再用部分日冒充全日。
>
> 口径变更说明（r4）：①补官取证工具墙钟并与 `officerWall` 分列；②拆除父腿 suite/test:all **生产代码**自由文本机械分类；③勘正误写「日终在 asOf 之后」→「日终在 asOf 之前」。
>
> 口径变更说明（r5 / 御批释宪）：r5 上呈「无 typed test-kind → 不可机械交付全量明细」死结，由 OWNER 释宪解决（PR #455 入宪）：锚定宪法自由文本禁令对象是**生产代码**对不可穷举输入的机械依赖；**统计/分析对已冻结卷宗**可由报告层 LLM 做语义分类与统计，逐条附卷宗**指针**引证（runId/toolCallId/class）即为可核，不誊命令原文；形式语言命令（shell）非散文。太史**代码机制**仍只认 typed 键（ADR 0047/0068 不动）。据此本报告补交父腿全量/聚焦测试明细：typed 区间底账 + LLM 逐条分类，零新生产机制。
>
> 口径变更说明（r6 / 分类底账勘误）：复核发现 fullLedger 中混入未启动测试 runner 的 git/rg/which 取证命令（误标 `pytest_tests_dir`）。已移出 **4** 条至 `not_test_invocation`（指针回卷可核）。重推后 full=**131** / **103.94m**，pytest_tests_dir=**105** / **61.30m**，Ming judge pytest=**99** / **57.29m**（solid 88 / 57.28m；ephemeral 11 / 386ms）。仍为零新生产机制。
>
> 口径变更说明（r8 / 全分类底账）：当时将原 `fullLedger`（仅 full 131 条）扩为不重复的 `classificationLedger` **541** 条统一账（当时 full 131 + focused 375 + not_test_invocation 24 + ambiguous_or_mixed 11；r9 重判后见下条）。该类逐条底账已于 r12 按锚定宪法「不逐条立账」净删；classCounts / fullBySubkind / OWNER 主问汇总与人读证据表保留。零新生产机制 / 不改 Analyst 代码、schema、闸判据或测试。
>
> 口径变更说明（r9 / 分类底账证据诚信）：复核发现 `ambiguous_or_mixed` 假类与 `not_test_invocation` 漏计 runner。按冻结 `session.jsonl` 回卷重判 class。重推后 full=**131** / **103.94m**，focused=**373** / **35.29m**，not_test_invocation=**31** / **2.13m**，ambiguous_or_mixed=**6** / **10.94m**。classCounts / fullBySubkind / OWNER 主问与当时分类结果一致（该逐条底账已于 r12 净删）。仍为零新生产机制 / 不改 Analyst 代码、schema、闸判据或测试。
>
> 口径变更说明（r10 / 报告引证指针形）：按现行锚定宪法「生产与统计两个 regime」与 2026-08-25 指针引证御批，问题级人读表与必要引证改为指针形（`runId` / `toolCallId` / `class`）；命令原文、区间等事实留冻结 session 卷宗，开卷核对；删除报告内 commandCited/命令节录及 r6/r8/r9 平行逐项勘误账与 OWNER/兄弟/聚焦表命令列。汇总、分类方法与判据、class 分布（full 131 / focused 373 / not_test_invocation 31 / ambiguous_or_mixed 6）不变。r10 仍保留的 `classificationLedger` 指针底账已于 r12 净删。仍为零新生产机制。
>
> 口径变更说明（r12 / 净删逐条分类底账）：按锚定宪法「举证到问题所需粒度为止，汇总申报方法与判据即可，不逐条立账」，净删机器摘要 `parentLegTestDetail.classificationLedger` 全部 **541** 项逐条指针底账，并改正正文中声称该底账保留全部分类指针的 r8/r10 说明及聚焦段引用。保留分类方法、判据、classCounts / fullBySubkind / OWNER 等汇总与问题所需人读证据表；不另造逐项索引或生产字段。仍为零新生产机制。

## 目录总体对账（互斥类别）

先枚举日历日内全部 judge/reviewer 目录，再与 sole-scan 投影对账。类别互斥、穷尽：

| 类别 | 定义 | 数 |
| --- | --- | ---: |
| **directoryTotal** | 日历日内 judge/reviewer 目录 | **309** |
| readable | sole-scan 接纳为可读腿，进入指标 | 305 |
| unreadable | sole-scan 响亮排除（缺/坏 required source） | 0 |
| live | `run-state ∈ {admitted, running, resumable}`；sole-scan 合同省略（非死亡） | 2 |
| missing_invocation | 无 `invocation.json`，sole-scan 无法圈定 scope | 2 |
| corrupt_invocation | `invocation.json` 损坏/无 projectRoot | 0 |
| stale_unprojected | 有 invocation、非 live，但 asOf 时仍未落入 readable/unreadable | 0 |

**守恒**：

```
309 = 305 (readable) + 0 (unreadable) + 2 (live) + 2 (missing_invocation) + 0 (corrupt_invocation) + 0 (stale_unprojected)
```

| 维 | 目录总体 | readable 子集 |
| --- | ---: | ---: |
| judge | 282 | 279 |
| reviewer | 27 | 26 |
| ak-pi-workflow-roles | 46 | （见排除表） |
| Ming_LLM | 263 | （见排除表） |

### 未进入 Analyst 指标的 runId（逐项）

| runId | role | book | 类别 | 排除理由 |
| --- | --- | --- | --- | --- |
| `01a02fa7-f5ff-79f8-b7c8-fa34270b612d` | judge | ak-pi-workflow-roles | missing_invocation | invocation.json 缺席；sole-scan 无法 scope |
| `01a031a6-721f-766b-88ba-340581a0880e` | judge | ak-pi-workflow-roles | live | run-state=running（live in-flight；sole-scan 省略） |
| `01a0328f-8742-73cc-9b47-0d525ee25e2f` | reviewer | Ming_LLM | live | run-state=running（live in-flight；sole-scan 省略） |
| `01a03316-4aa1-76c2-8b07-4afe5d8114e8` | judge | Ming_LLM | missing_invocation | invocation.json 缺席；sole-scan 无法 scope |

排除合计 **4**；与 `309 − 305 = 4` 一致。

## 指标汇总（readable = 305，完整 JST 日重算）

| 项 | 值 |
| --- | ---: |
| 可读票庭/复核腿 | 305 |
| 其中 judge | 279 |
| 其中 reviewer | 26 |
| unreadable（日历日） | 0 |
| 闸循环总轮数（paired） | 93 |
| 官子会话总墙钟 `officerWall` Σ | 155.66m |
| 官取证工具墙钟 `officerEvidenceToolWall` Σ | 27.20m（占 officerWall 17.5%） |
| 官卷 closed 工具次数 Σ | 1668 |
| 官卷 bash closed 次数 Σ | 1263 |
| 腿墙钟合计 | 3357.27m |
| 两桶·工具合计 | 1504.58m（44.8%） |
| 两桶·模型合计 | 1852.69m（55.2%） |
| 父腿全量（`test:all`，judge） | **9 次 / 19.75m**（次均 2.19m；见全量明细） |
| 父腿聚焦测试（两簿 judge+reviewer） | **373 次 / 35.29m**（LLM class=`focused`） |
| 父腿全量族合计（含 pytest tests/ 等 subkind） | **131 次 / 103.94m**（LLM class=`full`；subkind 分列） |

### 按官（gate-cycles.byOfficer）

| officer | rounds | bounce | pass | bounceRate | meanOfficerWall |
| --- | ---: | ---: | ---: | ---: | ---: |
| notary | 93 | 52 | 41 | 0.559 | 1.67m |

### 闸循环最多的腿（top 15）

| rounds | officerWallΣ | evidenceToolWallΣ | bashΣ | role | book | runId |
| ---: | ---: | ---: | ---: | --- | --- | --- |
| 14 | 30.18m | 7.30m | 177 | judge | ak-pi-workflow-roles | `01a0327e-78c4-71a4-8382-d7ba444f133a` |
| 13 | 16.69m | 3.09m | 157 | judge | ak-pi-workflow-roles | `01a031bd-7a9a-79ec-aed3-e340bf46c419` |
| 9 | 16.65m | 1.62m | 137 | judge | ak-pi-workflow-roles | `01a0341a-c88c-77db-9f8c-c7d3e7466265` |
| 7 | 11.41m | 52.8s | 74 | judge | ak-pi-workflow-roles | `01a032bc-69d4-74ab-9c6b-861bbaa2e3cb` |
| 7 | 10.20m | 1.87m | 101 | judge | ak-pi-workflow-roles | `01a031ff-92c5-78e8-ad25-7ca0d346dd8b` |
| 7 | 9.65m | 1.45m | 100 | judge | ak-pi-workflow-roles | `01a031e1-31c9-79b5-b9ef-cda423cc48ea` |
| 6 | 11.01m | 55.4s | 83 | judge | ak-pi-workflow-roles | `01a032f6-0b0d-7a6f-8f5f-64bb5937d610` |
| 5 | 13.64m | 4.68m | 116 | judge | ak-pi-workflow-roles | `01a0322e-d065-7d9b-a247-bd279f137934` |
| 4 | 9.24m | 1.94m | 88 | judge | ak-pi-workflow-roles | `01a033f6-8225-7bde-b1c6-7c87524870be` |
| 4 | 4.19m | 6.4s | 31 | judge | ak-pi-workflow-roles | `01a0340f-9bca-7095-af4c-99d8bf57b41a` |
| 3 | 4.71m | 40.0s | 43 | judge | ak-pi-workflow-roles | `01a033b2-4a31-77cf-b308-b4a241ce26bb` |
| 2 | 4.85m | 1.76m | 27 | judge | ak-pi-workflow-roles | `01a03254-06a1-762b-b906-0a8eb62ce62f` |
| 2 | 2.85m | 11.6s | 30 | judge | ak-pi-workflow-roles | `01a0335f-b56a-7914-94c3-dbac27878c84` |
| 2 | 1.76m | 3.5s | 13 | judge | ak-pi-workflow-roles | `01a031b0-a126-7dd0-8466-8e7de82995dc` |
| 2 | 1.62m | 5.7s | 21 | judge | ak-pi-workflow-roles | `01a03395-c513-72c6-a2b4-e7ef888a475b` |

### 腿墙钟 top 10（leg-wall-clock）

| wall | role | book | runId |
| ---: | --- | --- | --- |
| 379.04m | judge | ak-pi-workflow-roles | `01a02fca-02e8-7ffc-9419-50fa9d3b24d6` |
| 376.96m | judge | Ming_LLM | `01a02fce-2beb-7140-bf47-7e089a2f5699` |
| 66.57m | judge | ak-pi-workflow-roles | `01a0327e-78c4-71a4-8382-d7ba444f133a` |
| 66.02m | reviewer | Ming_LLM | `01a03276-03a4-7cf2-9a93-648893700094` |
| 45.54m | judge | Ming_LLM | `01a03336-164e-77d5-bbc6-6e83c402c9d0` |
| 42.98m | judge | ak-pi-workflow-roles | `01a0341a-c88c-77db-9f8c-c7d3e7466265` |
| 41.13m | judge | Ming_LLM | `01a03334-0ab4-7db6-bf30-dd6f763c0b60` |
| 38.47m | judge | Ming_LLM | `01a03334-619a-7207-8bf6-ebac709f2fbd` |
| 36.33m | judge | ak-pi-workflow-roles | `01a031bd-7a9a-79ec-aed3-e340bf46c419` |
| 31.91m | judge | ak-pi-workflow-roles | `01a032bc-69d4-74ab-9c6b-861bbaa2e3cb` |

### 父腿全量 / 聚焦测试明细（r5：typed 区间底账 + LLM 逐条分类）

**法源**：御批 2026-08-25（票面置顶 + CLAUDE.md 锚定宪法「生产与统计两个 regime」；PR #455）。报告层对已冻结卷宗做 LLM 语义分类，逐条附卷宗指针（runId / toolCallId / class）；命令原文留冻结 session，**不**誊进报告；**不**新增生产 typed test-kind、不改 Analyst 代码机制、不把分类器写进闸判据。

#### 1) typed 区间底账（机械）

| 项 | 值 |
| --- | ---: |
| 总体 | 日历日 readable 父腿（judge/reviewer）session 内 **closed** `toolName==="bash"` 的 `SessionToolInterval` |
| closed bash 条数 | **4474** |
| 未闭合 open bash（不入账） | 4 |
| 墙钟来源 | `endedAt − startedAt`（typed 时间戳，机械） |
| 引证形 | 报告只留指针 `runId` + `toolCallId` + `class`；命令原文在冻结 session `toolCall.arguments.command`，开卷核对，不誊进本报告 |

#### 2) 全量 / 聚焦判据（明文）

| class | 判据 |
| --- | --- |
| **full** | 调用该仓**整包默认/CI 测试语料**，无 path、node-id、name-pattern 收窄。subkind：`test_all`（`npm\|pnpm\|yarn [run] test:all`＝本仓 CI 全量闸）；`package_default_test`（裸 `npm\|pnpm\|yarn test`→unit+contract）；`test_integration_tier`（整 tier `test:integration`）；`pytest_tests_dir`（`pytest tests/` 或仅全局旗标的默认发现）；`web_package_default_test`（`cd web && npm test -- --run` 无路径） |
| **focused** | runner 带文件路径、`::` node-id、`-k`/`-t`/`--test-name-pattern`、单文件 vitest/node --test 子集；或仅 adjudication tier |
| **not_test_invocation** | 未真正拉起 runner：`--version`/`command -v`、只 rg/git 提及 test、扒 CI log、shell builtin `test` |
| **ambiguous_or_mixed** | 同一 bash 区间内全量与聚焦并存，或主意图无法诚实单列 |

OWNER 题面「判官自跑**全量**」的**主口径**＝`role=judge` 且 `fullSubkind=test_all`。其余 full subkind 作兄弟账，不与 `test:all` 混称「全量闸」。

#### 3) 分类汇总（父腿 bash 候选经 LLM 逐条）

| class | 次数 | 墙钟 Σ |
| --- | ---: | ---: |
| full | 131 | 103.94m |
| focused | 373 | 35.29m |
| not_test_invocation | 31 | 2.13m |
| ambiguous_or_mixed | 6 | 10.94m |

full 按 subkind：

| fullSubkind | 次数 | 墙钟 Σ |
| --- | ---: | ---: |
| test_all | 9 | 19.75m |
| package_default_test | 10 | 11.22m |
| test_integration_tier | 4 | 10.47m |
| pytest_tests_dir | 105 | 61.30m |
| web_package_default_test | 3 | 1.20m |

#### 4) OWNER 主问：判官自跑 `test:all`（9 次 / 19.75m / 次均 2.19m）

| wall | role | book | runId | toolCallId |
| ---: | --- | --- | --- | --- |
| 2.48m | judge | ak-pi-workflow-roles | `01a0341a-c88c-77db-9f8c-c7d3e7466265` | `call_2qeq5uoOVaRQsfyJEm0RMFpf\|fc_0fb55c458f1a12f0016a8c50ea7e7087d09056114c9b3c1bae` |
| 2.40m | judge | ak-pi-workflow-roles | `01a032e6-5d99-76ac-be62-d55459a0ef0e` | `call_sXnozXCNxDFI4hTqgsW9cTJX\|fc_00e6ff36232bf5f5016a8c020bc78487d095b74392247009ef` |
| 2.36m | judge | ak-pi-workflow-roles | `01a032bc-69d4-74ab-9c6b-861bbaa2e3cb` | `call_HJ29Nqg1b3EcSryTxEcmZZ9J\|fc_06ed057802452922016a8bf747f4ac87d0a53d5611e89459aa` |
| 2.33m | judge | ak-pi-workflow-roles | `01a033f6-8225-7bde-b1c6-7c87524870be` | `call_tSf8Lky1Stqo66CpNliWoNVB\|fc_0fca8464ed28d4db016a8c47b75a3c87d08497d3de94bbf3ef` |
| 2.31m | judge | ak-pi-workflow-roles | `01a033b2-4a31-77cf-b308-b4a241ce26bb` | `call_johJreLMefBN6M23bN88Bdgi\|fc_0e499e60e20b8beb016a8c366df36887d09ef63974cc61ab8d` |
| 2.30m † | judge | ak-pi-workflow-roles | `01a0322e-d065-7d9b-a247-bd279f137934` | `call_CMSLNUWtDB0RbKohizG5Yegi\|fc_0547106a672c53c9016a8bd2ee736487d09ccf55eb6a88637a` |
| 2.29m | judge | ak-pi-workflow-roles | `01a0327e-78c4-71a4-8382-d7ba444f133a` | `call_WpXiJwSbeP3dP6igN6WxDxS7\|fc_02e78677cbf53d14016a8be7584a0087d098bfdf0444f130d6` |
| 1.64m † | judge | ak-pi-workflow-roles | `01a03254-06a1-762b-b906-0a8eb62ce62f` | `call_1LV9TZ1WNfnB5kK3gNID1TsD\|fc_03ac8a583c965694016a8bdc74210887d08a9b2b9c6b7b9bc0` |
| 1.64m | judge | ak-pi-workflow-roles | `01a03254-06a1-762b-b906-0a8eb62ce62f` | `call_0O1hMcy9MtgulSA3zRzsYoUt\|fc_03ac8a583c965694016a8bdc7420ec87d0868835df02a352ac` |

† 墙钟＝整个 bash 区间，可能含非测试步骤（typecheck / worktree setup）；命令原文按指针回卷宗核对，不誊本表。

对照 OWNER 手扒线索「判官单轮自跑 test:all 两次约占 10 分钟」：全日 **9** 次、次均 **2.19m**；单腿最多见 `01a03254-…` **两次**（HEAD + 隔离基线）合计约 **3.28m**（区间含准备开销）。「两次约 10 分钟」高于本日实测次均——suite 已变快，或口述含其它开销；量级同阶（分钟级），不是每条多轮闸腿的固定税。

#### 5) 兄弟账（ak-pi-workflow-roles · judge，非 test:all）

**package_default_test**（判据：裸 `pnpm|npm test` → unit+contract）：**8 次 / 11.05m**

| wall | runId | toolCallId |
| ---: | --- | --- |
| 6.48m | `01a02fb1-da05-7644-8c24-6d7cd8e491ad` | `call_TOrorOtFHpDHx8pQlKgu3Sk8\|fc_0c786fb7655f8009016a8b30234b7487d0b80cab974fcdc088` |
| 1.36m | `01a02f79-3046-7223-b6e6-b7a7acab0d74` | `call_GpDLMPmkPMElMiH7t43wImXo\|fc_0d8560b8fb5d20f9016a8b2149c63087d0803048c91237c8c9` |
| 1.33m | `01a02f88-a745-79d5-b515-8a3a93aa0d1f` | `call_jP5ofa11ghbaiHy311dKkFlP\|fc_0170ed1f45ff6455016a8b255da8fc87d0af926f46cdc74860` |
| 1.30m | `01a02f80-598a-712d-98ec-f0772dbc3a29` | `call_2Fbc7xxzlHlRi9IDX0HxvC3R\|fc_02bf6298448346e3016a8b232ec32887d0a361a11f7a61bf99` |
| 9.4s | `01a02f3f-4931-79b0-bb9b-278e8de4191b` | `call_DShWaVUz96ZTFAdAI6TbjXzD\|fc_0d2e402c3e8d00af016a8b1289896087d0aa1d4635381bc3e4` |
| 8.9s | `01a02f23-e70e-7c1b-9e36-a43d4e7f83e6` | `call_RtRiuJ6awXcII5DR7ioYvkjf\|fc_06e2e6f4781dd9df016a8b0b8641c087d0b56610a9efd0156c` |
| 8.4s | `01a02f71-67b6-70cd-8072-9714c2b3876b` | `call_DajNtMRKEgCJUs6Qgg5FZnl0\|fc_00e45e68c46987cd016a8b1f4c5cb487d08ce7e99305ecdc02` |
| 8.1s | `01a02f6c-e6e3-7681-88f4-6009cc292bed` | `call_nAnJ2QOIrAkvqewtdCQKl3iv\|fc_022ac9c4bb7b4286016a8b1e1af48087d09cf1933cf9cb6b73` |

**test_integration_tier**：**4 次 / 10.47m**（指针：`01a02fb1` 6.48m、`01a02f79` 1.36m、`01a02f88` 1.33m、`01a02f80` 1.30m；命令原文回卷核对）。

**Ming_LLM judge · pytest_tests_dir**：**99 次 / 57.29m**；其中 duration&lt;200ms 的短暂失败/空跑 **11 次 / 386ms**（仍记 full，solid 子集 88 次 / 57.28m）。

#### 6) 聚焦样本（top wall；class=`focused`）

| wall | role | book | runId | toolCallId |
| ---: | --- | --- | --- | --- |
| 47.7s | judge | Ming_LLM | `01a02fce-2beb-7140-bf47-7e089a2f5699` | `call_bMcirZeImrgyxemkeKfR40GV\|fc_0fd16db14de808da016a8b370960d887d0a4e411375fc942ad` |
| 43.9s | judge | Ming_LLM | `01a031ca-62f0-7210-b594-bb716ed853c9` | `call_DJOfaiZXSQf6mIH695JN8UOD\|fc_012095fadd1f31e0016a8bb94ec3c887d0b7d683c7511f6cc6` |
| 41.1s | judge | ak-pi-workflow-roles | `01a02fb1-da05-7644-8c24-6d7cd8e491ad` | `call_VirwDj5wHszRvJEtoMFyASFa\|fc_0c786fb7655f8009016a8b2ff63f5087d09aec9f68663c22aa` |
| 41.1s | judge | ak-pi-workflow-roles | `01a02fb1-da05-7644-8c24-6d7cd8e491ad` | `call_ul4p1pL5wxA5DuPWhsIHx2CL\|fc_0c786fb7655f8009016a8b2ff63f4487d0afff4dfa9a245982` |
| 38.6s | judge | Ming_LLM | `01a0321c-bbff-735c-a254-e30b7a8154dd` | `call_sGV3KPiYBaYUCS9ScCwOL6Ky\|fc_0863ac12fbe8d7ac016a8bce83c17087d0b384a8a2e5214b92` |

完整 focused 373 条不在人读表展开；分类以 classCounts 汇总与明文判据为准，问题级样本见上表指针；命令原文按指针回冻结 session 核对。不保留 541 项逐条分类底账。

#### 7) 漏计边界申报

1. **只计父腿** judge/reviewer session bash；官/notary 子会话 bash 归官取证密度，不入本 OWNER 行。
2. **只计 closed** interval；4 条 open bash 跳过。
3. **只计 readable 305 腿**；目录总体 4 条排除腿无父腿 bash 入账。
4. **墙钟＝整个 bash 区间**：复合脚本（typecheck+test:all、worktree+test:all、`test \| tee`）把非测试步骤时间算进该类——可能**高估**纯测试墙钟。
5. 报告不誊命令原文；回卷读 `arguments.command` 全文。只读 typed first-line 的复算会漏 `set -e` 开头的多行 body。
6. **无生产 test-kind**：本分类是报告层 LLM 语义结论；`ambiguous_or_mixed` 边缘再跑可能微调；闸判据仍只认 typed 键。
7. pytest &lt;200ms 的 full 记 ephemeral，solid 子集另列。
8. 两簿 full 定义不同生态（`test:all` vs `pytest tests/`），**禁止**跨簿加总冒充单一 CI 闸。
9. 候选预筛依赖卷宗命令文本出现 runner 词；经 ≥20s 长 bash 抽查，未见「匿名间接跑测试」标本，但理论上仍可能漏。

### 官卷 bash 取证密度（样本：闸轮最多的腿；typed `toolName==="bash"`）

| mean bash/round | rounds | bashΣ | role | runId |
| ---: | ---: | ---: | --- | --- |
| 23.2 | 5 | 116 | judge | `01a0322e-d065-7d9b-a247-bd279f137934` |
| 22.0 | 4 | 88 | judge | `01a033f6-8225-7bde-b1c6-7c87524870be` |
| 15.2 | 9 | 137 | judge | `01a0341a-c88c-77db-9f8c-c7d3e7466265` |
| 15.0 | 2 | 30 | judge | `01a0335f-b56a-7914-94c3-dbac27878c84` |
| 14.4 | 7 | 101 | judge | `01a031ff-92c5-78e8-ad25-7ca0d346dd8b` |
| 14.3 | 3 | 43 | judge | `01a033b2-4a31-77cf-b308-b4a241ce26bb` |
| 14.3 | 7 | 100 | judge | `01a031e1-31c9-79b5-b9ef-cda423cc48ea` |
| 13.8 | 6 | 83 | judge | `01a032f6-0b0d-7a6f-8f5f-64bb5937d610` |
| 13.5 | 2 | 27 | judge | `01a03254-06a1-762b-b906-0a8eb62ce62f` |
| 12.6 | 14 | 177 | judge | `01a0327e-78c4-71a4-8382-d7ba444f133a` |
| 12.1 | 13 | 157 | judge | `01a031bd-7a9a-79ec-aed3-e340bf46c419` |
| 10.6 | 7 | 74 | judge | `01a032bc-69d4-74ab-9c6b-861bbaa2e3cb` |
| 10.5 | 2 | 21 | judge | `01a03395-c513-72c6-a2b4-e7ef888a475b` |
| 7.8 | 4 | 31 | judge | `01a0340f-9bca-7095-af4c-99d8bf57b41a` |
| 6.5 | 2 | 13 | judge | `01a031b0-a126-7dd0-8466-8e7de82995dc` |

样本均值 mean-bash/round = **13.7**（n=15 腿）。

## 焦点账：为何一单会到 ~20 分钟

样本腿（#440 调查点名的 7 轮闸循环 run）：`01a031ff-92c5-78e8-ad25-7ca0d346dd8b@judge`。

| 构成 | 值 | 占腿墙钟 |
| --- | ---: | ---: |
| 腿墙钟（leg-wall-clock） | 19.71m | 100% |
| 两桶·工具 | 14.77m | 75.0% |
| 两桶·模型 | 4.93m | 25.0% |
| 闸循环轮数 | 7 | — |
| 官子会话总墙钟 Σ（`officerWall`） | 10.20m | 51.8% |
| 官取证工具墙钟 Σ（`officerEvidenceToolWall`） | 1.87m | 9.5%（占 officerWall 18.3%） |
| 父腿 test:all / 聚焦测试 | **0 次**（本腿 session 无 full/focused 测试 runner 调用） | 0% |
| 官卷 bash 次数 Σ / 轮均 | 101 / 14.4 | — |

### 逐轮闸循环（officerWall 与 evidenceToolWall 分列）

| round | officer | status | officerWall | evidenceToolWall | bashCount | findingsCount |
| ---: | --- | --- | ---: | ---: | ---: | ---: |
| 1 | notary | bounce | 1.42m | 3.9s | 19 | 3 |
| 2 | notary | bounce | 59.6s | 6.6s | 14 | 1 |
| 3 | notary | bounce | 1.08m | 7.7s | 8 | 1 |
| 4 | notary | bounce | 1.65m | 40.1s | 11 | 1 |
| 5 | notary | pass | 1.33m | 29.7s | 10 | 0 |
| 6 | notary | bounce | 2.24m | 5.8s | 22 | 1 |
| 7 | notary | pass | 1.49m | 18.2s | 17 | 0 |

### 归因（可核账）

1. **闸循环本身是主放大器**：7 轮 paired 官会话，`officerWall` 合计 10.20m，约占腿墙钟 51.8%。bounce×5 / pass×2。此列为**官子会话总墙钟**（含模型间隙），不是取证工具占用。
2. **官取证工具墙钟分列**：同 7 卷 closed typed toolIntervals 的 merge-union 合计 1.87m，占 `officerWall` 18.3%、占腿墙钟 9.5%。工具占用远小于子会话总墙钟——官会话里模型/间隙仍是大头；不得把 `officerWall` 误称为「Σ(官取证墙钟)」。
3. **两桶**：工具桶 14.77m vs 模型桶 4.93m——父腿工具侧已是显著份额（75.0%），不是「纯模型思考」账。
4. **父腿全量测试**：本焦点腿 **0 次** `test:all` / 0 次 focused 测试 runner（逐条 LLM 分类，session 内无匹配）。OWNER 手扒「单轮自跑 test:all 两次约 10 分钟」对应的是**全日其它腿**（见上节 9 次/19.75m；`01a03254-…` 同腿两次合计 ~3.28m），**不是**本 7 轮闸腿的固定税。
5. **官取证密度（次数）**：本腿官卷 bash 轮均 14.4 次（typed toolName；OWNER 手扒 ~19 次/轮；本腿 per-round 见上表，首轮 19 与线索同阶）。次数高、单轮工具 union 墙钟却常只有数秒到数十秒，说明大量短工具调用，不是每次 bash 都是长测。
6. **合成解释**：一轮「小问题」一旦进入多轮封驳，成本 ≈ Σ(`officerWall`) + 父腿模型/工具间隙 +（若触发）全量测试墙钟；其中 Σ(`officerEvidenceToolWall`) 只是官会话内的工具占用切片。本腿 19.71m 的主因是 7×官会话，**不是**父腿 test:all。

## 完整日历日全局：两桶与闸的关系

- 腿墙钟 3357.27m 中，工具桶 44.8%、模型桶 55.2%。
- **`officerWall` 合计 155.66m** 是闸循环子会话墙钟，嵌在父腿墙钟内，**不可与父腿墙钟简单相加**；它回答「官审子会话本身吃掉多少（含模型）」。
- **`officerEvidenceToolWall` 合计 27.20m** 是上述子会话内 typed 工具 interval 的 union 占用，占 `officerWall` 17.5%；回答「官取证工具实际占用多少」，与总墙钟分列。
- **父腿 test:all（judge）**：9 次 / 19.75m / 次均 2.19m（LLM class + typed 区间；见上节指针表）。
- **父腿 focused**：373 次 / 35.29m；**full 族（含 pytest tests/ 等）**：131 次 / 103.94m（subkind 分列，勿跨簿混加）。
- 腿墙钟 top 出现 ~6h 级 outlier（`01a02fca-…` / `01a02fce-…`）：均为 terminal 态可读腿的 frame-span 墙钟，计入全日合计；它们不是闸循环主因（闸 top 仍由多轮 notary 腿主导）。

## 复算入口

```bash
# 1) 目录总体：枚举 ~/.ak-roles/books/*/runs/*@{judge,reviewer}
#    过滤 runId UUIDv7 ∈ [JST dayStart, JST dayEnd) = [2026-08-23T15:00:00.000Z, 2026-08-24T15:00:00.000Z)
# 2) 互斥分类：readable | unreadable | live | missing_invocation | corrupt_invocation | stale_unprojected
# 3) 仅 readable → family.contribute（gate-cycles / leg-wall-clock / b2）
# 4) 官取证工具墙钟：对配对官卷 session JSONL 跑 extractSessionToolIntervals，
#    裁到官卷 span 后 merge-union（与 b2 工具桶同核）；与 officerWall 分列
# 5) 父腿测试明细：readable 父腿 closed bash 的 typed 区间底账（duration=endedAt-startedAt）；
#    报告层 LLM 按明文 full/focused 判据逐条分类；报告引证仅为 runId + toolCallId + class 指针
#    （命令原文留冻结 session.jsonl，开卷核对；非生产正则分类器；非 typed test-kind 写端）
# 全簿 issue 页（含 gateCycles / legWallClock / b2FrameBucketsActions）
ak-role analyst   # cwd = 对应 git 仓；book = git common-dir
```

本报告数字 = 上表 asOf 冻结下的**完整已结束 JST 日历日**目录总体对账 + readable 子集上的既有 Analyst 指标族 + 官卷 typed toolIntervals 的一次性报告侧 union + 父腿 bash typed 区间底账上的报告层 LLM 分类；**无新生产扫描、无写端、无永久 probe、无新增生产契约字段**。

## 机器摘要（typed，供复核）

```json
{
  "asOf": "2026-08-24T19:40:21.655Z",
  "day": "2026-08-24",
  "dayTimezone": "Asia/Tokyo",
  "dayStartInclusive": "2026-08-23T15:00:00.000Z",
  "calendarDayEndExclusive": "2026-08-24T15:00:00.000Z",
  "observationEndExclusive": "2026-08-24T15:00:00.000Z",
  "fullCalendarDayClosedAtAsOf": true,
  "dayEndRelativeToAsOf": "before",
  "books": [
    "Ming_LLM",
    "ak-pi-workflow-roles"
  ],
  "roles": [
    "judge",
    "reviewer"
  ],
  "population": {
    "directoryTotal": 309,
    "directoryByRole": {
      "judge": 282,
      "reviewer": 27
    },
    "directoryByBook": {
      "Ming_LLM": 263,
      "ak-pi-workflow-roles": 46
    },
    "categories": {
      "readable": 305,
      "unreadable": 0,
      "live": 2,
      "missing_invocation": 2,
      "corrupt_invocation": 0,
      "stale_unprojected": 0
    },
    "conservationOk": true,
    "conservationIdentity": "309 = readable(305) + unreadable(0) + live(2) + missing_invocation(2) + corrupt_invocation(0) + stale_unprojected(0)"
  },
  "exclusions": [
    {
      "runId": "01a02fa7-f5ff-79f8-b7c8-fa34270b612d",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "category": "missing_invocation",
      "reason": "invocation.json absent — sole scan cannot scope; omitted from legs and unreadable"
    },
    {
      "runId": "01a031a6-721f-766b-88ba-340581a0880e",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "category": "live",
      "reason": "run-state=running (live in-flight; sole-scan omits from legs and unreadable)",
      "lifecycle": "running"
    },
    {
      "runId": "01a0328f-8742-73cc-9b47-0d525ee25e2f",
      "role": "reviewer",
      "book": "Ming_LLM",
      "category": "live",
      "reason": "run-state=running (live in-flight; sole-scan omits from legs and unreadable)",
      "lifecycle": "running"
    },
    {
      "runId": "01a03316-4aa1-76c2-8b07-4afe5d8114e8",
      "role": "judge",
      "book": "Ming_LLM",
      "category": "missing_invocation",
      "reason": "invocation.json absent — sole scan cannot scope; omitted from legs and unreadable"
    }
  ],
  "readableLegs": 305,
  "roleCount": {
    "judge": 279,
    "reviewer": 26
  },
  "unreadableDay": 0,
  "totalGateRounds": 93,
  "totalOfficerWallMs": 9339456,
  "totalOfficerEvidenceToolWallMs": 1631996,
  "totalOfficerClosedToolCount": 1668,
  "totalOfficerBashClosedCount": 1263,
  "totalLegWallMs": 201436185,
  "totalToolBucketMs": 90274955,
  "totalModelBucketMs": 111161230,
  "evidenceDefinition": {
    "officerWallMs": "paired officer volume first→last usable timestamp delta (gate-cycles)",
    "officerEvidenceToolWallMs": "union of closed typed tool intervals inside paired officer volume, clipped to that volume span (same merge-union kernel as b2 tool bucket)",
    "relation": "officerEvidenceToolWallMs ≤ officerWallMs per round; two columns must not be conflated"
  },
  "byOfficer": [
    {
      "officer": "notary",
      "rounds": 93,
      "bounceCount": 52,
      "passCount": 41,
      "bounceRate": 0.5591397849462365,
      "meanOfficerWallMs": 100424.25806451614
    }
  ],
  "focus": {
    "runId": "01a031ff-92c5-78e8-ad25-7ca0d346dd8b",
    "role": "judge",
    "book": "ak-pi-workflow-roles",
    "roundCount": 7,
    "legWallMs": 1182446,
    "toolBucketMs": 886448,
    "modelBucketMs": 295998,
    "officerWallMs": 612178,
    "evidenceToolWallMs": 111924,
    "closedToolCount": 122,
    "bashClosedCount": 101,
    "rounds": [
      {
        "roundIndex": 1,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 85079,
        "evidenceToolWallMs": 3901,
        "closedToolCount": 21,
        "bashClosedCount": 19,
        "findingsCount": 3
      },
      {
        "roundIndex": 2,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 59619,
        "evidenceToolWallMs": 6611,
        "closedToolCount": 16,
        "bashClosedCount": 14,
        "findingsCount": 1
      },
      {
        "roundIndex": 3,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 64915,
        "evidenceToolWallMs": 7658,
        "closedToolCount": 11,
        "bashClosedCount": 8,
        "findingsCount": 1
      },
      {
        "roundIndex": 4,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 99198,
        "evidenceToolWallMs": 40108,
        "closedToolCount": 12,
        "bashClosedCount": 11,
        "findingsCount": 1
      },
      {
        "roundIndex": 5,
        "officer": "notary",
        "status": "pass",
        "officerWallMs": 79648,
        "evidenceToolWallMs": 29674,
        "closedToolCount": 15,
        "bashClosedCount": 10,
        "findingsCount": 0
      },
      {
        "roundIndex": 6,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 134137,
        "evidenceToolWallMs": 5816,
        "closedToolCount": 24,
        "bashClosedCount": 22,
        "findingsCount": 1
      },
      {
        "roundIndex": 7,
        "officer": "notary",
        "status": "pass",
        "officerWallMs": 89582,
        "evidenceToolWallMs": 18156,
        "closedToolCount": 23,
        "bashClosedCount": 17,
        "findingsCount": 0
      }
    ],
    "officerBash": {
      "rounds": 7,
      "bashTotal": 101,
      "perRound": [
        19,
        14,
        8,
        11,
        10,
        22,
        17
      ]
    },
    "parentLegTest": {
      "testAllCount": 0,
      "focusedCount": 0,
      "fullCount": 0,
      "note": "no full/focused test runner invocations in this leg session after LLM classification"
    }
  },
  "topGateLegs": [
    {
      "runId": "01a0327e-78c4-71a4-8382-d7ba444f133a",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 14,
      "officerWallMs": 1810567,
      "evidenceToolWallMs": 438162,
      "bashClosedCount": 177,
      "meanBashPerRound": 12.642857142857142
    },
    {
      "runId": "01a031bd-7a9a-79ec-aed3-e340bf46c419",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 13,
      "officerWallMs": 1001568,
      "evidenceToolWallMs": 185694,
      "bashClosedCount": 157,
      "meanBashPerRound": 12.076923076923077
    },
    {
      "runId": "01a0341a-c88c-77db-9f8c-c7d3e7466265",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 9,
      "officerWallMs": 998819,
      "evidenceToolWallMs": 96950,
      "bashClosedCount": 137,
      "meanBashPerRound": 15.222222222222221
    },
    {
      "runId": "01a032bc-69d4-74ab-9c6b-861bbaa2e3cb",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 7,
      "officerWallMs": 684347,
      "evidenceToolWallMs": 52751,
      "bashClosedCount": 74,
      "meanBashPerRound": 10.571428571428571
    },
    {
      "runId": "01a031ff-92c5-78e8-ad25-7ca0d346dd8b",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 7,
      "officerWallMs": 612178,
      "evidenceToolWallMs": 111924,
      "bashClosedCount": 101,
      "meanBashPerRound": 14.428571428571429
    },
    {
      "runId": "01a031e1-31c9-79b5-b9ef-cda423cc48ea",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 7,
      "officerWallMs": 578701,
      "evidenceToolWallMs": 86912,
      "bashClosedCount": 100,
      "meanBashPerRound": 14.285714285714286
    },
    {
      "runId": "01a032f6-0b0d-7a6f-8f5f-64bb5937d610",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 6,
      "officerWallMs": 660652,
      "evidenceToolWallMs": 55432,
      "bashClosedCount": 83,
      "meanBashPerRound": 13.833333333333334
    },
    {
      "runId": "01a0322e-d065-7d9b-a247-bd279f137934",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 5,
      "officerWallMs": 818638,
      "evidenceToolWallMs": 280816,
      "bashClosedCount": 116,
      "meanBashPerRound": 23.2
    },
    {
      "runId": "01a033f6-8225-7bde-b1c6-7c87524870be",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 4,
      "officerWallMs": 554511,
      "evidenceToolWallMs": 116586,
      "bashClosedCount": 88,
      "meanBashPerRound": 22
    },
    {
      "runId": "01a0340f-9bca-7095-af4c-99d8bf57b41a",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 4,
      "officerWallMs": 251584,
      "evidenceToolWallMs": 6397,
      "bashClosedCount": 31,
      "meanBashPerRound": 7.75
    },
    {
      "runId": "01a033b2-4a31-77cf-b308-b4a241ce26bb",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 3,
      "officerWallMs": 282842,
      "evidenceToolWallMs": 40030,
      "bashClosedCount": 43,
      "meanBashPerRound": 14.333333333333334
    },
    {
      "runId": "01a03254-06a1-762b-b906-0a8eb62ce62f",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 2,
      "officerWallMs": 290894,
      "evidenceToolWallMs": 105307,
      "bashClosedCount": 27,
      "meanBashPerRound": 13.5
    },
    {
      "runId": "01a0335f-b56a-7914-94c3-dbac27878c84",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 2,
      "officerWallMs": 171264,
      "evidenceToolWallMs": 11622,
      "bashClosedCount": 30,
      "meanBashPerRound": 15
    },
    {
      "runId": "01a031b0-a126-7dd0-8466-8e7de82995dc",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 2,
      "officerWallMs": 105810,
      "evidenceToolWallMs": 3521,
      "bashClosedCount": 13,
      "meanBashPerRound": 6.5
    },
    {
      "runId": "01a03395-c513-72c6-a2b4-e7ef888a475b",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 2,
      "officerWallMs": 97214,
      "evidenceToolWallMs": 5692,
      "bashClosedCount": 21,
      "meanBashPerRound": 10.5
    }
  ],
  "officerBashSampleMean": 13.722958892958895,
  "officerBashSampleN": 15,
  "parentLegTestDetail": {
    "regime": "statistics-over-frozen-archives (CLAUDE.md 2026-08-25); report-layer LLM classification; citations are archive pointers (runId/toolCallId/class) only — command bodies stay in frozen session.jsonl",
    "typedIntervalLedger": {
      "closedBashTotal": 4474,
      "openBashSkipped": 4,
      "durationSource": "endedAt-startedAt on closed SessionToolInterval",
      "commandCitation": "pointer only: runId + toolCallId + class on problem-level human tables and summary counts; full session toolCall.arguments.command remains in frozen archive, not transcribed into this report; no per-item classification ledger"
    },
    "classCriteria": {
      "full": "Invokes repo whole default/CI test corpus without path, node-id, or name-pattern narrowing. Subkinds: test_all (package test:all CI gate); package_default_test (npm/pnpm/yarn test → unit+contract); test_integration_tier (test:integration); pytest_tests_dir (pytest tests/ or default discovery with only global flags); web_package_default_test (web npm test -- --run no paths).",
      "focused": "Runner with file path(s), node id (::), -k/-t/--test-name-pattern, or single-file vitest/node --test subset; adjudication-only tier.",
      "not_test_invocation": "No runner exec: version/which probes, rg/git that only mention tests, CI log greps, shell test builtin.",
      "ambiguous_or_mixed": "Single bash interval clearly contains both full and focused runners, or primary intent cannot be honestly singled."
    },
    "classCounts": {
      "full": {
        "count": 131,
        "totalMs": 6236148
      },
      "focused": {
        "count": 373,
        "totalMs": 2117256
      },
      "not_test_invocation": {
        "count": 31,
        "totalMs": 127645
      },
      "ambiguous_or_mixed": {
        "count": 6,
        "totalMs": 656498
      }
    },
    "fullBySubkind": {
      "test_all": {
        "count": 9,
        "totalMs": 1185071
      },
      "package_default_test": {
        "count": 10,
        "totalMs": 672992
      },
      "test_integration_tier": {
        "count": 4,
        "totalMs": 628165
      },
      "pytest_tests_dir": {
        "count": 105,
        "totalMs": 3678063
      },
      "web_package_default_test": {
        "count": 3,
        "totalMs": 71857
      }
    },
    "ownerQuestion_judgeTestAll": {
      "definition": "role=judge AND fullSubkind=test_all",
      "count": 9,
      "totalMs": 1185071,
      "meanMs": 131675
    },
    "siblings_akRoles_judge": {
      "package_default_test": {
        "count": 8,
        "totalMs": 662866
      },
      "test_integration_tier": {
        "count": 4,
        "totalMs": 628165
      }
    },
    "ming_judge_pytest_tests_dir": {
      "count": 99,
      "totalMs": 3437338,
      "solidCount_ge200ms": 88,
      "solidTotalMs": 3436952,
      "ephemeralCount_lt200ms": 11,
      "ephemeralTotalMs": 386
    },
    "focusLegParentTestInvocations": [],
    "undercountBoundaries": [
      "Population is parent-leg bash only (judge/reviewer session toolIntervals). Officer/notary subsession bash is out of scope for this OWNER line (counted separately as officer bash density).",
      "Only closed intervals (startedAt+endedAt). 4 open bash skipped.",
      "Readable legs only from directory census (305); 4 excluded legs contribute no parent bash here.",
      "Duration is whole bash interval wall clock. Compound scripts (typecheck+test:all, worktree setup+test:all, test|tee) attribute full interval to the class — may over-credit test wall when non-test steps share the interval.",
      "Command bodies are not transcribed into this report; open the frozen session via runId/toolCallId to re-read arguments.command. Recomputes that only use typed first-line faces will miss multi-line bodies whose first line is set -e / set -o pipefail.",
      "LLM semantic class on frozen archives (authorized 2026-08-25); not a production typed test-kind. Re-runs may differ on ambiguous_or_mixed edges; full/focused criteria are explicit above.",
      "pytest tests/ attempts with duration <200ms kept as full but flagged ephemeral (likely missing interpreter/env); solid subset reported separately.",
      "Ming_LLM and ak-pi-workflow-roles full definitions differ by ecosystem (pytest tests/ vs test:all). Do not sum across books as one CI gate without subkind split.",
      "Review candidates were prefiltered by runner-token presence before LLM class; invocations that run tests via indirection without naming pytest/npm/vitest/node --test in the archive command text would be missed (no specimen found in long-other review of >=20s bashes)."
    ]
  }
}
```
