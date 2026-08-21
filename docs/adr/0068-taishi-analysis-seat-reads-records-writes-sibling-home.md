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

**cadence 修订（owner 2026-08-14 终裁豁免）：** 上表 `cadence` 原值 `auto-per-merge-pull-anytime` 的 **auto-per-merge 半边**经 owner 2026-08-14 终裁明示豁免；现形态＝**caller-invoked 巡扫 CLI**（公开面 typed 入口，调用者主动调用）；**自动触发整题挂起**，待门下省建立、merge 与后续清理流程归其角色时再议。pull-anytime（#338 查询时 compute-if-missing）仍在。冻结件 `decision-record-337-338-auto.md` 补充裁定三原话：「算了算了。别那么复杂了。」；补充裁定四原话：「就做成一个正常cli。调用者来调用吧。这个做好了。后面有机会再来说自动触发的事情。比如门下省做好了以后。merge和后续清理流程归门下省的某个角色的时候。」

正文其余措辞属驱动方综合，不主张陛下 authority。指标清单与榜单口径归方向票，不载于本 ADR。

## Considered Options

- **一次性探针不设席**：被陛下定性替代——「严格来说是一个分析能力」；分析是司天台第二职掌的常设席位，不是抛弃式脚本。
- **每 issue 归属做成记录内机械字段**：不需要——issue 与 worktree 一一对应，`projectRoot` 即机械键（「目前我们的issue不都是一个固定的worktree吗？为什么不能圈定？」）。
- **发明单一效率分**：初期不做；并列粗指标看趋势，口径攒够数据再收敛。

## 修订（owner 2026-08-21 / #399）

**查询机械键不再是 `projectRoot`。** 票庭 owner 裁定：

1. 裸调用 = 查当前仓整簿（按 cwd `git common-dir` 定簿，与记录层同一定簿逻辑）；不为整簿造新参数。
2. `--project-root` **无条件删除**（无用户的机制不留；**无模式例外**——含 model-groups）；一切 taishi 调用传入即明确报错并提示裸调用 / `--ticket`。
3. model-groups **真需求 = 多 issue 对比而非多目录**；现多 root 入口属错形。公开 CLI 面诚实停用：调用即报错说明「输入面按多 issue 重设计中（见后续票）」；不新造任何替代参数。聚合内核（`TaishiModelGroupsMode` 库层）保留原样供后续票复用。
4. ADR 0068 若错了就改——本修订授权随 #399 同落，与实现对齐。

现行公开查询范围 = **簿**（候选集合，cwd git common-dir）× **票**（集合内过滤，`--ticket N` → `invocation.ticketNumber===N`，缺 typed ticket 不回退；零匹配诚实空页）以及既有 sweep / cohort 面。页面 / 索引地址含 **book identity**，跨簿同票号不得碰撞合并。记录侧 invocation 上的 `projectRoot` 字段不动（仍为记录/展示面）；`library-index` 仅保留给 cohort（及喂养它的 sweep 生产路径），ticket 查询路径不读 index。

上表 Considered Options 中「`projectRoot` 即机械键」的查询面主张由本修订废止；该句保留为历史选项记录，不再生效。
