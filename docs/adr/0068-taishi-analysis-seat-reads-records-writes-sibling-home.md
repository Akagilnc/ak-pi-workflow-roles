# 0068 — 太史：司天台分析席，读记录、居侧目录、建设排在记录工程后

Status: accepted（陛下 2026-08-13 grill 逐项拍定；decision keys 与绑定原话见下）

设**太史**为司天台的分析席：确定性机制、只读司天台记录、可作为角色单独调用；生成的高阶数据落**基础记录同家下的独立目录**，不进任何业务仓。每次 PR 合并后自动补算（定期调用同一太史，无第二套计算核），指标时序常新、随时可查；建设顺位排在司天二期记录工程（[ADR 0065](0065-sitian-phase-two-records-have-one-entry.md)，S1-S7）之后。

## Decision keys（逐条绑陛下原话）

| key | 值 | 绑定原话 |
| --- | --- | --- |
| `nature` | `analysis-capability-after-records` | 「严格来说是一个分析能力」「我可没说二期不能做分析，但是一切分析肯定是排在记录后面」 |
| `seat` | `taishi-reusable-role` | 「肯定是复用。甚至可以起个角色名字来单独调用。 能力2 只是定期调用罢了」「那就叫太史吧」 |
| `storage` | `sibling-dir-in-records-home` | 「就在本身基础数据同仓下的另外目录就好」 |
| `efficiency-proxy-initial` | `changed-loc-plus-total-elapsed` | 「初期就用改动代码的行数 和 实际完全耗时」（驱动方补充排除项：dist/构建产物/lockfile 不计行数，经陛下「可以吧。我觉得够了」并入） |
| `cadence` | `auto-per-merge-pull-anytime` | 「不是每pr合并就自动开算吗，随时可以拉数据？能做主动报警更好不过感觉后面再说」 |
| `first-metrics` | `time-buckets-and-role-success` | 「排名靠前的都是类似模型调用……真的没得减的地方。而类似测试时间，返工轮数」「每个角色的成功率。是不是也很重要。毕竟最理想的情况是大家都一次两次过」 |

正文其余措辞属驱动方综合，不主张陛下 authority。指标清单与榜单口径归方向票，不载于本 ADR。

## Considered Options

- **一次性探针不设席**：被陛下定性替代——「严格来说是一个分析能力」；分析是司天台第二职掌的常设席位，不是抛弃式脚本。
- **每 issue 归属做成记录内机械字段**：不需要——issue 与 worktree 一一对应，`projectRoot` 即机械键（「目前我们的issue不都是一个固定的worktree吗？为什么不能圈定？」）。
- **发明单一效率分**：初期不做；并列粗指标看趋势，口径攒够数据再收敛。
