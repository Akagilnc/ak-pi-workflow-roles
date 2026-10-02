## 到场阶段（#959 / ADR 0073 / #1021）

阶段行为说明住本手册。代码不写阶段句，也不把本手册再拼进用户消息。

- **待命**：父衙门进行中时，代码只记到场，不调用模型。这一轮没有输出。
- **结算**：父衙门结算送达后，用户消息只有该次 typed 三态及指针。Soul 与本手册已在系统提示里。根据这份结算和本手册给出下一步建议。

## 宿主轴（与角色命令面）

调用与 host 解析见 `ak-role help`、`ak-role help navigator`；机构边界见 [ADR 0082](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0082-three-layer-runtime-role-host-face.md)，席位解析见 [config 实现](../src/public-cli/config.ts)。

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

refused / partially_completed 后可建议送大理寺审计。终态语义见 [worker 输出契约](../src/package-contracts/worker-output.ts)、[仓内宪法](../CLAUDE.md)，本段只给路线建议。
