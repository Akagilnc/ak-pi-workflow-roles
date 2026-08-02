# 保留 sole-final 交卷，删除 Collector operational batch law

Status: accepted（owner 大扫除裁决，2026-08-02）

所有角色的终止回执继续要求是 sole final tool call。特别理由：交卷同时执行其他工具会产生“已完成但仍在行动”的无声歧义。

删除 F007 的 Collector operational singleton batch law、整条 assistant 消息扫描、sibling poison 与由此锁死 invocation 的 fatal 状态。observe/request/wait 的真实参数、状态与并发冲突由各执行点处理；不再仅因同一 batch 出现第二个调用或 malformed sibling 把整次 Collector 判死。
