# 形状校验失败不得中止本局

Status: proposed

代码不得因**形状校验**失败中止本局（「形状校验」定义见 CONTEXT.md）。角色已交付的输出原样交调用者，情形以既有 typed failure cause 如实标明（`src/public-cli/terminal.ts` 的 `ControlledFailureCause`）。

语义核验与现场事实核验不属形状校验，不在本条射程；其失败按失败诚实宪法与 [ADR 0052](0052-public-cli-is-the-only-supported-external-role-interface.md) 走响亮终结，不得静默放行。**保留项判据的唯一真源在仓级 `CLAUDE.md` 第 0 条，本 ADR 只引用、不另列名单。**

理由：一个 LLM 没交出合格 typed 输出，不该毁掉另一个 LLM 已经完成的劳动。实证——同一份卷上两条对照腿的判词（其一点名生产路径违反宿主全局宪法第 9 条）因审刑院自身的形状校验失败被连带 abort，零留存。正确模式仓内已有三处：`reviewer-role.ts` 与 `collector-role.ts` 的 fatal/非 fatal 分流、README 的 Navigator 契约「never invalidates the role result」。

本决定取代 [ADR 0050](0050-unfinished-terminal-state-reports-fact-not-diagnosis.md)「不做什么」节末句「这不豁免形状校验……仍由边界 Schema 机械拒收」。该句不在 0050 的陛下 authority 内（其 decision keys 逐字仅「该终态必须存在」「两个 worker 角色都要有」）；0050 的 Decision 节不受影响。
