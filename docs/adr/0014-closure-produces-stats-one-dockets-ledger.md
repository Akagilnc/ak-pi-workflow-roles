# 0014 — closure 产计数,dockets 单账本

Status: accepted(owner ruling,2026-07-31)
Date: 2026-07-30

closure 由调用方从目标 commit 中已提交的 `.ak/dockets/issues/<n>/` 人口确定性地产出一条版本化 StatsLine，并把它保存在同一 issue docket。医生只消费累积行；任何席位不得另算第二账本。包不拥有 closure 调度、hook、tracker 查询、比较呈现、阈值或触发器。

StatsLine 绑定 repository、issue、完整 target commit 与完整排序 manifest 人口。可证指标使用 `measured`；当前 Recorder 没有的时间、被拒 audit 等观测使用带枚举理由的 `unavailable`，不得由路径、散文、Git cadence、raw session、零值或估算代替。角色计数只认无歧义 CLI role flag（含 Doctor），未知或歧义计入 `unclassified`；未归档调用不进入人口。paper/apply 字节按无歧义 Coder/Fixer `apply` phase 分类并保留精确分子分母。

issue 到 default-base PR merge 的墙钟只可由完整、同一 repository/issue/PR/default-base 且时间有序的 typed tracker metadata 证明。一天等于 86,400,000ms，仅为 owner 跨案校准语境，不序列化成 SLA、判定或调度法。
