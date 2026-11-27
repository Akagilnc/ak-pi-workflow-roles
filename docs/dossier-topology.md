# 卷宗拓扑

Status: accepted design（issue [#852](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/852)；本页由子票 #862 建立；一条腿的形状由 [#1161](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/1161) 重写，包自己的记录由 [#1300](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/1300) 并成一份账）

本页是**簿以下路径形状与每个文件内容的唯一真源**。候簿之家与分簿键仍由 [ADR 0048](adr/0048-ledger-one-home-many-books-dirname-key-git-only.md) 定义；记录归司天台、经唯一入口落盘仍由 [ADR 0065](adr/0065-sitian-phase-two-records-have-one-entry.md) 定义；宿主原件的复制由 [ADR 0086](adr/0086-host-dossier-is-native-file-copy-sitian-append-only.md) 定义。其他 ADR 涉及簿以下路径时只引用本页，不复述路径。

## 形状

```text
~/.ak-roles/
└── books/<book-key>/
    ├── <ticket>/
    │   ├── records.jsonl                    起居录：陛下原话加源卷指针，一票一份，只追加
    │   ├── current.jsonl                    本票进度：每收下一份交卷一行，只追加（ADR 0088）
    │   └── runs/<runId>@<role>/
    │       ├── receipts/<n>.json            回执原件：本腿第 n 份交卷，原样一份
    │       ├── session/                     宿主原件（见下）
    │       └── state.jsonl                  包自己的账：一腿一份，只追加
    ├── unbound/
    │   └── runs/<runId>@<role>/             同上形状
    └── collector-handbook/
```

票级 `current.jsonl`、腿内 `receipts/` 与「腿目录留三样：会话、回执、一份包自己的账」由 [ADR 0088](adr/0088-ticket-current-replaces-run-dossiers.md) 定。

簿根只有三类项：

1. `<ticket>/`：以票号命名的票目录；该票起居录及全部腿均在其中。
2. `unbound/`：确实无票或尚未取得 typed 票身份的腿；腿形状与票下相同。
3. `collector-handbook/`：仓库级通进司手册。

（#1178 起不再在簿根建 `navigator/<work-subject>/` 旁支；游奕使建议与运行事实只在其 `@navigator` run 卷宗。存量旁支目录不自动删除。）

归属判据是：删除一张票后仍有意义的记录才留在票外。属于某票的材料均落在该票目录；属于某条腿的记录均落在该腿的 run 目录，不在簿根另设 kind 分区。首次入票的识别腿先落 `unbound/runs/`，取得 typed 票身份（起居郎认票断言、报票号工具 `ak_report_ticket`，或未绑定工作席 typed 回执自报）后整体归位至 `<ticket>/runs/`，不设第五类顶层项。

## 一条腿的三项（一份账、回执、宿主原件）

每腿不再有渲染页 `current.json`（#1299）。公开调用读自己的事实时读行，每类取最后一行。

### `state.jsonl`——包自己的账

只追加，经司天台 appender 唯一入口；本腿 session 名下的记录，除已报票号的起居录行进票目录 `records.jsonl` 外，都落这一份，每行带自己的 `kind`，读者整份读进来按 `kind` 取。没报票号的腿同此。

原身份、受理、运行状态、终局这四样，每被整份改写一次追加一行，内容就是那一份，最后一条是当前的：

| 行 | 内容 |
| --- | --- |
| `invocation` | 这条腿是谁：席、宿主、模型、档位、项目根、票号、关联号、起跑时的 pi／角色包版本 |
| `admitted-request` | 受理时的请求：指令、附件、各席特有输入，及传召的上游腿指针 |
| `run-state` | 腿的生命周期（admitted／running／resumable／terminal）、开着的庭 |
| `terminal` | `{face, at, body}`；`face` 只有 `error`（受控失败，`body` 带宿主 stderr 原样）与 `no_receipt`（无卷，#836）。收下交卷不写终局行：收下的事实在回执与票级进度行（#1299）。同一腿可有多条，被自动续跑重试掉的那次也在；有庭号时带 `courtAttemptId` |
| `host-session-id` | 宿主会话绑定，按宿主分格（续跑要用它） |

其余各类：

- 交卷：`candidate`、`outcome`、`sealed`、`post-seal-anomaly`。
- `progress`：本腿每写下一行进度（封存时、报号归位补轮时）追加一行，带那一行的 `round` 与 `receipt` 引用（封存行另带 `toolCallId`）。结算读它给终局报票、席、轮与回执，不在回合结束后回读票级 `current.jsonl`（#1201）。没报票号的腿封存时 `round` 为空，这一行另带整行进度（`line`），就是它的暂存；报号归位时补轮、并入票级 `current.jsonl`，再追加一行带轮号的 `progress`。同一 `receipt` 只发布一次。
- `ticket-provenance`：没报票号的腿的起居录行先落这里，报号归位后进票目录 `records.jsonl`。
- worker 交卷闸跨续跑状态（#1178）：`commit-baseline`（提交基线）、`commit-reminder-bounce` / `prefix-reminder-bounce`（已提醒过一次）、`unfinished-reason-bounce`（缺理由催办，带 `invocationScopeId`）。续跑与票号归位后按各类最新一行（催办按当前调用计数）恢复。
- `officer-pointer`：历史闸传召指针行（只读档案）。生产不再新写（#1195）。
- 诊断：`host-session`（宿主原件复制两次都失败时的 warning，带宿主原件路径；Codex 找不到 rollout 时为 CLI 的 sessions 目录与会话 id）、`dispatch-exception`（一次抛异常的派发的完整异常）、`gate`、`engine-detour-call`、`post-admission-diagnostic`、`resume-diagnostic` 等。

写失败的处置按记录种类定，在各调用者里：受理、状态、交卷这几类写不进，如实失败并报真因；交卷已收下之后的运行状态写不进，收下的终局不变，真因记在本腿会话并报给调用者；诊断行与复制 warning 行写不进，不改终局、申报一次。

一行坏记录或整份读不了时，续跑这条腿、调用者以 `--source-run` 传召审官审这条腿，都在受理时如实失败。本腿当次调用交卷后整份读不了，以失败终局报出真因，到达的原件留着。已受理的审官续跑时被审腿的账整份读不了，审官照常运行，真因记在审官自己的会话。

默认续跑挑同票同席最近活动的那条腿，看的是这份账的修改时间：任何一种记录写入都算活动。

### 宿主原件

不编号，退出时覆盖同名文件（ADR 0086）：

- pi：`session/session.jsonl`，pi 直落。
- codex、claude：`session/<host>.jsonl`，单文件。
- grok：`session/grok-build/` 目录（`chat_history.jsonl`、`usage.json`）。
- hermes：原件在 sqlite，沿 ADR 0086 既有边界暂不覆盖，回执与账照常。

headless／ACP 腿的 `session/session.jsonl` 另有包自己写的交卷闭合、无卷生命周期事实、导航员到场等 custom entry（pi 格式），settlement 与太史读它；它与宿主原件同在 `session/`。

## 读法

- 审读席读本票 `records.jsonl`、票级 `current.jsonl`、被审腿 `receipts/`。成功腿的结论只在回执里。
- 身份（宿主、模型、档位）在被审腿 `state.jsonl` 的 `invocation` 行；出错或无卷在同一文件的 `terminal` 行。各取最后一条。
- 御史台另读被审腿宿主原件，只 grep 工具调用。
- `state.jsonl` 里的交卷行只在争议涉及早先轮次时读；诊断行查故障才翻。

## 经陛下允许多出来的项

陛下 2026-10-03 逐字：「允许多出来」（本票施工会话，源卷 `~/.claude/projects/-Users-akagilnc-WorkSpace-worktree-roles-1161/6d409146-5717-4ff6-83cf-728f50533a24.jsonl`，对施工者列出的这三样的答复）。run 目录里上述三项之外保留：

- `session/session.jsonl`（headless／ACP 腿包自己写的那份）：太史取帧起止与工具区间（`analyst-ledger`）、票轨迹（`ticket-trajectory`）、起居郎取原生会话区间（`ticket-provenance`）、settlement 取无卷生命周期事实与导航员到场都读它。
- 各席受理时写入的输入，在 run 目录顶层：`merger-input.json`（校书郎 git 事实），席位运行时按路径读取。`--attach`、修内司 `--prerequisites` 与通进司 `--request-manifest` 只在受理记录里留下调用方原路径，不在腿目录落抄件；修内司／将作监派单文只作第一句话，不写 `fix-packet.md`／`task.md`（#1165、#1168）。

（#1178 起 `session/worker-submission-gate/` 与簿根 `navigator/<hash>/` 旁支均不再创建或读取；闸状态见上节 `state.jsonl`。）

## 边界

- 本页只定义 `books/<book-key>/` 以下拓扑，不改变 ADR 0048 的家、簿、分簿键与 session 直写原则。
- 票身份来自起居郎认票断言、报票号工具 `ak_report_ticket`，或未绑定工作席 typed 回执中的票号自报；路径代码不从自然语言重判票号。
- 落盘调用方不选择目的地；唯一记录入口依身份和 run 所有权计算上述路径。
- 太史分析目录不在本拓扑射程。
- 存量卷宗不迁移：#1161 之前的 run 目录（十六个文件、逐次副本）不被读取，旧文件名在代码中不再被写入或读取。#1300 之前写下的腿（`history.jsonl`／`log.jsonl`／`progress.jsonl`）升级后不支持，包不检测；要续另起新腿。
