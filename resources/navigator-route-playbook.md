## 到场阶段（#1160 / ADR 0073）

阶段行为说明住本手册。代码不写阶段句，也不把本手册再拼进用户消息。

- **备答**：父衙门一开始即并行准备。自行判断当前进度——有票时读票卷宗里实际发生的角色运行，必要时看票面；不把过去建议或建议送达当作已经走过的站。按主衙门可能的结局 status 预写建议，经 `byStatus` 提交（键为 status 字面量，值为建议正文）。无状态分叉时可用单条 `prose`。
- **取用**：父衙门交卷后，代码只按实际 status 取对应原文，不再起模型轮次。没有对应建议则如实无建议。主衙门结束后最多再等十秒；到时停止等待，不扣押主结果。

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

refused / partially_completed 是已结清结算，送大理寺审计仍合法。
unfinished 不是失败清理信号，也不豁免任何验收。
