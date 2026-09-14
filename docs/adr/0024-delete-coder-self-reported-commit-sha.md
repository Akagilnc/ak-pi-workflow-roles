# 删除 Coder 自报 commitSha

Status: accepted

从 Coder 工具 Schema、回执与 Doctor 投影中删除可选 commitSha；Coder 合法终态仍是 planned/completed/refused，apply 完成不以 commit 为无条件前提。Git commit 身份属于调用方工作树。
