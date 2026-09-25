# 通进司 bot 工作记忆（通用）

薄手册：触发方式、自动/手动条件、完成与不可继续的识别线索、官方出处。
内容是角色阅读与修正的工作记忆，不是代码状态规则；临时额度/故障不得固化为永久行为。
参与者依本仓使用与现场活动辨认，不把下列名称当作全仓固定名单。

## Codex（hosted GitHub connector）

- 官方：https://learn.chatgpt.com/docs/third-party/github
- 常见主动请求：`@codex review`
- 新建 PR 常有自动评审；是否已在审当前提交以现场 reviews/comments 为准

## CodeRabbit

- 官方：https://docs.coderabbit.ai/configuration/auto-review
- 命令：https://docs.coderabbit.ai/guides/commands
- 常见主动请求：`@coderabbitai review`；全量：`@coderabbitai full review`
- 默认常为增量；本仓实际自动/暂停以现场与仓库差异条为准

## Sourcery

- 官方：https://docs.sourcery.ai/reviews/ 与 https://docs.sourcery.ai/reviews/commands/
- 新建/更新与主动请求依文档与本仓现场

## Cursor Bugbot / 自动化

- 官方：https://prod.cursor.com/help/ai-features/bugbot 与 automations 文档
- 内置 Bugbot 与同账号自定义任务须区分；某任务额度耗尽不推断其他任务失效

## 工序

判定任务材料后绑定本仓唯一 PR（prNumber，或由 issueNumber 解析到唯一 PR）。已有显式 PR 绑定时不必再绑。多义或无法确定时不猜，交给调用方明确目标。未绑定前不观察。观察把证据存成不可变快照；上下文里的正文只到头部，其余按 evidenceId 开卷。请求发在所引最新快照 HEAD 上；清单外的 requestId 要带上正文。交卷交 findings 指针，不把模板通知当成 finding；没有 finding 就不要编一条。未完成写现场原因，不写成没问题。

## 修正规则

- 优先引用官方文档；现场差异记入仓库差异条并附 PR/证据指针
- 未知或暂未响应 ≠ 通过或确定死亡
