# 卷宗拓扑

Status: accepted design（issue [#852](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/852)；本页由子票 #862 建立；一条腿五项的形状由 [#1161](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/1161) 重写）

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
    │       ├── state.jsonl                  四整页事实行（只追加）
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

## 一条腿的五项（current.json、三个行文件、宿主原件）

### `current.json`——当前

审读席默认只读它。它是渲染，不是事实的存放处：下列各项都先成行（`history.jsonl`、`state.jsonl` 或 `log.jsonl`），公开调用接缝每追加一行身份／受理／运行状态／终局／宿主会话绑定，就在那一刻现读三个行文件、每类取最后一行，把整份写出；写出的内容不取自进程里先前拿到的快照，也不取自旧的 `current.json`。同一条腿上可以有两个公开调用并存（在跑的腿与手动续跑），两边都写它；无锁——写出后检查行文件是否又变长，变长了就再渲染，直到不再变长为止；最后一个追加者总会在自己追加之后渲染，所以最后写完的那个已看过全部行，文件最终等于此刻从行重新渲染的结果。某个行文件读不到（缺文件除外）时，其余行文件里的事实照常渲染，读不到的那个文件连同错误码写进顶层 `unreadable`（文件名到错误码），不静默留下旧内容或缺项。角色运行时、宿主适配器、闸不写它。写入优先为临时文件加 rename；若目录权限不允许新建临时文件（仅已有 `current.json` 可写），则降级为对该文件原地覆盖——与合并前运行状态页直接覆写同一处置，不是全权限情形的强制原子替换。

| 分区 | 内容 | 来源行 |
| --- | --- | --- |
| `invocation` | 这条腿是谁：席、宿主、模型、项目根、票号、关联号、起跑时的 pi／角色包版本 | `state.jsonl` 里最后一条 `invocation` |
| `admitted` | 受理时的请求：指令、附件、各席特有输入，及传召的上游腿指针 | 最后一条 `admitted-request` |
| `runState` | 腿的生命周期（admitted／running／resumable／terminal）、开着的庭 | 最后一条 `run-state` |
| `terminal` | 终局：`face` 为 `report`／`error`／`no_receipt`（无卷，#836），`body` 为终局事实 | 最后一条 `terminal` |
| `submission` | `latest`：最新一次封存的交卷原文 | 最后一条 `sealed` |
| `officers` | 本腿传召的官员腿指针，每官一格 | 各官最后一条 `officer-pointer` |
| `host` | `sessions[<host>]` 宿主会话 id（按宿主分格，换宿主续跑不会把一家的 id 交给另一家）与 `original`（宿主原件现在的路径：最近一次复制落在哪个文件名，就取本腿目录 `session/` 下该名；腿归位到票目录后仍指向归位后的原件） | `state.jsonl` 的 `host-session-id` 行；`log.jsonl` 的 `host-session`（`native-session-copy`）行 |

公开调用读自己的事实时读的是这些行（最后一行），不读渲染。

### `history.jsonl`——历史

只追加，翻旧账时才读。行都是司天台 appender 写的行（`kind`、`payload` 与旧文件／旧账本一字不差，只是落地换了）：

- 原交卷账本：`candidate`、`roundContext`、`outcome`、`sealed`、`post-seal-anomaly`。
- 原续跑记录：`attempt-history`（每个派发的回合一行）。
- `turn-delivery`：宿主每实际起跑一次，发出的系统提示与输出 schema 一行（催交回合各算一次；pi 取最后一个 `before_agent_start` 处理器留下的提示）。写失败只申报、不拦起跑。
- `officer-pointer`：闸传召官员腿的指针，一行。

### `state.jsonl`——四整页事实行

只追加，经司天台 appender 唯一入口。原身份、受理、运行状态、终局这四样，每被整份改写一次追加一行，内容就是那一份：`invocation`、`admitted-request`、`run-state`、`terminal`（终局 payload 为 `{face, at, body}`），加宿主会话绑定 `host-session-id`（续跑要用它，写失败与 main 上会话绑定文件写失败相同）。单列一卷是因为三种写失败处置各不相同，与 main 上原文件一一对应：状态页写失败抛错；交卷账本卷（`history.jsonl`）不可写不拦续跑；辅助流水（`log.jsonl`）写失败只申报一次、不改宿主终局。

### `log.jsonl`——司天台流水

只追加，经司天台 appender 唯一入口。每行带自己的 `kind`：`host-session`（宿主原件指针、落点、复制 warning）、`attendance`、`dispatch-error`、`dispatch-exception`（一次抛异常的派发的完整异常）、`gate`、`engine-detour-call`、`stderr`（宿主 stderr）、`post-admission-diagnostic`、`resume-diagnostic` 等。**审读席不读**；闸、续跑、太史读；查故障才翻。其父会话是某条腿自己 session 的记录都落 `history.jsonl`、`state.jsonl`（上列几种）或这一本；父会话不是腿自己 session 的（navigator 嵌套等）仍落各自 `session/<kind>/records.jsonl`，不在本页射程。

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
- `history.jsonl` 只在争议涉及早先轮次时读；`state.jsonl` 是 `current.json` 的来源行，不另读；`log.jsonl` 查故障才翻。

## 经陛下允许多出来的项

陛下 2026-10-03 逐字：「允许多出来」（本票施工会话，源卷 `~/.claude/projects/-Users-akagilnc-WorkSpace-worktree-roles-1161/6d409146-5717-4ff6-83cf-728f50533a24.jsonl`，对施工者列出的这三样的答复）。run 目录里上述五项之外保留：

- `session/session.jsonl`（headless／ACP 腿包自己写的那份）：太史取帧起止与工具区间（`analyst-ledger`）、票轨迹（`ticket-trajectory`）、起居郎取原生会话区间（`ticket-provenance`）、settlement 取无卷生命周期事实与导航员到场都读它。
- `session/worker-submission-gate/`：worker 闸跨续跑保存的状态（提交基线、已提醒标记、缺理由催办次数），续跑时读回；由 ADR 0065 的 `createRecordSession` 持有，不是日志副本。
- 各席受理时冻结的输入，在 run 目录顶层：`task.md`、`fix-packet.md`、`prerequisites.json`、`request-manifest.json`、`merger-input.json`，席位运行时按路径读取。

## 边界

- 本页只定义 `books/<book-key>/` 以下拓扑，不改变 ADR 0048 的家、簿、分簿键与 session 直写原则。
- 票身份来自起居郎认票断言，或未绑定工作席 typed 回执中的票号自报；路径代码不从自然语言重判票号。
- 落盘调用方不选择目的地；唯一记录入口依身份和 run 所有权计算上述路径。
- 太史分析目录不在本拓扑射程。
- 存量卷宗不迁移：#1161 之前的 run 目录（十六个文件、逐次副本）不被读取，旧文件名在代码中不再被写入或读取；`src/book-topology-*.ts` 与 `scripts/migrate-book-topology.ts` 是 #852 的一次性迁移工具，其中提及旧名字处只服务存量迁移，不属于运行路径。
