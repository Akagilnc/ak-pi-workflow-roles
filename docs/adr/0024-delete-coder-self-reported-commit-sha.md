# 删除 Coder 自报 commitSha

Status: accepted

从 Coder 工具 Schema、回执与 Doctor 投影中删除可选 commitSha；取消自报字段不增设无条件 commit 前置；现行状态见 [Coder 输出契约](../../src/package-contracts/worker-output.ts)。Git commit 身份属于调用方工作树。
