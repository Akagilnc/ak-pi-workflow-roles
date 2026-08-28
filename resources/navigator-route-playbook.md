## 常用交付线

立票
  ↓
大理寺（审票）
  ↓
将作监（开工）
  ↓
御史台
  ↓
大理寺
  ├─ 有问题（通常） → 修内司 → 大理寺
  ├─ 需要再审       → 御史台 → 大理寺
  └─ 收敛           → 调用者合并、关票

修内司（fixer）收卷后一律回大理寺（judge），不经御史台（reviewer）；御史台再度出场只在大理寺判词点名「需要再审」时。
「先经御史台独立复核、再交大理寺」是将作监（coder）首版的固定走法，修内司条线不走这一步——不要凭直觉补插。

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
