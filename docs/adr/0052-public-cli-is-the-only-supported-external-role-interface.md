# 公开角色 CLI 是唯一受支持的外部角色入口

Status: accepted

外部调用者唯一受支持的产品入口是 `ak-role`（一个公开 executable 加角色子命令，为每次已受理调用交付完整终局结果）；裸 Pi 激活仅保留为包开发内部接缝，发布安装不自动注册、公开 help 不展示；该 CLI 不替用户选择角色或组合通用工作流。具名例外是 Reviewer 的固定产品语义：省略 `--lens` 的一次父调用由共享执行接缝并行派发两个单轴 Reviewer 子调用并汇合一个终局，显式 `--lens` 仍只执行一轴。分发沿用 Pi package 单一安装真源，不再全局 npm 安装第二份副本。终局结果对所有调用者用同一张简洁表格（只冻结大块语义不冻结呈现），角色结果块为账本原 payload（多次交卷逐条）加宿主原因；Navigator 不得扣押已完成的角色结果，grace 超时以诚实 unavailable 进入同一结果；退出码表达 CLI 生命周期是否诚实完成——lawful typed 终局（含 no_receipt）退 0，真失败退非零。项目公开包采用 `Apache-2.0`；强制方法随包携带（含带 attribution 的适配版 Skill），不把用户 home 下的 Skill 当隐含前置。

## Considered Options

继续把裸 Pi 与 session 文件包装成公开用法、分别提供人读与机器输出、把表格呈现机械化为 schema、为 shell CLI 再全局 npm 安装一份、运行时下载外部 Skill——均驳回。

Decision key `reviewer-packaged-method=ak-cross-m-review`：御史台随包方法身份为 `ak-cross-m-review`（整份逐字携带上游，packageAdaptation=`verbatim-upstream`）；公开 CLI 仍是唯一外部接口本身不动。
