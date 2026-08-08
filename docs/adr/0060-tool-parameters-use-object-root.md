# 工具参数使用 Object 根

Status: accepted

发送给 provider 的工具参数 schema 必须以 `type: "object"` 为根，不得以 union 为根；状态变体在同一对象内表达。

理由：Codex 与 Console Go 会拒绝 root union，Kimi 兼容端点曾将其退化为空 arguments。
