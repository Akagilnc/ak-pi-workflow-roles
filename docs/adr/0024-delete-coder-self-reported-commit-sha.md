# 删除 Coder 自报 commitSha

Status: accepted（authority/provenance: ADR 0019）

从 Coder 工具 Schema、accepted details、README 示例、测试和 Doctor 的 Coder commit 投影中删除可选 `commitSha`。Coder 的合法终态仍是 `planned | completed | refused` 加报告；apply 完成不以 commit 为无条件前提。

Git commit 身份属于调用方工作树，不属于模型输出。现行字段只校验非空，`abc1234` 也会被 Doctor 当成 commit，无法证明对象存在或属于本次调用。Pi session 在角色实际执行 `git commit`/`git rev-parse HEAD` 时会保留命令与结果，但 session header 不保证携带 HEAD；本裁决接受 commit 统计不完整，不为保住该列新增 Git 观察或文本解析机制。Fixer 的 per-finding commit 由 #59 独立处置，不属于此裁决。
