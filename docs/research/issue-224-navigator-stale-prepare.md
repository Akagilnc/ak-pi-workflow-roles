# #224 根因诊断：Navigator 投机 prepare 以旧裁决盖新材料

## 案卷

- book=`Ming_LLM`
- collector run=`019fe954-f2a6-73f7-810e-49b53aae1a17`
- navigator invocation=`019fe954-f995-7c1a-ae42-98c5740429f0`
- 出席消息：collector session `ak-navigator-attendance` → `next=merger`
- reason：`大理寺已收敛，当前只剩四路审查腿的汇总与交付收口；进入合并官即可，避免重复实现或复审。`

## 时序（一手）

| 时刻 (UTC) | 事实 |
|---|---|
| 01:41:28 | collector 启动；navigator 写入 invocation + context 并 prompt |
| 01:41:42 | navigator 提交 `next=merger`（collector 仍在收材料） |
| 01:57:11 | collector 接受 terminal；settle 直接选用已准备的 merger 建议 |

`public_settlement_history` 在 prepare 时以 `judge/accepted/converged` 结尾；`work_subject`/`authority` 仅为 legs manifest，不含本轮 findings。建议产生于 collector 结算之前，settle 未再按当前 terminal 重绑。

## 根因

共享出席机制在角色**开始时**投机 prepare，结算时只做 `selectNavigatorCandidate`：

1. 投机上下文看得到**既往** `judge=converged`，看不到**当前** collector 已收齐的新材料；
2. 模型据此给出无 `matches` 的 `next=merger`；
3. settle 把该建议原样打成 typed attendance，与 collector 刚接受的 terminal 在接力语义上自相矛盾。

这不是 collector 本体路由，也不是 ADR 0061「建议可忽略」本身的问题；是 **prepare/settle 时序 + 缺少 terminal 内部一致性** 的共享缝。

## 修法（单一共享机制）

家族 #224/#226/#227 同缝，禁止 per-role 平行护栏。本票落地：

1. **一致性表** `navigatorAdviceConsistentWithSettlement`：`next=merger` 仅在刚接受的 settlement 为 `judge`+`converged` 时自洽；其它已接受结算不得跳到 merger。
2. **结算绑定重绑**：投机建议若与当前 accepted settlement 矛盾，丢弃并带 `currentSettlement` 再 prepare 一次；仍矛盾则 typed `unavailable`（不发明方向）。
3. **路书/soul** 补充 collector→大理寺与「旧收敛不盖新材料」的参考表述（仍为自由建议资料，不改 ADR 0061）。

#230 分工：本票交付共享一致性 + 重绑缝；#226/#227 只消费此缝，不再各造护栏。

## 机械验收锚

冻结场景重放（投机 `next=merger` + collector accepted settle）→ 触发重绑 → typed `next=judge`；并单测一致性表本身。
