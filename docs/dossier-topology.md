# 卷宗拓扑

Status: accepted design（issue [#852](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/852)；本页由子票 #862 建立）

本页是**簿以下路径形状的唯一真源**。候簿之家与分簿键仍由 [ADR 0048](adr/0048-ledger-one-home-many-books-dirname-key-git-only.md) 定义；记录归司天台、经唯一入口落盘仍由 [ADR 0065](adr/0065-sitian-phase-two-records-have-one-entry.md) 定义。其他 ADR 只引用本页，不复述路径。

## 形状

```text
~/.ak-roles/
└── books/<book-key>/
    ├── <ticket>/
    │   ├── records.jsonl
    │   ├── 起居录.md
    │   └── runs/<runId>@<role>/
    │       ├── session/
    │       ├── artifacts/
    │       ├── attachments/
    │       ├── admitted-request.json
    │       ├── invocation.json
    │       ├── run-state.json
    │       ├── stderr.log
    │       └── <run-owned records>
    ├── unbound/
    │   └── runs/<runId>@<role>/
    │       └── <same run shape>
    ├── navigator/<work-subject>/
    └── collector-handbook/
```

簿根只有四类项：

1. `<ticket>/`：以票号命名的票目录；该票起居录及全部腿均在其中。
2. `unbound/`：确实无票或尚未取得 typed 票身份的腿；腿形状与票下相同。
3. `navigator/`：游奕使跨票工作主体记录。
4. `collector-handbook/`：仓库级通进司手册。

归属判据是：删除一张票后仍有意义的记录才留在票外。除游奕使工作主体与通进司手册外，属于某票的材料均落在该票目录；属于某条腿的记录均落在该腿的 run 目录，不在簿根另设 kind 分区。首次入票的识别腿先落 `unbound/runs/`，取得起居郎 typed 票身份后整体归位至 `<ticket>/runs/`，不设第五类顶层项。

`records.jsonl` 是该票起居录的权威记录，`起居录.md` 是同目录派生的人读面。`session/` 的内部文件由对应宿主决定；Pi 的原生会话文件位于 `session/session.jsonl`。run-owned records 包括 attempt history、submission ledger、gate、attendance、dispatch error 与过闸官员卷等归属于该 run 的记录；这些名称描述所有权，不另立簿根路径。

## 边界

- 本页只定义 `books/<book-key>/` 以下拓扑，不改变 ADR 0048 的家、簿、分簿键与 session 直写原则。
- 票身份来自起居郎已递交的 typed 断言；路径代码不从自然语言重判票号。
- 落盘调用方不选择目的地；唯一记录入口依身份和 run 所有权计算上述路径。
- 太史分析目录不在本拓扑射程。
- 存量迁移、备份和逐分区取舍由 #852 的迁移切片执行，不在本页复制迁移规程。

## 已知不一致

仓级 [`CLAUDE.md`](../CLAUDE.md) 的 “Role invocation evidence” 仍写作 `books/<主仓目录名>/issues/<issue>/runs/...`，与本页的 `books/<book-key>/<ticket>/runs/...` 不一致。#852 明确未授权本片修订仓级 `CLAUDE.md`；因此本页记录该事实，但不改该文件。
