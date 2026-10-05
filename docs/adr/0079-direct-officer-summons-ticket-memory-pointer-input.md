# 交卷闸直接传召、衙门按票记忆、传召只递指针

Status: accepted

交卷闸按受审物直接传召具体衙门，不起门下省子 session（门下省仍可独立调用）；现行受审物映射引用 [worker 审核组合](../../src/worker-role.ts)、[Judge 审核组合](../../src/judge-role.ts) 与 [中书省审核组合](../../src/secretariat-role.ts)，不在 ADR 平行维护。察院/符宝郎/审刑院在同一父 run 内再传召 = resume 该席上一次 run（查找键为本次父 run 路径），给事中同票再传召同理 resume；自动同票 resume 保留，另增显式派新腿入口与显式 resume 并列，由调用者决定，机制不判断上下文是否超限。审核对话内容由父角色本轮 typed payload 原话传递、不由代码撰写；具名取代 ADR 0072 先调省再派官，修正 ADR 0075 显式票号旗结论。

**范围修订（#1092 / 2026-09-27）：** 撤掉本页「指针是绑定材料由代码精准递送」中代码精准递送起居录路径指针的旧决定。传召、同票续跑与 typed payload 原话传递不变；起居录读取与路径约定引用仓内 [CLAUDE.md「起居录位置」](../../CLAUDE.md#起居录位置1092)。

**范围修订（ADR 0087 / 2026-10-05）：** 标题「传召只递指针」对被审腿而言，所递是身份 `<runId>@<席>`，不是目录路径，各审核席同一给法；见 [ADR 0087](0087-package-routes-and-passes-through-code-hands-no-paths.md)。传召、同票续跑与 typed payload 原话传递不变。
