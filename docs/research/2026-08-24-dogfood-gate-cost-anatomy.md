# 2026-08-24 dogfood 日票庭/复核时长解剖（#446 首单）

> OWNER 2026-08-24：「本指标族建成后的第一单分析任务＝解剖 2026-08-24 dogfood 日全部票庭/复核 run 的时长构成」。
> 本报告只消费 Analyst 已交付指标族（gate-cycles / leg-wall-clock / b2-frame-buckets-actions）与 sole-scan 保留的 toolIntervals；不新增生产扫描或写端。

## 取数口径（闭合）

| 项 | 值 |
| --- | --- |
| asOf（冻结时刻） | `2026-08-24T19:40:21.655Z` |
| 时区（实际 dogfood 墙钟） | **Asia/Tokyo (JST, UTC+9)** |
| 日历日标签 | `2026-08-24` |
| **完整已结束日历日窗** | `[2026-08-23T15:00:00.000Z, 2026-08-24T15:00:00.000Z)` |
| 观测窗 | 与日历日窗相同（全日已在 asOf 前结束，无截断） |
| 全日是否在 asOf 已结束 | **是**（JST 日终 = `2026-08-24T15:00:00.000Z`；asOf 之后） |
| 入总体判据 | 候簿 `books/*/runs/<runId>@<role>` 目录存在，且 runId UUIDv7 嵌入时间 ∈ 日历日窗，且 `role ∈ {judge, reviewer}` |
| 簿 | 日历日内实际出现票庭/复核腿的簿：`ak-pi-workflow-roles`、`Ming_LLM` |
| 指标入口 | 目录总体对账后，仅对 **readable** 子集跑 `scanAnalystIssueRuns({ bookKey })` → metric family `contribute`（gate-cycles / leg-wall-clock / b2-frame-buckets-actions） |
| 全量测试调用 | readable 腿 `toolIntervals` 中 bash.`command` 匹配 `npm/pnpm/yarn … test(:all)?`，墙钟取 interval span |
| 官取证 bash 次数 | `session/auditor-roles/*` 中出现官终局工具的卷内 `"toolName":"bash"` 计数（特征观察，非契约锁措辞） |
| 闸终局合法性 | 仅同卷内获得 `toolResult.isError === false` 的终局 toolCall 可分类为 dispatch/officer；拒收或无结果不形成轮次 |

**「全部」的定义**：完整已结束日历日内候簿目录总体，不是「Analyst 已接纳腿」的同义反复。进入指标汇总的只有 readable；其余类别逐 runId 列排除理由，总数守恒。

> 口径变更说明（r3）：r2 曾用 UTC 标签并以 asOf 截断未闭合的 UTC 日（`fullUtcDayClosedAtAsOf=false`）。本机 dogfood 墙钟时区为 JST；JST `2026-08-24` 在 asOf 时已完整结束，故改以 JST 完整日历日为「该日全部」，不再用部分日冒充全日。

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
| 官耗时合计 | 155.66m |
| 腿墙钟合计 | 3357.27m |
| 两桶·工具合计 | 1504.58m（44.8%） |
| 两桶·模型合计 | 1852.69m（55.2%） |
| 父腿全量/测试 bash 次数 | 28 |
| 父腿全量/测试 bash 墙钟合计 | 37.66m |
| 其中 test:all 次数 | 6 |
| test:all 次均墙钟 | 2.36m |

### 按官（gate-cycles.byOfficer）

| officer | rounds | bounce | pass | bounceRate | meanOfficerWall |
| --- | ---: | ---: | ---: | ---: | ---: |
| notary | 93 | 52 | 41 | 0.559 | 1.67m |

### 闸循环最多的腿（top 15）

| rounds | officerWallΣ | role | book | runId |
| ---: | ---: | --- | --- | --- |
| 14 | 30.18m | judge | ak-pi-workflow-roles | `01a0327e-78c4-71a4-8382-d7ba444f133a` |
| 13 | 16.69m | judge | ak-pi-workflow-roles | `01a031bd-7a9a-79ec-aed3-e340bf46c419` |
| 9 | 16.65m | judge | ak-pi-workflow-roles | `01a0341a-c88c-77db-9f8c-c7d3e7466265` |
| 7 | 11.41m | judge | ak-pi-workflow-roles | `01a032bc-69d4-74ab-9c6b-861bbaa2e3cb` |
| 7 | 10.20m | judge | ak-pi-workflow-roles | `01a031ff-92c5-78e8-ad25-7ca0d346dd8b` |
| 7 | 9.65m | judge | ak-pi-workflow-roles | `01a031e1-31c9-79b5-b9ef-cda423cc48ea` |
| 6 | 11.01m | judge | ak-pi-workflow-roles | `01a032f6-0b0d-7a6f-8f5f-64bb5937d610` |
| 5 | 13.64m | judge | ak-pi-workflow-roles | `01a0322e-d065-7d9b-a247-bd279f137934` |
| 4 | 9.24m | judge | ak-pi-workflow-roles | `01a033f6-8225-7bde-b1c6-7c87524870be` |
| 4 | 4.19m | judge | ak-pi-workflow-roles | `01a0340f-9bca-7095-af4c-99d8bf57b41a` |
| 3 | 4.71m | judge | ak-pi-workflow-roles | `01a033b2-4a31-77cf-b308-b4a241ce26bb` |
| 2 | 4.85m | judge | ak-pi-workflow-roles | `01a03254-06a1-762b-b906-0a8eb62ce62f` |
| 2 | 2.85m | judge | ak-pi-workflow-roles | `01a0335f-b56a-7914-94c3-dbac27878c84` |
| 2 | 1.76m | judge | ak-pi-workflow-roles | `01a031b0-a126-7dd0-8466-8e7de82995dc` |
| 2 | 1.62m | judge | ak-pi-workflow-roles | `01a03395-c513-72c6-a2b4-e7ef888a475b` |

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

### 父腿全量/测试 bash（test:all / npm test）

| wall | role | book | runId | command |
| ---: | --- | --- | --- | --- |
| 6.48m | judge | ak-pi-workflow-roles | `01a02fb1-da05-7644-8c24-6d7cd8e491ad` | `pnpm test:integration` |
| 6.48m | judge | ak-pi-workflow-roles | `01a02fb1-da05-7644-8c24-6d7cd8e491ad` | `pnpm test` |
| 2.48m | judge | ak-pi-workflow-roles | `01a0341a-c88c-77db-9f8c-c7d3e7466265` | `npm run test:all` |
| 2.40m | judge | ak-pi-workflow-roles | `01a032e6-5d99-76ac-be62-d55459a0ef0e` | `npm run test:all` |
| 2.36m | judge | ak-pi-workflow-roles | `01a032bc-69d4-74ab-9c6b-861bbaa2e3cb` | `npm run test:all` |
| 2.33m | judge | ak-pi-workflow-roles | `01a033f6-8225-7bde-b1c6-7c87524870be` | `npm run test:all` |
| 2.31m | judge | ak-pi-workflow-roles | `01a033b2-4a31-77cf-b308-b4a241ce26bb` | `pnpm run test:all` |
| 2.29m | judge | ak-pi-workflow-roles | `01a0327e-78c4-71a4-8382-d7ba444f133a` | `npm run test:all` |
| 1.36m | judge | ak-pi-workflow-roles | `01a02f79-3046-7223-b6e6-b7a7acab0d74` | `pnpm test:integration` |
| 1.36m | judge | ak-pi-workflow-roles | `01a02f79-3046-7223-b6e6-b7a7acab0d74` | `pnpm test` |
| 1.33m | judge | ak-pi-workflow-roles | `01a02f88-a745-79d5-b515-8a3a93aa0d1f` | `set -o pipefail; pnpm test:integration 2>&1 \| tee /tmp/ak435-integration.log; status=${PIPESTATUS[0]}; if rg -n 'fatal: Unable to hash' /tmp...` |
| 1.33m | judge | ak-pi-workflow-roles | `01a02f88-a745-79d5-b515-8a3a93aa0d1f` | `set -o pipefail; pnpm test 2>&1 \| tee /tmp/ak435-unit.log; status=${PIPESTATUS[0]}; if rg -n 'fatal: Unable to hash' /tmp/ak435-unit.log; th...` |
| 1.30m | judge | ak-pi-workflow-roles | `01a02f80-598a-712d-98ec-f0772dbc3a29` | `pnpm test:integration` |
| 1.30m | judge | ak-pi-workflow-roles | `01a02f80-598a-712d-98ec-f0772dbc3a29` | `pnpm test` |
| 54.3s | reviewer | Ming_LLM | `01a0343c-4e0a-7028-aad8-e5ba5df5c820` | `if [ -f web/package.json ]; then cd web && npm test -- --run; else echo no-web-package; fi` |
| 12.8s | judge | ak-pi-workflow-roles | `01a02f4f-6bb1-72fa-a3e4-c1fb98c1c619` | `npm run typecheck && node --import tsx --test --test-name-pattern='coder (plan\|apply unfinished\|completed submissions)' test/contract/judge-...` |
| 9.8s | judge | Ming_LLM | `01a03445-aaed-7a41-a4ea-28938443223b` | `if [ -d web/node_modules ]; then cd web && npm test -- --run && npm run build; else echo 'NO_WEB_NODE_MODULES'; fi` |
| 9.5s | reviewer | ak-pi-workflow-roles | `01a02f52-4ca6-7256-982d-f6ab4997496d` | `git diff --check 05db4136...HEAD && npm test -- --test-name-pattern='coder completed submissions traverse\|coder apply binds completion\|coder...` |
| 9.4s | judge | ak-pi-workflow-roles | `01a02f3f-4931-79b0-bb9b-278e8de4191b` | `npm test` |
| 8.9s | judge | ak-pi-workflow-roles | `01a02f23-e70e-7c1b-9e36-a43d4e7f83e6` | `npm test` |
| 8.4s | judge | ak-pi-workflow-roles | `01a02f71-67b6-70cd-8072-9714c2b3876b` | `pnpm test` |
| 8.3s | reviewer | ak-pi-workflow-roles | `01a02f93-e2d4-7298-bcdb-151858e83d8d` | `pnpm test` |
| 8.1s | judge | ak-pi-workflow-roles | `01a02f6c-e6e3-7681-88f4-6009cc292bed` | `pnpm test` |
| 7.8s | reviewer | Ming_LLM | `01a0325f-063e-7eb5-86c0-5b52a1c1c342` | `cd web && npm test -- --run` |
| 5.2s | judge | Ming_LLM | `01a03440-589b-7bd9-b6d9-e574201de3ae` | `cd web && if [ -d node_modules ]; then npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx && npm run build; else ...` |
| 5.2s | reviewer | Ming_LLM | `01a03439-5fb3-793b-89b0-435dde07c68d` | `cd web && npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx && npm run build` |
| 3.9s | judge | Ming_LLM | `01a03266-7502-76cc-9bee-d4ad851be1a4` | `cd web && npm test -- --run src/components/drawers.test.tsx src/components/map.test.tsx` |
| 1.8s | reviewer | Ming_LLM | `01a0325f-063e-7eb5-86c0-5b52a1c1c342` | `npm test -- --run && npm run build` |

### 官卷 bash 取证密度（样本：闸轮最多的腿）

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
| 官耗时 Σ（gate-cycles） | 10.20m | 51.8% |
| 父腿 test suite bash Σ | 0ms（0 次） | 0.0% |
| 官卷 bash 次数 Σ / 轮均 | 101 / 14.4 | — |

### 逐轮闸循环

| round | officer | status | officerWall | findingsCount |
| ---: | --- | --- | ---: | ---: |
| 1 | notary | bounce | 1.42m | 3 |
| 2 | notary | bounce | 59.6s | 1 |
| 3 | notary | bounce | 1.08m | 1 |
| 4 | notary | bounce | 1.65m | 1 |
| 5 | notary | pass | 1.33m | 0 |
| 6 | notary | bounce | 2.24m | 1 |
| 7 | notary | pass | 1.49m | 0 |

### 逐轮官 bash 次数（与上表 round 序未必一一，按官卷时间序）

| officerVolume# | bashCount |
| ---: | ---: |
| 1 | 19 |
| 2 | 14 |
| 3 | 8 |
| 4 | 11 |
| 5 | 10 |
| 6 | 22 |
| 7 | 17 |

### 归因（可核账）

1. **闸循环本身是主放大器**：7 轮 paired 官会话，官耗时合计 10.20m，约占腿墙钟 51.8%。bounce×5 / pass×2。
2. **两桶**：工具桶 14.77m vs 模型桶 4.93m——工具侧已是显著份额（75.0%），不是「纯模型思考」账。
3. **父腿全量测试**：本焦点腿观测到 0 次 suite 匹配 bash，墙钟 0ms。OWNER 手扒线索「判官单轮自跑 test:all 两次约占 10 分钟」在**本完整日历日全局**核：test:all 共 6 次、次均 2.36m、合计约 14.16m；本焦点腿未自带 suite，10 分钟级账不是每个多轮闸腿的固定税。
4. **官取证密度**：本腿官卷 bash 轮均 14.4 次（OWNER 手扒 ~19 次/轮；本腿 per-round 见上表，首轮 19 与线索同阶）。
5. **合成解释**：一轮「小问题」一旦进入多轮封驳，成本 ≈ Σ(官取证墙钟) + 父腿模型/工具间隙 +（若触发）全量测试墙钟；7 轮把单轮官成本乘上去，就到 ~20 分钟量级（本腿 19.71m）。

## 完整日历日全局：两桶与闸的关系

- 腿墙钟 3357.27m 中，工具桶 44.8%、模型桶 55.2%。
- 官耗时合计 155.66m 是闸循环子会话墙钟，嵌在父腿墙钟内，**不可与父腿墙钟简单相加**；它回答的是「官审本身吃掉多少」。
- 父腿 suite bash 合计 37.66m / 28 次；其中 test:all 6 次、次均 2.36m。OWNER「两次全量 ~10 分钟」在当日本机实测次均约 2.36m 时，两次约 4.72m——同阶但低于 10 分钟口述（suite 变快或口述含其它开销）。
- 腿墙钟 top 出现 ~6h 级 outlier（`01a02fca-…` / `01a02fce-…`）：均为 terminal 态可读腿的 frame-span 墙钟，计入全日合计；它们不是闸循环主因（闸 top 仍由多轮 notary 腿主导）。

## 复算入口

```bash
# 1) 目录总体：枚举 ~/.ak-roles/books/*/runs/*@{judge,reviewer}
#    过滤 runId UUIDv7 ∈ [JST dayStart, JST dayEnd) = [2026-08-23T15:00:00.000Z, 2026-08-24T15:00:00.000Z)
# 2) 互斥分类：readable | unreadable | live | missing_invocation | corrupt_invocation | stale_unprojected
# 3) 仅 readable → family.contribute
# 全簿 issue 页（含 gateCycles / legWallClock / b2FrameBucketsActions）
ak-role analyst   # cwd = 对应 git 仓；book = git common-dir
```

本报告数字 = 上表 asOf 冻结下的**完整已结束 JST 日历日**目录总体对账 + readable 子集上的既有 Analyst 指标族；**无新生产扫描、无写端、无永久 probe**。

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
  "totalLegWallMs": 201436185,
  "totalToolBucketMs": 90274955,
  "totalModelBucketMs": 111161230,
  "suiteBashCount": 28,
  "suiteBashWallMs": 2259501,
  "testAllCount": 6,
  "testAllMeanWallMs": 141647,
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
    "rounds": [
      {
        "roundIndex": 1,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 85079,
        "findingsCount": 3
      },
      {
        "roundIndex": 2,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 59619,
        "findingsCount": 1
      },
      {
        "roundIndex": 3,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 64915,
        "findingsCount": 1
      },
      {
        "roundIndex": 4,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 99198,
        "findingsCount": 1
      },
      {
        "roundIndex": 5,
        "officer": "notary",
        "status": "pass",
        "officerWallMs": 79648,
        "findingsCount": 0
      },
      {
        "roundIndex": 6,
        "officer": "notary",
        "status": "bounce",
        "officerWallMs": 134137,
        "findingsCount": 1
      },
      {
        "roundIndex": 7,
        "officer": "notary",
        "status": "pass",
        "officerWallMs": 89582,
        "findingsCount": 0
      }
    ],
    "suiteBash": [],
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
      "officerWallMs": 1810567
    },
    {
      "runId": "01a031bd-7a9a-79ec-aed3-e340bf46c419",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 13,
      "officerWallMs": 1001568
    },
    {
      "runId": "01a0341a-c88c-77db-9f8c-c7d3e7466265",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 9,
      "officerWallMs": 998819
    },
    {
      "runId": "01a032bc-69d4-74ab-9c6b-861bbaa2e3cb",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 7,
      "officerWallMs": 684347
    },
    {
      "runId": "01a031ff-92c5-78e8-ad25-7ca0d346dd8b",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 7,
      "officerWallMs": 612178
    },
    {
      "runId": "01a031e1-31c9-79b5-b9ef-cda423cc48ea",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 7,
      "officerWallMs": 578701
    },
    {
      "runId": "01a032f6-0b0d-7a6f-8f5f-64bb5937d610",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 6,
      "officerWallMs": 660652
    },
    {
      "runId": "01a0322e-d065-7d9b-a247-bd279f137934",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 5,
      "officerWallMs": 818638
    },
    {
      "runId": "01a033f6-8225-7bde-b1c6-7c87524870be",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 4,
      "officerWallMs": 554511
    },
    {
      "runId": "01a0340f-9bca-7095-af4c-99d8bf57b41a",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 4,
      "officerWallMs": 251584
    },
    {
      "runId": "01a033b2-4a31-77cf-b308-b4a241ce26bb",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 3,
      "officerWallMs": 282842
    },
    {
      "runId": "01a03254-06a1-762b-b906-0a8eb62ce62f",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 2,
      "officerWallMs": 290894
    },
    {
      "runId": "01a0335f-b56a-7914-94c3-dbac27878c84",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 2,
      "officerWallMs": 171264
    },
    {
      "runId": "01a031b0-a126-7dd0-8466-8e7de82995dc",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 2,
      "officerWallMs": 105810
    },
    {
      "runId": "01a03395-c513-72c6-a2b4-e7ef888a475b",
      "role": "judge",
      "book": "ak-pi-workflow-roles",
      "roundCount": 2,
      "officerWallMs": 97214
    }
  ],
  "officerBashSampleMean": 13.722958892958893,
  "officerBashSampleN": 15
}
```
