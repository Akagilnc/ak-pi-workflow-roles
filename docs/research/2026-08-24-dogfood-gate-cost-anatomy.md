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
| 父腿 test suite / test:all | **不可机械归因**：现有记录无 typed test-kind；`bash.command` 任意 shell 文本不得正则/措辞分类（锚定宪法）。本报告不产 suite 次数/耗时/派生总计 |
| 闸终局合法性 | 仅同卷内获得 `toolResult.isError === false` 的终局 toolCall 可分类为 dispatch/officer；拒收或无结果不形成轮次 |

**「全部」的定义**：完整已结束日历日内候簿目录总体，不是「Analyst 已接纳腿」的同义反复。进入指标汇总的只有 readable；其余类别逐 runId 列排除理由，总数守恒。

> 口径变更说明（r3）：r2 曾用 UTC 标签并以 asOf 截断未闭合的 UTC 日（`fullUtcDayClosedAtAsOf=false`）。本机 dogfood 墙钟时区为 JST；JST `2026-08-24` 的日终 `15:00Z` 已在 asOf `19:40Z` **之前**完整结束，故改以 JST 完整日历日为「该日全部」，不再用部分日冒充全日。
>
> 口径变更说明（r4）：①补官取证工具墙钟并与 `officerWall` 分列；②拆除父腿 suite/test:all 自由文本机械分类及全部派生数字，诚实记不可机械归因；③勘正误写「日终在 asOf 之后」→「日终在 asOf 之前」。

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
| 父腿 test suite / test:all | **不可机械归因**（无 typed test-kind；见口径） |

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

### 父腿 test suite / 全量测试（诚实缺口）

现有 sole-scan / session 记录**没有** typed `test-kind`（或等价 schema 键）。父腿 `bash` 的 `command` 虽挂在 typed bash 工具上，但是任意 shell 文本；以正则/措辞匹配 `npm/pnpm/yarn … test(:all)?` 再派生次数、墙钟、表格或机器摘要，违反仓级锚定宪法（机器只咬契约，不咬呈现/自由文本）。

因此本报告：

- **删除**一切 suite / test:all 次数、耗时、次均、表格与机器摘要字段；
- **不**在本修复中新增生产记录字段、第二扫描或写端；
- 若 OWNER 仍要机器可消费的「判官自跑全量次数与耗时」，须另行授权 typed 契约后再取。

（人读旁注，**不进机器摘要、不进承重总计**：历史手扒曾见个别父腿自跑全量测试；在无 typed test-kind 前，该观察不能升格为全日可复核数字。）

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
| 父腿 test suite | 不可机械归因（无 typed test-kind） | — |
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
4. **父腿全量测试**：无 typed test-kind，**不可机械回答**本腿或全日「自跑 test:all 次数/耗时」。OWNER 手扒线索「判官单轮自跑 test:all 两次约占 10 分钟」在现有记录下无法依法机械复核；不得用 `bash.command` 措辞凑数字。
5. **官取证密度（次数）**：本腿官卷 bash 轮均 14.4 次（typed toolName；OWNER 手扒 ~19 次/轮；本腿 per-round 见上表，首轮 19 与线索同阶）。次数高、单轮工具 union 墙钟却常只有数秒到数十秒，说明大量短工具调用，不是每次 bash 都是长测。
6. **合成解释**：一轮「小问题」一旦进入多轮封驳，成本 ≈ Σ(`officerWall`) + 父腿模型/工具间隙 +（若触发且将来有 typed 记录）全量测试墙钟；其中 Σ(`officerEvidenceToolWall`) 只是官会话内的工具占用切片。7 轮把单轮官成本乘上去，就到 ~20 分钟量级（本腿 19.71m）。

## 完整日历日全局：两桶与闸的关系

- 腿墙钟 3357.27m 中，工具桶 44.8%、模型桶 55.2%。
- **`officerWall` 合计 155.66m** 是闸循环子会话墙钟，嵌在父腿墙钟内，**不可与父腿墙钟简单相加**；它回答「官审子会话本身吃掉多少（含模型）」。
- **`officerEvidenceToolWall` 合计 27.20m** 是上述子会话内 typed 工具 interval 的 union 占用，占 `officerWall` 17.5%；回答「官取证工具实际占用多少」，与总墙钟分列。
- **父腿 suite / test:all**：现有记录不可机械归因（见上节）；本报告不给承重数字。
- 腿墙钟 top 出现 ~6h 级 outlier（`01a02fca-…` / `01a02fce-…`）：均为 terminal 态可读腿的 frame-span 墙钟，计入全日合计；它们不是闸循环主因（闸 top 仍由多轮 notary 腿主导）。

## 复算入口

```bash
# 1) 目录总体：枚举 ~/.ak-roles/books/*/runs/*@{judge,reviewer}
#    过滤 runId UUIDv7 ∈ [JST dayStart, JST dayEnd) = [2026-08-23T15:00:00.000Z, 2026-08-24T15:00:00.000Z)
# 2) 互斥分类：readable | unreadable | live | missing_invocation | corrupt_invocation | stale_unprojected
# 3) 仅 readable → family.contribute（gate-cycles / leg-wall-clock / b2）
# 4) 官取证工具墙钟：对配对官卷 session JSONL 跑 extractSessionToolIntervals，
#    裁到官卷 span 后 merge-union（与 b2 工具桶同核）；与 officerWall 分列
# 5) 禁止：对 bash.command 自由文本做 suite/test:all 正则分类
# 全簿 issue 页（含 gateCycles / legWallClock / b2FrameBucketsActions）
ak-role analyst   # cwd = 对应 git 仓；book = git common-dir
```

本报告数字 = 上表 asOf 冻结下的**完整已结束 JST 日历日**目录总体对账 + readable 子集上的既有 Analyst 指标族 + 官卷 typed toolIntervals 的一次性报告侧 union；**无新生产扫描、无写端、无永久 probe、无新增生产契约字段**。

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
  "parentLegTestKindMechanicalAttribution": {
    "possible": false,
    "reason": "existing records have no typed test-kind field; bash.command free text must not be regex-classified under anchoring constitution"
  },
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
  "officerBashSampleN": 15
}
```
