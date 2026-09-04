# 0078 — ADR 决策键表记承接票，不记实施状态

Status: accepted（#658 票庭 r5 已署）

## Decision keys

| key | 值 | 依据 | 承接 |
| --- | --- | --- | --- |
| `successor-column` | 决策键表增加「承接」列 | #658 | #658 |
| `successor-values` | 单元格只写 `—` 或 `#x` | #658 | #658 |
| `successor-not-status` | 表内不记录 open、merged 等实施状态 | #658 | #658 |
| `reader-verifies-live` | 读表方用 `gh` 现场核验承接票及其合并事实 | #658 | #658 |

## 决策

ADR 的决策键表以「承接」列标明承担该键后续工作的 issue。承接票签发时，由签发方填写该列；值域只有 `—`（无承接，默认）或 `#x`（issue 号）。`#x` 只表达承接关系，不表达该票或其 PR 当前是否已合并、关闭或完成。

状态属于变化中的外部事实，不复制进不可变 ADR。需要判断落地情况的读表方须在当时通过 `gh` 查询该 issue 及相关 PR。条款修正或承继继续使用既有 Supersession 机制，不记入「承接」列。

自 #658 起，新 ADR 必须填写「承接」列。存量 ADR 只回填 [ADR 0074](0074-gate-province-reorg-jishizhong-chaiyuan-split.md)：`three-state-reuse` 由 #657 承接，其余键由 #572 承接；不改变各键原决策。
