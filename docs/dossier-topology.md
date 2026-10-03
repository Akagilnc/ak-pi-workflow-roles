# 卷宗拓扑

Status: accepted design（issue [#852](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/852)；本页由子票 #862 建立；一条腿四个文件的形状由 [#1161](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/1161) 重写）

本页是**簿以下路径形状与每个文件内容的唯一真源**。候簿之家与分簿键仍由 [ADR 0048](adr/0048-ledger-one-home-many-books-dirname-key-git-only.md) 定义；记录归司天台、经唯一入口落盘仍由 [ADR 0065](adr/0065-sitian-phase-two-records-have-one-entry.md) 定义；宿主原件的复制由 [ADR 0086](adr/0086-host-dossier-is-native-file-copy-sitian-append-only.md) 定义。其他 ADR 涉及簿以下路径时只引用本页，不复述路径。

## 形状

```text
~/.ak-roles/
└── books/<book-key>/
    ├── <ticket>/
    │   ├── records.jsonl                    起居录：陛下原话加源卷指针，一票一份，只追加
    │   └── runs/<runId>@<role>/
    │       ├── current.json                 当前（整文件重写）
    │       ├── history.jsonl                历史（只追加）
    │       ├── log.jsonl                    司天台流水（只追加）
    │       ├── session/                     宿主原件（见下）
    │       └── attachments/                 有附件时才有
    ├── unbound/
    │   └── runs/<runId>@<role>/             同上形状
    ├── navigator/<work-subject>/
    └── collector-handbook/
```

簿根只有四类项：

1. `<ticket>/`：以票号命名的票目录；该票起居录及全部腿均在其中。
2. `unbound/`：确实无票或尚未取得 typed 票身份的腿；腿形状与票下相同。
3. `navigator/`：游奕使跨票工作主体记录。
4. `collector-handbook/`：仓库级通进司手册。

归属判据是：删除一张票后仍有意义的记录才留在票外。属于某票的材料均落在该票目录；属于某条腿的记录均落在该腿的 run 目录，不在簿根另设 kind 分区。首次入票的识别腿先落 `unbound/runs/`，取得 typed 票身份（起居郎认票断言，或未绑定工作席 typed 回执自报）后整体归位至 `<ticket>/runs/`，不设第五类顶层项。

## 一条腿的四个文件

### `current.json`——当前

审读席默认只读它。整文件写出，**只有一个写者**：该腿公开调用自己的接缝（`public-cli/invocation.ts` 的受理、`run-lifecycle.ts` 的状态转换、`settlement.ts` 的终局），经 `src/run-dossier.ts` 写入；角色运行时、宿主适配器、闸都不写它，它们知道的事都追加成记录。每次写出都按 `history.jsonl`、`log.jsonl` 里已有的行重算派生分区，所以一个进程的写出不会丢掉另一个进程追加的记录；无锁，写入为临时文件加 rename。

| 分区 | 内容 | 来源 |
| --- | --- | --- |
| `invocation` | 这条腿是谁：席、宿主、模型、项目根、票号、关联号、起跑时的 pi／角色包版本 | 受理 |
| `admitted` | 受理时的请求：指令、附件、各席特有输入，及传召的上游腿指针（`sourceRunPath`／`sourceRun`） | 受理 |
| `runState` | 腿的生命周期（admitted／running／resumable／terminal）、开着的庭 | 状态转换 |
| `terminal` | 终局：`face` 为 `report`／`error`／`no_receipt`（无卷，#836），`body` 为终局事实 | 结算 |
| `submission` | `latest`：最新一次封存的交卷原文（`history.jsonl` 里最后一条 `sealed` 行） | 派生 |
| `officers` | 本腿传召的官员腿指针，每官一格（`history.jsonl` 里各官最后一条 `officer-pointer` 行） | 派生 |
| `host` | `sessions[<host>]` 宿主会话 id（`log.jsonl` 的 `host-session-id` 行；按宿主分格，换宿主续跑不会把一家的 id 交给另一家）与 `original`（最近一次宿主原件复制的落点） | 派生 |

### `history.jsonl`——历史

只追加，翻旧账时才读。行都是司天台 appender 写的原行（`kind`、`payload` 与旧账本一字不差，只是落地文件换了）：

- 原交卷账本：`candidate`、`roundContext`、`outcome`、`sealed`、`post-seal-anomaly`。
- 原续跑记录：`attempt-history`（每个派发的回合一行，含催交回合）。
- `turn-delivery`：每次起跑发出的系统提示与输出 schema（本票新增的记录）。
- `officer-pointer`：闸传召官员腿的指针（本票新增的记录）。

### `log.jsonl`——司天台流水

只追加，经司天台 appender 唯一入口。每行带自己的 `kind`：`host-session`（宿主原件指针、落点、复制 warning）、`host-session-id`、`attendance`、`dispatch-error`、`dispatch-exception`（一次抛异常的派发的完整异常）、`gate`、`engine-detour-call`、`stderr`（宿主 stderr）、`post-admission-diagnostic`、`resume-diagnostic` 等。**审读席不读**；闸、续跑、太史读；查故障才翻。其父会话是某条腿自己 session 的记录都落 `history.jsonl`（上列几种）或这一本；父会话不是腿自己 session 的（navigator 嵌套等）仍落各自 `session/<kind>/records.jsonl`，不在本页射程。

### 宿主原件

不编号，退出时覆盖同名文件（ADR 0086）：

- pi：`session/session.jsonl`，pi 直落。
- codex、claude：`session/<host>.jsonl`，单文件。
- grok：`session/grok-build/` 目录（`chat_history.jsonl`、`usage.json`）。
- hermes：原件在 sqlite，沿 ADR 0086 既有边界暂不覆盖，其余三文件照常。

headless／ACP 腿的 `session/session.jsonl` 另有包自己写的交卷闭合、无卷生命周期事实、导航员到场等 custom entry（pi 格式），settlement 与太史读它；它与宿主原件同在 `session/`。

## 读法

- 大理寺、给事中、符宝郎读本票 `records.jsonl` 与被审腿 `current.json`。
- 御史台另读被审腿宿主原件，只 grep 工具调用。
- `history.jsonl` 只在争议涉及早先轮次时读；`log.jsonl` 查故障才翻。

## 经陛下允许多出来的项

陛下 2026-10-03 逐字：「允许多出来」（本票施工会话，源卷 `~/.claude/projects/-Users-akagilnc-WorkSpace-worktree-roles-1161/6d409146-5717-4ff6-83cf-728f50533a24.jsonl`，对施工者列出的这三样的答复）。run 目录里四文件之外保留：

- `session/session.jsonl`（headless／ACP 腿包自己写的那份）：太史取帧起止与工具区间（`analyst-ledger`）、票轨迹（`ticket-trajectory`）、起居郎取原生会话区间（`ticket-provenance`）、settlement 取无卷生命周期事实与导航员到场都读它。
- `session/worker-submission-gate/`：worker 闸跨续跑保存的状态（提交基线、已提醒标记、缺理由催办次数），续跑时读回；由 ADR 0065 的 `createRecordSession` 持有，不是日志副本。
- 各席受理时冻结的输入，在 run 目录顶层：`task.md`、`fix-packet.md`、`prerequisites.json`、`request-manifest.json`、`merger-input.json`，席位运行时按路径读取。

## 边界

- 本页只定义 `books/<book-key>/` 以下拓扑，不改变 ADR 0048 的家、簿、分簿键与 session 直写原则。
- 票身份来自起居郎认票断言，或未绑定工作席 typed 回执中的票号自报；路径代码不从自然语言重判票号。
- 落盘调用方不选择目的地；唯一记录入口依身份和 run 所有权计算上述路径。
- 太史分析目录不在本拓扑射程。
- 存量卷宗不迁移：#1161 之前的 run 目录（十六个文件、逐次副本）不被读取，旧文件名在代码中不再被写入或读取；`src/book-topology-*.ts` 与 `scripts/migrate-book-topology.ts` 是 #852 的一次性迁移工具，其中提及旧名字处只服务存量迁移，不属于运行路径。

## 已知缺口

- 本腿 token 用量没有进 `current.json`：pi 可由 `session.jsonl` 汇总，grok 有 `usage.json`，codex、claude 的原件里取不到统一口径，按票面「取不到即为缺口」不补；`scripts/ledger/run-show.py` 读宿主原件给出 codex 的用量。
