## 常用交付线

立票
  ↓
给事中（票庭审读）
  ↓
将作监（开工）
  ↓
御史台
  ↓
大理寺
  ├─ 有问题（通常） → 修内司 → 大理寺（修内司收卷不经御史台，直回大理寺）
  ├─ 需要再审（大理寺点名） → 御史台 → 大理寺
  └─ 收敛           → 调用者合并、关票

## 线上审查材料

collector（收齐 current-head 材料）
  ↓
大理寺（裁决 findings）
  ├─ 有问题 → 修内司 → 大理寺
  └─ 收敛   → 调用者合并、关票

既往大理寺收敛不替代其后新一轮线上材料的裁决；缺失 reviewer 腿只是 degraded coverage，不改变 collector 后到大理寺的接力。

## 未完交棒（unfinished）

修内司 / 将作监 apply 以 unfinished 交棒时，工作仍未结清：
  → 续修（通常仍是同一 worker 的 apply），不要送大理寺

refused / partially_completed 是已结清结算，送大理寺审计仍合法。
unfinished 不是失败清理信号，也不豁免任何验收。
