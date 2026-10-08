# 票一张 current，腿只留宿主原件

Status: accepted（2026-10-08，源卷 d634a8d9，各项 uuid 见 #1197）

名词三个：**进度**＝`current.jsonl`，**回执**＝`receipts/`，**会话**＝`sessions/`。

一张票的进度只有一处：票目录下的 `current.jsonl`，每收下一次交卷追加一行，八个字段——`at`、`seat`、`round`、`for`（审／修的是谁#轮，只审官与修内司行有）、`status`、`summary`（20–50 字）、`receipt`（`receipts/<席>#<轮>.json`）、`session`（`sessions/` 下的会话原件）。回执是席位交卷的结构化 JSON（findings、decisionGate……，几 KB），一次交卷一份放 `receipts/`——结论一目了然，不在大文件里翻。会话是宿主原件，一段对话一份放 `sessions/`（[ADR 0086](0086-host-dossier-is-native-file-copy-sitian-append-only.md) 不变：宿主会清理，原件必须复制；pi 的会话文件本身就落在这里），名字只是落点。腿目录不再存在，每腿一份 `current.json`／`history.jsonl`／`state.jsonl`／`log.jsonl` 全部不再写。跑完的票目录只有 `current.jsonl`、`records.jsonl`（起居录）、`receipts/`、`sessions/`。对外地址是「票＋席＋轮」（`ak-role resume #N judge`），runId 退出用户面。轮＝一次被收下的交卷，按席在票上累计；审官行在传召那一刻钉死「审 谁#轮」，催交重交不进轮，续同一段会话再交卷即下一轮。父腿不记子腿指针、不投影他席结论——谁审了谁，只在审官自己那一行。

## Considered Options

- 每腿一套卷宗（current/history/state/log）加父腿指针与他席终局投影（ADR 0075／0079／#753／#1161 的形态）——同一事实多处写，靠绑定保持一致，#1192／#1195 的「取到旧回执」即一致性破裂；14 腿的票要开 14 份 current 才知道进度，弃。
- 宿主会话只记指针不复制——宿主会定期清理，弃。
- 每次起跑存一份系统提示词供事后复盘——陛下从未问过「衙门当时拿到了什么」，发版时间对仓库历史即可还原，弃；行里也不记包版本，`at` 对发版时间即得。
- 回执不另存，要看去会话原件里翻——结论要一目了然，不该在 2 MB 的会话里找一段 JSON，弃。
- 腿目录按「席-序号」命名——腿只为承载一段宿主对话而存在，用户面不需要这个概念，弃。

## Consequences

- `courtAttemptId`／`invocationScopeId`／`attemptHistoryIdentity` 只在每腿卷宗文件之间互相引用，随卷宗一起删（#1202）。太史（analyst）与太医署（doctor）留着、待重新设计（2026-10-08 陛下：「太史留着吧。以后重新设计」），不作读者保护，读不到旧文件是预期。
- 冻结重放改从票级行＋宿主原件重组起跑材料，不再依赖 `turn-delivery`。
- 还没报票号的腿，行与原件先落 `unbound/`，报号后搬到票下（[ADR 0081](0081-ticket-identity-settled.md) 的角色自报票号不变）。
- 旧格式的 books 不迁移，原样留档；真有必要另立票。
