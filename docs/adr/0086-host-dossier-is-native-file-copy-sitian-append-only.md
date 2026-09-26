# 宿主对话卷宗取 CLI 原件复制；司天台只追加、不回读

Status: accepted

ADR 0077 之后，各宿主的 session 事件经司天台 appender 以本包信封逐条直写，appender 每追加一行整本回读查重（#520「entry 级幂等」），ACP 宿主一条续跑多轮的腿记到 139MB、每行 1.27 秒，放行回话排在其后（#1081）；同一会话 grok 自己的原件只有 2.5MB，pi 一条腿的 session.jsonl 中位 206KB。陛下 2026-09-06 已明言司天台是 log4j 式记录器、pi 的 session dir 是范本（#717 转录原话）；2026-09-26 拍定（源卷 `~/.claude/projects/-Users-akagilnc-WorkSpace-ak-pi-workflow-roles/d634a8d9-a196-4730-a40e-83236e6c4e9a.jsonl`，uuid `1e0e840b`、`99029350`、`3c8e0ee9`、`2ba57bba`、`343bbb9b`、`ba0645f9`、`471b0ba7`、`bb2a0ca1`、`f156b4ed`、`e4ba12e3`）：

一条腿的对话卷宗＝宿主 CLI 自己写的原件的复制品，字节不改、不校验、不转格式、不接旧文件。pi 原件本就在 `<run>/session/session.jsonl`，不动；codex 取 rollout 文件、claude 取 projects 文件，各为单文件；grok 取其会话目录中的 `chat_history.jsonl` 与 `usage.json` 两件，保留原名成目录。落点 `<run>/session/<host>-<model>-<n>`（单文件加 `.jsonl`；模型名中的路径分隔符改写为 `-`，不得成为子目录），n 为该 run 第几次起跑，每次 resume 新 n。拿到 session id 即经 `sitianReport` 追加一行原件路径；CLI 子进程退出后（不问退出码）、终局结果写出前，在同一进程内复制一次（APFS clone 为瞬时，不另设队列或后台工人），成功后追加一行落点，失败重试一次，再失败追加一行 warning；复制的成败不改变腿的终局与流程。宿主实时事件不再经司天台记录。

司天台回归 log4j：`sitianReport` 只追加一行，不查重、不回读、不修尾；#520 §「同源唯一——entry 级幂等算法」合同废止。原件指针行、复制落点行与复制 warning 行同为日志行，写失败不中止腿，申报一次即为文档化契约（陛下 2026-09-26「可以」，同卷 uuid `d06ddbc8`）；交卷账本等落账失败的处置沿用既有法（ADR 0085、CLAUDE.md「没有就是 no_receipt 记一笔」），本决定不改。ADR 0065「记录只有一个入口」不变；ADR 0077「原始会话数据留在 CLI 自己的位置、不设隔离 home」不变，其「逐条直写司天台目录」的实现形态由本决定替代；ADR 0048「session 直接写进家、不设归档搬运」对本决定所涉宿主原件收窄：pi 仍直落家，codex／claude／grok 的原件由 CLI 写在自己的位置、退出后复制入家一次，该复制不在 0048 所禁之列。

## Considered Options

- 各宿主事件翻译成 pi 格式——每宿主一个翻译器，绑在会变的 CLI 事件词汇上，且为 2026-09-02 陛下所驳（「什么转码器？直接读不行？」，#617 转录），弃。
- stdout／ACP 流原样落盘——同一会话 ACP 流为原件的 50 余倍（token 级 chunk、进度重发、命令表重发、`session/load` 回放历史），弃。
- 以 `CODEX_HOME`／`CLAUDE_CONFIG_DIR`／`GROK_HOME` 把宿主整个家搬进 run——三家文档均无逐次会话落点选项，只能整家搬，即 #717 陛下下令删除的隔离 home，弃。
- hermes 原件在 `~/.hermes/state.db`（sqlite）而非文件，本决定暂不覆盖；旧 run 已写下的巨型记录就地不动。
