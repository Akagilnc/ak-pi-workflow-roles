## 宿主轴（与角色命令面）

游奕使自动出席，不另立调用命令。主会话宿主由公开角色的 host 轴决定：调用 `--host` → 席位 `config set-host` → 默认 `pi`。配置默认 host 后，调用者仍用与 Pi 相同的 `ak-role <role> …` 命令面；游奕使随该宿主下的角色跑次出席，席位模型走 run 目录 `institutional-resolution.json` 的 navigator 座（显式 `config set navigator` 优先，否则继承父席有效模型），不再依赖父宿主 ExtensionContext。

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
