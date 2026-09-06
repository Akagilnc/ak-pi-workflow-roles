# 0077 — 全宿主 session 卷宗统一直写司天台（修订 ADR 0065 范围键）

Status: accepted（票 #594；owner 2026-09-02 裁定；#717 owner 2026-09-06 删隔离 home；decision keys 与绑定原话见下）

## 承继 / 修正关系

本 ADR **修正** [ADR 0065](0065-sitian-phase-two-records-have-one-entry.md) 的 `record-scope-phase-two=pi-session-records-only`：二期 session 卷宗收录范围由「仅 Pi session 记录」修订为 `all-host-session-records`（司天台统一收全部宿主的 session 卷宗，不分 CLI／宿主）。

历史 ADR 正文不回改；承继与修正关系按 [ADR 0075](0075-ticket-provenance-diarist-pipeline.md) 修订案通道先例由本 ADR 记载。

本 ADR 坚决**重申** [ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md)「session 直接写进家、不设归档搬运」的直写律——各宿主会话卷宗统一收录的实现必须是**直写**（direct write），落入该 run 的 books 目录拓扑内（`runDirectory`），绝不设事后归档、搬运或另起 parallel tee 机制。

## Decision keys（逐条绑 owner 原话；真源票面 #594 / #717）

| key | 值 | 绑定原话（逐字） |
| --- | --- | --- |
| `record-scope-phase-two` | `all-host-session-records` | 「什么叫grok home？ 不是统一交给司天台存吗？别给我说你把不同的cli的卷宗还分开了！」 |
| `live-session-in-books` | grok CLI 原始数据留在操作员自己的家；工厂卷宗以司天台对该 run 的记录为准，不建受控隔离 home、不重定向 HOME | 「grok 腿自动改盯受控 home 活卷 啥意思！卷宗不是统一存放吗？」 |

**施工约束（#717 owner 裁定，2026-09-06）**：删除受控隔离 home。不再建 run 目录下的隔离 grok 家、不再重定向 HOME、不再复制/擦除 `auth.json`。grok CLI 直接用操作员自己的家与凭据；grok 自己的会话原始数据留在它自己的位置，不搬不复制不重定向。司天台按 log4j 式记录该 run 需要的记录。绑定原话：「隔离home这个机制给我删掉！这也是昨天乱删卷宗丢了半天的罪魁祸首设计！」「我在设计三层架构的时候就明确说过。不改变这些cli本身的机制，司天台是类似log4j的东西。pi的 session dir本身给了很好的卷宗能力就直接用。grok没给这样的能力就用司天台来记。而他自己的原始数据该放哪里放那里根本不需要去改！」

本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张 owner authority。

## 机制与拓扑（垂直切片）

- **直写拓扑（司天台 run 目录）**：Pi 宿主原生将会话卷宗直写至该 run 的 `session/session.jsonl`。Grok 宿主的 CLI 原始会话留在操作员 grok 家；该 run 的工厂卷宗是司天台记录，不把 grok 原始数据搬进 books、不另起受控 home。
- **实时活性与卡死取证**：运行中（live）与终局后（settled），该 run 的司天台记录在 books 目录内直接可读；卡死取证、日志排查与监控哨兵读司天台记录，不盯 CLI 自己的家，也不依赖临时目录。
- **凭据**：grok CLI 使用操作员自己的凭据（`~/.grok/auth.json`）；工厂不拷贝、不擦除、不把凭据写入 run 目录。
- **二进制解析**：grok 二进制仍自操作者 home 解析（`~/.grok/bin/grok`）。

## 与既有 ADR 的关系

- **修正** [ADR 0065](0065-sitian-phase-two-records-have-one-entry.md)：`record-scope-phase-two` 范围键由 `pi-session-records-only` 修订为 `all-host-session-records`。
- **重申并遵循** [ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md)：保持 session 直接写进家、不设归档搬运。
- **承继** [ADR 0075](0075-ticket-provenance-diarist-pipeline.md)：沿用修订案通道记录变更，历史 ADR 0065 正文维持不动。
- **#717 修订**：删除「受控 home 建在 runDirectory 隔离子段」的施工形态（该形态自记为非 owner 新裁）。`live-session-in-books` 值列改记本次裁定；键仍索引 #594 原话。
