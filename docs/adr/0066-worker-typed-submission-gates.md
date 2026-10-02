# Worker typed 交卷闸与 git 前置闸；修内司 LLM 审刑院退役

Status: accepted

退役 Fixer LLM 审刑院代码腿（soul 文件原地保留备用），以 typed 交卷闸替代其打回权能；闸权是 bounce 重写，不是拒收、不是角色失败、不是终止进程。闸①保留零新 commit 的一次软提醒，不建立拒收权；状态判别、重交确认与提醒记录由 [worker 交卷接缝](../../src/worker-submission-gates.ts) 承接；闸②当时保留平台署名检查，署名规则引用 [CLAUDE.md](../../CLAUDE.md#commit-前缀)，承载方式后由 [ADR 0070](0070-worker-commit-gates-bounce-at-submission-not-in-the-repo.md) 修订；闸③⑤不建，闸⑥不建机器核验；测试证据字段见 [Fixer 输出契约](../../src/package-contracts/fixer-output.ts)。跨 resume 的 baseline 与打回记录须经 ADR 0065 司天唯一入口写入；不 supersede ADR 0024/0055/0057，修订 ADR 0006/0062 射程使修内司道不再是在役适用对象。
