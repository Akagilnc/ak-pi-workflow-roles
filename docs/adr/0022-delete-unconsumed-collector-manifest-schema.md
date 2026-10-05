# 删除无人消费的 Collector manifest 发布 Schema

Status: accepted

删除无人消费的 Collector manifest 发布 Schema 及其专属测试；README 只保留最小可读示例。包对通进司请求清单的语义校验与 `loadCollectorManifest` 生产真源句已由 #1165 / [ADR 0087](0087-package-routes-and-passes-through-code-hands-no-paths.md) 废止：文件旗只传调用方原路径，包不读不校验。
