# 0052 — 公开角色 CLI 是唯一受支持的外部角色入口

Status: accepted（Issue #101 `/grill-with-docs`，陛下逐项拍定并确认收官，2026-08-04）

外部调用者不再以裸 `pi --ak-role`、Pi 事件流、session JSONL 或收官 grep 使用角色包；唯一受支持的产品入口是 `ak-role`。它以一个公开 executable 加角色子命令接收调用请求，并为每次已受理调用交付一份完整终局结果。裸 Pi 激活仅保留为包开发 session 显式加载的内部接缝：发布安装不自动注册它，公开 help/docs/bin 不展示它；但它不是安全秘密，不设凭据或身份认证，也不阻止知道源码路径的人显式加载。

终局结果对所有调用者使用同一张简洁表格，不探测终端、不区分“人读/机器读”，也不建立第二套 JSON 输出；表格只冻结角色结果、Navigator 与 artifacts 等大块语义，不冻结表头、行序、措辞、边框或目录结构，机器测试不得咬这些呈现。内部 typed Receipt、Navigator facts，以及 #288 所定义的当前 run/attempt 绑定 typed 无回执生命周期记录，是生成结果的事实边界。Navigator 不得扣押已完成的角色结果：它在角色终态后最多获得临时十秒交付宽限（healthy 完成立即返回，不固定等待满窗；#160 拥有精确 CI 调度，并以 #160 之后真实触发频率决定恢复 3s 或保留 10s），超时以诚实 unavailable 进入同一结果。退出码表达 CLI 生命周期是否诚实完成，不表达业务成功：包括 `audit_escalation` 与 #288 typed 无回执终局在内的 lawful typed terminal result 退出零；其它既有结构、语义或基础设施失败仍退出非零。

该 CLI 不是编排器：角色选择、调用顺序、重复、预算与停止仍归调用者（ADR 0010）。分发沿用 Pi package 单一安装真源：`pi install npm:<package>` 安装 extension 与 package bin，用户一次性把 Pi 私有 npm bin 目录加入 PATH 后调用 `ak-role`；不再全局 npm 安装第二份会与 `pi update` 漂移的副本。项目公开包采用 `Apache-2.0`；包内 Matt Skill 快照继续携带各自独立的 MIT copyright/license notice，不把第三方许可冒充项目许可。包同时携带角色强制方法，不能把用户 home 下的 Skill 当隐含前置：Coder 带 Matt `tdd` 完整目录；Reviewer、Fixer、Merger 分别带按本角色边界适配的 `code-review`、`diagnosing-bugs`、`resolving-merge-conflicts`，保留 MIT attribution 与上游版本，但不运行时追 latest。完成证据不是格式 fixture，而是合并后的版本被下一项自然产生的真实 Issue 使用，外部调用者全程只经 `ak-role` 完成到 merge；没有需求成功消费就不关闭 #11/#101。

## Considered options

- **继续把裸 Pi 与 session 文件包装成公开用法**：驳回。它要求调用者理解内部 event/session transport，且 #95 已实证官方 status-only grep 会合法漏掉 Navigator。
- **分别提供人读与机器输出**：驳回。包不预设调用者身份；同一正常表格供人和 LLM/Agent 阅读。
- **把表格呈现机械化为 schema/snapshot**：驳回。事实由内部 typed 边界拥有，呈现可重排；盯表头、散文、像素或 artifact 目录违反锚定宪法。
- **为 shell CLI 再全局 npm 安装一份包**：驳回。pi-link 已实证双副本会独立漂移；采用 Taskplane 的现成形状，让 Pi 私有 npm root 中同一份 package 同时提供 extension 与 bin。
- **运行时下载 Matt latest 或依赖 `~/.agents/skills`**：驳回。上游改名、断网与版本漂移会让已发布角色失去方法；强制方法随包冻结升级。原版方法与角色法冲突时采用带 attribution 的包适配版，而不是让外部 Skill 越过角色边界。
