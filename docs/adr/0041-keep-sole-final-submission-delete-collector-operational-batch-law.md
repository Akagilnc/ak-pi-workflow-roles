# 保留 sole-final 交卷，删除 Collector operational batch law

Status: accepted（authority/provenance: ADR 0019）

> **Supersession (#836, 陛下 2026-09-10):** sole-final 交卷与 `context.abort()` 封账由本票取代。终局 = 宿主自己结束（退出码 / turn 结束）；交卷工具只负责记录——调几次记几次，不 abort、不封账、不判 sole。Collector operational batch law 删除半边仍有效。

所有角色的终止回执继续要求是 sole final tool call。特别理由：交卷同时执行其他工具会产生“已完成但仍在行动”的无声歧义。

删除 F007 的 Collector operational singleton batch law、整条 assistant 消息扫描、sibling poison 与由此锁死 invocation 的 fatal 状态。observe/request/wait 的真实参数、状态与并发冲突由各执行点处理；不再仅因同一 batch 出现第二个调用或 malformed sibling 把整次 Collector 判死。
