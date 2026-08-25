# 2026-08-26 游奕使（navigator）指路质量诊断（#464）

> 票庭 converged 后开工；本报告只建立可归因证据与病根 class，不施工、不修 Navigator、不建太史机制、不清理垃圾簿。
> 统计 regime：对已冻结卷宗做机械枚举 + 报告层语义分类；引证为卷宗指针（runId / invocationId / session 路径 / custom entry id）；不誊 advice 原文进逐条账。

## 取数口径（闭合）

| 项 | 值 |
| --- | --- |
| asOf（冻结时刻） | `2026-08-25T15:37:43Z` |
| **主样本窗** | `[0.1.2310 publish 2026-08-25T08:30:56.194Z, asOf)` |
| 入总体判据 | 簿 `ak-pi-workflow-roles`、`Ming_LLM` 下 `runs/<runId>@<role>` 目录存在，且 runId UUIDv7 嵌入时间 ∈ 主样本窗 |
| 分析单位 | **每次角色 run 的终局 navigator 出席**（role session 内 `timestamp < asOf` 的最后一条 `customType=ak-navigator-attendance`） |
| 出席冻结 | 只认 attendance `timestamp < asOf`；asOf 及之后写入的出席**不入**冻结账（不得用事后 run-state / 事后出席倒装） |
| 「有话可说」 | `details.disposition === "recommendation"`（带 `next`） |
| 对错分类对象 | 仅 recommendation；no-advice / unavailable 另立通道 class，不计入对错分母 |
| 采纳定义 | 同 `subjectKey` 时间序上下一次角色 run 的 `role`（及 advice 声明的 `phase`，若有）与 `next` 一致 |
| 对错判据真源 | `souls/navigator.md`；`resources/navigator-route-playbook.md`；当前 run 的 typed 结算（`judgeStatus` / coder·fixer `status` / phase marker） |
| asOf 后新增 run | **不入主分母** |
| asOf 后才写入的出席 | **不入** readable_attendance；该 run 记入 `live_no_attendance`（窗内有 session、冻结前无出席） |

### 对错判据（申报，可重算）

| verdict | 条件（互斥 primary） |
| --- | --- |
| `correct` | next 与 playbook/soul 在**本轮结算之后**的最低成本安全接力一致（例：judge `continue`→劳动 plan/apply；judge `converged`→merger 或合法开工；fixer `planned`→judge；fixer/coder `completed`→judge/reviewer 按条线；unfinished→同 worker apply） |
| `wrong / misread_settlement_continue_as_merge` | judge `continue` 却指 `merger`（soul：合并只在本轮材料**收敛**后） |
| `wrong / overreach_internal_gate` | 把 `notary` 指成调用者下一步（notary 是闸内见证席；playbook 收敛后是调用者合并/关票，修内司完成后是回大理寺） |
| `wrong / wrong_next_seat` | 条线座次错误（例：fixer apply 完成→reviewer；修内司条线应回 judge） |
| `wrong / skip_required_review` | fixer `planned` 直接 `fixer apply`，跳过方案复审 |
| 不评对错 | `no-advice` / `unavailable` / live 未出席（见通道 class） |

采纳≠正确：调用者可忽略建议（ADR 0061）；本窗 **错误建议采纳率 = 0**。

## ① 指路真实落点与 advice↔run 归因链

### 落点（坐实）

| 层 | 落点 | 是否 durable | 形状 |
| --- | --- | --- | --- |
| **角色 run 卷宗（主归因面）** | `books/<book>/runs/<runId>@<role>/session/session.jsonl` 内 `type=custom_message` + `customType=ak-navigator-attendance` | 是 | `details` = typed `NavigatorEvent`（`disposition` / `next` / `reason` / `command` / `invocationId` / `subjectKey`…）；`content` = 人读摘要 |
| Navigator 子会话 | `books/<book>/navigator/<sha256(subjectKey)[:32]>/…jsonl` | 是 | `parentSession` → 角色 session；`ak-navigator-invocation` / `ak-navigator-context` / `ak-navigator-prepare` toolCall / `ak-navigator-settlement` / `ak-navigator-route` |
| 角色 session 调用标记 | 同 run session 内 `customType=ak-navigator-invocation` | 是 | `{ invocationId, role, phase, subjectKey }` |
| 公共 Terminal（stdout 回执） | 进程退出时 typed `TerminalResult.navigator` | **默认不落 report 面** | `disposition` / `next` / `command` 等（`formatTerminalResult`） |
| `artifacts/report.json` | 仅 `role` / `runId` / `outcome`（± phase/receipt） | 是 | **无 navigator 字段** |
| `run-state.json` | lifecycle 坐标 | 是 | **无 navigator 字段** |

票面底数「指路不落所属 run 卷宗」**需修正**：advice **落在所属 run 的 session.jsonl**（`ak-navigator-attendance.details`），不落 `report.json` / `run-state.json`。可观测性缺口是 **报告面/索引面缺少 typed navigator**，不是卷宗零字节。

### 归因链（可核）

```
role runId
  └─ session.jsonl
       ├─ ak-navigator-invocation.invocationId  ──┐
       └─ ak-navigator-attendance.details          │  equality
            ├─ invocationId  <─────────────────────┘
            ├─ subjectKey
            ├─ disposition / next / reason / command
            └─ （子会话）books/<book>/navigator/<hash(subjectKey)>/*
                 └─ session.parentSession = 该 role session 路径
```

代表性指针：

- recommendation：`~/.ak-roles/books/ak-pi-workflow-roles/runs/01a03984-622d-7bf2-bc58-571bf08b8d59@judge/session/session.jsonl` entry id `d8234582`（`invocationId=01a03984-6788-72f6-a567-eea7da493102`，`next=coder/plan`）
- 子会话 parent：`…/navigator/1b9fd7bd1a834fb6b8d1063fd55005a7/2026-08-25T15-13-16-068Z_01a0397b-9724-7586-82a4-50c0f99bb6f3.jsonl` → `parentSession=…/01a0397b-8ff6-71b5-8eae-f47a1752475e@judge/session/session.jsonl`

## ② 目录总体与指路统计

### 守恒

| 类别 | 定义 | ak-pi-workflow-roles | Ming_LLM | 合计 |
| --- | --- | ---: | ---: | ---: |
| **directoryTotal** | 窗内 run 目录（runId 时间 ∈ 主样本窗） | 22 | 73 | **95** |
| readable_attendance | 有 `timestamp < asOf` 的终局 `ak-navigator-attendance` | 20 | 69 | **89** |
| live_no_attendance | 有 session，但 asOf 前无出席（事后才写入的出席不计入） | 2 | 3 | 5 |
| missing_session | 无 session.jsonl | 0 | 1 | 1 |

```
95 = 89 (attendance) + 5 (live_no_attendance) + 1 (missing_session)
```

重枚举相对初稿 +1 目录：Ming_LLM `01a03991-06fe-7213-8283-bb5d84d48046@collector`（run 时间 `15:36:40.958Z`、attendance `90996931` 于 `15:37:01.583Z`，均 `< asOf`，`unavailable`/context ENOENT）。live / missing **不入**对错与采纳分母。

### 出席 disposition（readable_attendance = 89）

| disposition | ak-pi | Ming | 合计 | 占 attendance |
| --- | ---: | ---: | ---: | ---: |
| `recommendation` | 5 | 39 | **44** | 49.4% |
| `no-advice` | 13 | 4 | **17** | 19.1% |
| `unavailable` | 2 | 26 | **28** | 31.5% |
| `arrival` | 0 | 0 | 0 | 0% |

### 指路对错（仅 recommendation n=44）

| verdict | 数 | 占 recommendation | 备注 |
| --- | ---: | ---: | --- |
| `correct` | **34** | **77.3%** | ak-pi 5/5；Ming 29/39 |
| `wrong` | **10** | **22.7%** | 全部在 Ming_LLM |
| 错误率（wrong/recommendation） | | **22.7%** | 分母=有话可说=44 |
| 若以两簿全部 attendance 为分母 | 10/89 | 11.2% | 含通道沉默/失败，**不**作主错误率 |

按簿：

| 簿 | recommendation | wrong | 错误率 |
| --- | ---: | ---: | ---: |
| ak-pi-workflow-roles | 5 | 0 | 0% |
| Ming_LLM | 39 | 10 | **25.6%** |

### 采纳（recommendation 中存在同 subject 后续 run 的 43 条）

| 集合 | 采纳 | 分母 | 率 |
| --- | ---: | ---: | ---: |
| 全部 recommendation（可观察后续） | 22 | 43 | 51.2% |
| verdict=correct | 22 | 34 | 64.7% |
| verdict=wrong | **0** | 9 | **0%** |

观察：本窗调用者**全部拒绝**了被判 wrong 的建议；错误伤害主要是噪音与误导成本，不是已被自动执行的错误路由。

## ③ 病根 class（互斥 primary + 通道类）

### A. 方向错误（仅 recommendation wrong = 10）

| primary-root | 数 | 定义 | 代表性指针 |
| --- | ---: | --- | --- |
| `misread_settlement_continue_as_merge` | **4** | judge `continue`→`merger`；与 soul「合并只在收敛后」冲突 | run `01a038b6-0449-7a71-8c21-2f9cc99b9077` @judge，attendance id `439af998`，inv `01a038b6-0825-73b5-a672-5ce7ce209704`；同族 `01a038d7-…` / `01a038ea-…` / `01a038f5-…`（皆 Ming `ming-w5-642` 线） |
| `overreach_internal_gate` | **4** | 指 `notary` 为调用者下一步 | run `01a0384c-5f12-7230-92df-1e2342d19678` @judge，id `05cbfbe9`，inv `01a0384c-6202-7e04-af40-014ab4f99bd8`（converged→notary）；fixer 完成例 `01a03975-020f-74db-9b9c-650850490cf7` |
| `wrong_next_seat` | **1** | fixer apply 完成→reviewer（条线应回 judge） | run `01a03882-79f8-7138-98cf-e80273921745` @fixer，inv `01a03882-7de7-7653-aef0-a0a214834887` |
| `skip_required_review` | **1** | fixer `planned`→`fixer apply` 跳过复审 | run `01a03849-e9ae-7349-9775-b42ffd3e590b` @fixer plan，inv `01a03849-ed75-7ee7-a0b0-a11895d98500`；实际下一 run 为 judge |

与历史同族：`docs/research/issue-224-navigator-stale-prepare.md` 已记「旧 converged 盖新材料 → 误指 merger」。本窗 4 条是 **`continue` 被读成可合并**（非仅 stale prior），属同一「结算语义误读」家族的现窗表现；当前树 `selectNavigatorCandidate` 有 stale-context 重绑，**未见**硬表禁止 `continue→merger`。

### B. 通道 / 出席失败（不计入对错分母）

| class | 数 | 定义 | 代表性指针 |
| --- | ---: | --- | --- |
| `channel_post_role_grace` | **21** | `unavailableReason=Navigator exceeded post-role delivery grace`（grace=10s，`NAVIGATOR_POST_ROLE_GRACE_MS`）；`invocationId` 常为字面 `post-role-grace-timeout` | Ming 例 run `01a0384d-86cc-704d-9466-833c03643fc5` @judge；ak-pi 窗内例 `01a0398b-83af-77bc-8c6b-dc656a96babe` @judge |
| `channel_provider_failure` | **5** | `unavailableReason=Navigator provider failure`（`unavailableSource=transport`） | ak-pi `01a03867-783a-7770-81f2-c99a9eb64010` @coder；Ming `01a03852-2e47-7d4c-8429-a670b60fb2dc` |
| `channel_context_enoent` | **2** | 工作树路径 ENOENT（context） | Ming collector `01a03894-33ac-71d7-b0d7-66da8efc012d`；同族 `01a03991-06fe-7213-8283-bb5d84d48046@collector` attendance `90996931` |
| `prepare_no_receipt_bloated_subject_session` | **12** | 长期 subject 会话上 marker+settlement 之间 **0 次** `ak_navigator_prepare`，写入 `ak-no-receipt-lifecycle`（`deliveryTurns=2`）后 affirmative `no-advice`；结算本为 continue/converged/completed，**本应有话可说** | subject=`/Users/akagilnc/WorkSpace/ak-pi-workflow-roles/.ak/work`；navigator 卷 `…/navigator/5f99adac8f6c7b2f0073cffb259d78a8/2026-08-10T02-07-16-161Z_019fe96c-….jsonl`（~8.1MB，408 invocations，100 no-receipt）；角色例 run `01a038e3-b0c2-7808-a7b4-a429569588c3` @judge attendance id `f221269c` |
| `lawful_human_no_advice` | **5** | `human_decision`（escalate / reviewer refused 等）→ 合同型 `no-advice` | ak-pi `01a0397e-854b-7eac-8fd6-f55b8289e1ac`（本票上抛庭）；Ming escalate `01a03979-f37f-7dea-be0b-dfc4d9a1f90d` |

### C. 可观测性缺口（独立 finding，已坐实）

| finding | 事实 | 后果 |
| --- | --- | --- |
| `F-obs-report-surface` | `artifacts/report.json` 与 `run-state.json` **无** navigator 字段；stdout Terminal 有 typed navigator 但不作档案真源 | 不打开 session.jsonl 无法按 run 索引 advice；与票面「难抽样」体感一致 |
| （非缺口）session 出席 | `ak-navigator-attendance.details` 已是 typed 真源 | 诊断与回归应以 session 为准，勿再断言「完全不落卷」 |

## ④ 684 个 `navigator-native-model-*` 簿：生成机制（只查明）

| 项 | 事实 |
| --- | --- |
| 计数（asOf） | **684** 个 `~/.ak-roles/books/navigator-native-model-*` |
| 内容 | 仅 `navigator/<hash>/…jsonl`；**无** `parentSession`；`cwd` 均在 `mkdtemp` 临时目录 |
| 生成者 | **契约测试** `test/contract/navigator-attendance.test.ts`：`mkdtemp(join(tmpdir(), "navigator-native-model-"))` + `seedGitRepository` |
| 落簿机制 | 子会话经 Archivist `resolveBookKeyFromGit(cwd)` → bookKey = **git 宿主目录 basename** = 临时目录名 `navigator-native-model-XXXX`，写入真实 ledger home |
| 时间跨度 | 约 2026-08-13 … 2026-08-25；窗内新增 51 |
| 是否生产 navigator 每次自开一本 | **否**。生产出席落在**角色所属 book** 的 `navigator/<subjectHash>/`（或角色 session 出席），不按 native model 另开 book |
| 清理/收口 | **本票不修**；留后票（测试隔离 ledger home / 或禁止测例写入用户 home） |

## 诊断结论（供后续修法票，不施工）

1. **主错误率（有话可说）= 10/44 = 22.7%**，全集中在 Ming_LLM；ak-pi 窗内 5 条 recommendation 全对。  
2. **最大错误头是结算语义**：`continue→merger`（4）+ 把闸内 `notary` 当下一步（4）= 8/10。与 #224 家族同向，但是 **continue/角色座次** 误读，不是唯一 stale-prior 形态。  
3. **通道噪声更大**：28 unavailable 中 21 条 post-role 10s grace，2 条 context ENOENT；另 12 条主仓长期 subject 会话 prepare no-receipt → 假性 `no-advice`，使「该指路时沉默」在 ak-pi 主工作树尤其严重（13 no-advice 中 12 条此类）。  
4. **错误建议本窗 0 采纳** → 质量问题首先是可信度与操作成本，不是已被盲从的错误自动路由。  
5. **可观测性**：advice 已在 run session typed 落盘；缺的是 report/run-state 索引面。修法票若做度量，应读 `ak-navigator-attendance.details`，或另立显式投影（须单独授权）。  
6. **684 native-model 簿是测试污染**，不是生产每次开簿；清理归后票。

**本报告零生产代码、零测试、零太史机制、零簿清理。**

## 机器摘要（可核）

```json
{
  "ticket": 464,
  "asOf": "2026-08-25T15:37:43Z",
  "window": {
    "startInclusive": "2026-08-25T08:30:56.194Z",
    "endExclusive": "2026-08-25T15:37:43Z",
    "label": "npm-0.1.2310-publish..asOf"
  },
  "books": ["ak-pi-workflow-roles", "Ming_LLM"],
  "population": {
    "directoryTotal": 95,
    "byBook": { "ak-pi-workflow-roles": 22, "Ming_LLM": 73 },
    "attendance": 89,
    "liveNoAttendance": 5,
    "missingSession": 1,
    "conservation": "95=89+5+1",
    "attendanceFreeze": "last ak-navigator-attendance with timestamp < asOf",
    "enumerationNote": "includes Ming_LLM 01a03991-06fe-7213-8283-bb5d84d48046@collector (omitted in first draft)"
  },
  "disposition": {
    "recommendation": 44,
    "no-advice": 17,
    "unavailable": 28,
    "arrival": 0
  },
  "recommendationQuality": {
    "correct": 34,
    "wrong": 10,
    "errorRate": 0.227,
    "byBook": {
      "ak-pi-workflow-roles": { "n": 5, "wrong": 0, "errorRate": 0 },
      "Ming_LLM": { "n": 39, "wrong": 10, "errorRate": 0.256 }
    }
  },
  "adoption": {
    "observableDenominator": 43,
    "adopted": 22,
    "adoptedGivenCorrect": { "n": 22, "den": 34 },
    "adoptedGivenWrong": { "n": 0, "den": 9 }
  },
  "wrongPrimaryRoot": {
    "misread_settlement_continue_as_merge": 4,
    "overreach_internal_gate": 4,
    "wrong_next_seat": 1,
    "skip_required_review": 1
  },
  "channelClasses": {
    "post_role_grace": 21,
    "provider_failure": 5,
    "context_enoent": 2,
    "prepare_no_receipt_bloated_subject_session": 12,
    "lawful_human_no_advice": 5
  },
  "landing": {
    "roleSessionAttendance": "custom_message:ak-navigator-attendance.details",
    "navigatorChildSession": "books/<book>/navigator/<subjectHash>/",
    "reportJsonHasNavigator": false,
    "runStateHasNavigator": false
  },
  "nativeModelBooks": {
    "count": 684,
    "mechanism": "test-mkdtemp-git-basename-bookKey",
    "productionPerCallBook": false,
    "cleanup": "deferred"
  },
  "findings": ["F-obs-report-surface"],
  "reduction": "deferred-to-follow-up-tickets"
}
```
