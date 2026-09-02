# 0077 — 全宿主 session 卷宗统一直写司天台（修订 ADR 0065 范围键）

Status: accepted（票 #594；owner 2026-09-02 裁定；decision keys 与绑定原话见下）

## 承继 / 修正关系

本 ADR **修正** [ADR 0065](0065-sitian-phase-two-records-have-one-entry.md) 的 `record-scope-phase-two=pi-session-records-only`：二期 session 卷宗收录范围由「仅 Pi session 记录」修订为 `all-host-session-records`（司天台统一收全部宿主的 session 卷宗，不分 CLI／宿主）。

历史 ADR 正文不回改；承继与修正关系按 [ADR 0075](0075-ticket-provenance-diarist-pipeline.md) 修订案通道先例由本 ADR 记载。

本 ADR 坚决**重申** [ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md)「session 直接写进家、不设归档搬运」的直写律——各宿主会话卷宗统一收录的实现必须是**直写**（direct write），落入该 run 的 books 目录拓扑内（`runDirectory`），绝不设事后归档、搬运或另起 parallel tee 机制；settle 阶段仅擦除凭据（`auth.json`），绝不整目录删除卷宗。

## Decision keys（逐条绑 owner 原话；真源票面 #594）

| key | 值 | 绑定原话（逐字） |
| --- | --- | --- |
| `record-scope-phase-two` | `all-host-session-records` | 「什么叫grok home？ 不是统一交给司天台存吗？别给我说你把不同的cli的卷宗还分开了！」 |
| `live-session-in-books` | 运行中活卷与终局卷宗同在 books 目录，不分宿主，哨兵取证不依赖临时目录 | 「grok 腿自动改盯受控 home 活卷 啥意思！卷宗不是统一存放吗？」 |
| `direct-write-reaffirmation` | 重申 ADR 0048 直写律：受控 home 建在 runDirectory 下（`grok-home`），直写进家，settle 仅 scrub 凭据不删卷宗 | 由上述 owner 裁定与 ADR 0048 共同派生约束 |

本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张 owner authority。

## 机制与拓扑（垂直切片）

- **直写拓扑（`runDirectory/grok-home`）**：生产环境下 grok 宿主的受控 GROK_HOME 直接建在该 run 的 books 目录相对子段（`join(runDirectory, "grok-home")`）。grok 运行时原生将会话卷宗直写至 `$GROK_HOME/sessions/<encoded-cwd>/<id>/updates.jsonl`。
- **实时活性与卡死取证**：运行中（live）与终局后（settled），该 run 的完整会话卷均在 books 目录内直接可读；卡死取证、日志排查与监控哨兵无需触碰受控临时目录，与 Pi 腿同等享受统一卷宗待遇。
- **凭据保全与 settle 清理**：`auth.json` 由操作者 home（`~/.grok/auth.json`）在 turn 开始前安全拷贝至受控 home；turn 结束（settle）时仅 scrub 凭据文件（`rm(join(controlledHome, "auth.json"), { force: true })`），保留完整的 session 卷宗树。
- **失败安全（open / turn failure）**：若 open 过程拷贝凭据失败，或 turn 执行异常，settle 均保证 scrub `auth.json` 且保留 books 下既有卷宗字节；cleanup 失败与 primary 失败通过 `AggregateError` 诚实抛出。
- **二进制解析**：grok 二进制仍自操作者 home 解析（`~/.grok/bin/grok`）。

## 与既有 ADR 的关系

- **修正** [ADR 0065](0065-sitian-phase-two-records-have-one-entry.md)：`record-scope-phase-two` 范围键由 `pi-session-records-only` 修订为 `all-host-session-records`。
- **重申并遵循** [ADR 0048](0048-ledger-one-home-many-books-dirname-key-git-only.md)：保持 session 直接写进家、不设归档搬运。
- **承继** [ADR 0075](0075-ticket-provenance-diarist-pipeline.md)：沿用修订案通道记录变更，历史 ADR 0065 正文维持不动。
