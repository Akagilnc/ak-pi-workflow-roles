# 票一张 current，腿只留宿主原件

Status: proposed（2026-10-08 陛下口头拍定各项，待亲审本文）

一张票的进度只有一处：票目录下的 `current.jsonl`，每收下一次交卷追加一行——时间、席#轮（有镜加镜）、审／修的是谁#轮、结论、20–50 字摘要、宿主会话指针、包版本。回执全文只存一份（`receipts/<席>#<轮>.json`）。腿目录只剩宿主原件复制（[ADR 0086](0086-host-dossier-is-native-file-copy-sitian-append-only.md) 不变：宿主会清理，原件必须复制）；每腿一份 `current.json`／`history.jsonl`／`state.jsonl`／`log.jsonl` 全部不再写。对外地址是「票＋席＋轮」（`ak-role resume #N judge`），runId 退出用户面。轮＝一次被收下的交卷；审官行在传召那一刻钉死「审 谁#轮」，催交重交不进轮，续同一腿再交卷即下一轮。父腿不记子腿指针、不投影他席结论——谁审了谁，只在审官自己那一行。

## Considered Options

- 每腿一套卷宗（current/history/state/log）加父腿指针与他席终局投影（ADR 0075／0079／#753／#1161 的形态）——同一事实多处写，靠绑定保持一致，#1192／#1195 的「取到旧回执」即一致性破裂；14 腿的票要开 14 份 current 才知道进度，弃。
- 宿主会话只记指针不复制——宿主会定期清理，弃。
- 每次起跑存一份系统提示词（11 KB）供事后复盘——陛下从未问过「衙门当时拿到了什么」，且包版本＋仓库历史即可还原，改为每行记包版本。

## Consequences

- `courtAttemptId`／`invocationScopeId`／`attemptHistoryIdentity` 与太史（analyst）失去读者，退场另立票。
- 冻结重放改从「票级行＋回执＋包版本」重组起跑材料，不再依赖 `turn-delivery`。
- 还没报票号的腿，行先落 `unbound/current.jsonl`，报号后只搬行不搬目录（[ADR 0081](0081-ticket-identity-settled.md) 的角色自报票号不变）。
