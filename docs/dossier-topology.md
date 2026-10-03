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

审读席默认只读它。整文件重写，按分区各有归属；写方都在同一条腿的进程链里轮流写（父进程在子腿回合期间挂起），由 `src/run-dossier.ts` 唯一入口读改写，调用方只指名分区：

| 分区 | 内容 | 写方（接缝） |
| --- | --- | --- |
| `invocation` | 这条腿是谁：席、宿主、模型、项目根、票号、关联号、起跑时的 pi/角色包版本 | `public-cli/invocation.ts`、`run-lifecycle.ts` |
| `admitted` | 受理时的请求：指令、附件、各席特有输入，及传召的上游腿指针（`sourceRunPath`／`sourceRun`） | `public-cli/invocation.ts` |
| `runState` | 腿的生命周期（admitted／running／resumable／terminal）、开着的庭 | `public-cli/run-lifecycle.ts` |
| `host` | 宿主会话 id（续跑读它） | `session-identity.ts` |
| `delivery` | 最近一轮发给宿主的系统提示与输出 schema 全文 | 各宿主适配器（headless／ACP／pi） |
| `submission` | `latest`：最新一次交卷（不含系统提示与 schema） | `submission-ledger.ts` |
| `officers` | 本腿传召的官员腿指针（每官一格，同官再召覆盖） | `submission-gate.ts`、`public-cli/instruction-seat-run.ts` |
| `terminal` | 终局：`face` 为 `report`（收）／`error`（真实失败）／`no_receipt`（无卷，#836），`body` 为终局事实；不含交卷原文 | `public-cli/settlement.ts` |

`current.json` 是 `history.jsonl` 加终局的投影：任一写方失败，settlement 可由历史重投。

### `history.jsonl`——历史

只追加，每行一个事实，翻旧账时才读：

- `{"type":"submission", attempt, at, attemptId, toolCallId, toolName, role, params, disposition, reason?, systemPrompt?, outputSchema?}`：每次交卷一行，闸决定之后写一次。`params` 是角色原话；`disposition` 为 `accepted`（收）／`rejected`（退）／`infrastructure`／`continuing`（闸令回合继续、未收）；`systemPrompt`／`outputSchema` 取自 `current.json` 的 `delivery`，为当次发出的全文。
- `{"type":"resume", at, cause?, previous?}`：每次续跑一行，写在续跑回合发出之前。`cause` 是机械名：`auto-resume`／`delivery-request`（回合无可用回执，包自己再入，即卡死）、`explicit-resume`（调用者 `ak-role resume`，即续派）、`summons-resume`（闸或同票同行把腿还回来，即打回）。`previous` 是被本回合覆盖前的终局摘要（面、种类、状态或失败起因），这是上一轮终局唯一的留存处。

### `log.jsonl`——司天台流水

只追加，经司天台 appender 唯一入口。每行带自己的 `kind`：`host-session`（宿主原件指针、落点、复制 warning）、`attendance`、`dispatch-error`、`dispatch-exception`（一次抛异常的派发的完整异常）、`gate`、`engine-detour-call`、`stderr`（宿主 stderr）、`post-admission-diagnostic`、`resume-diagnostic` 等。**审读席不读**；闸、续跑、太史读；查故障才翻。其父会话是某条腿自己 session 的记录都落这一本；父会话不是腿自己 session 的（navigator 嵌套等）仍落各自 `session/<kind>/records.jsonl`，不在本页射程。

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

## 边界

- 本页只定义 `books/<book-key>/` 以下拓扑，不改变 ADR 0048 的家、簿、分簿键与 session 直写原则。
- 票身份来自起居郎认票断言，或未绑定工作席 typed 回执中的票号自报；路径代码不从自然语言重判票号。
- 落盘调用方不选择目的地；唯一记录入口依身份和 run 所有权计算上述路径。
- 太史分析目录不在本拓扑射程。
- 存量卷宗不迁移：#1161 之前的 run 目录（十六个文件、逐次副本）不被读取，旧文件名在代码中不再被写入或读取；`src/book-topology-*.ts` 与 `scripts/migrate-book-topology.ts` 是 #852 的一次性迁移工具，其中提及旧名字处只服务存量迁移，不属于运行路径。

## 已知缺口

- 交卷行没有「本轮其余工具调用 id」：turn_end 事件已删，同一轮的其它工具调用在宿主原件里，御史台 grep 得到；需要时补法是在回合边界追加一行 `{type:"round", calls}`。
- 本腿 token 用量没有进 `current.json`：pi 可由 `session.jsonl` 汇总，grok 有 `usage.json`，codex、claude 的原件里取不到统一口径，按票面「取不到即为缺口」不补。
- 某些席把受理时生成的输入材料（`task.md`、`fix-packet.md`、`merger-input.json`、`request-manifest.json`）放在 run 目录顶层，gate 官员的嵌套 session 在 `session/worker-submission-gate/`：这些不在四文件之内，随各席的受理材料与现有嵌套保留。
- 历史上同一 toolCallId 的重试：每次调用各记一行，不再合并。
