# Activation 保留关门，不保留生命周期轨迹

Status: accepted（owner 大扫除裁决，2026-08-02；收窄 ADR 0018）

共享 activation 接缝继续 fail closed：非法激活以真实 cause 响亮失败，不能脱笼进入模型。删除健康启动的 stage、started/completed 轨迹、发布 Schema 与配套格式校验；失败只留 cause-bearing stderr 证据。Pi session 首行到 accepted receipt 已覆盖整体调用时长，现有统计不消费 activation trace，而每个角色只有一个粗 stage；为尚无消费者的 activation 子阶段拆分维护完整生命周期格式，其成本高于已证收益。若独立免疫线以后证明子阶段耗时或卡点归因是实际瓶颈，应由真实消费者重新拉动最小观测。
