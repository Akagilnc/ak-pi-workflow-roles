# 通进司 bot 工作记忆（通用）

薄手册：触发方式、自动/手动条件、完成与不可继续的识别线索、官方出处。
内容是角色阅读与修正的工作记忆，不是代码状态规则；临时额度/故障不得固化为永久行为。
参与者依本仓使用与现场活动辨认，不把下列名称当作全仓固定名单。

取证职责见 [通进司 Soul](../souls/collector.md)；调用面见 `ak-role help collector`。

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

从任务材料与 `--pr` / `--request-manifest` 材料判定目标后，用宿主 CLI 读取有评审的 PR，按各 reviewer 已记录的完成形态收集 findings，整理并交卷。未绑定 PR 时用 `gh` 等自行定位；无法确定时不猜，交给调用方明确目标。证据归属与不确定性的报告原则见 [通进司 Soul](../souls/collector.md)，字段见 [交卷契约](../src/package-contracts/collector-output.ts)。

## 修正规则

- 优先引用官方文档；现场差异附 PR/证据指针
- 未知或暂未响应 ≠ 通过或确定死亡
