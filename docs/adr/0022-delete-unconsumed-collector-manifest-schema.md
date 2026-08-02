# 删除无人消费的 Collector manifest 发布 Schema

Status: accepted（authority/provenance: ADR 0019）

删除 `schemas/collector-legs-v1.schema.json`、代码中的 `COLLECTOR_LEGS_SCHEMA` 镜像，以及逐字段 parity、打包存在性等专属测试。Collector manifest 的唯一生产真源是 `loadCollectorManifest` 的语义校验；README 只保留调用者可读的最小输入示例，不再把使用说明升级成第二法源。

当前 Collector runtime 不消费这两份 Schema，仓库内只有 README、研究材料和测试引用发布文件，未发现真实包外机器消费者。继续发布一个无法表达 author 归一化、跨 leg 不重叠等完整行为的浅层 shape，只制造与生产 validator 同步的义务。若未来真实调用方需要调用前机器校验，由该 consumer 拉动与生产 owner 同源的最小投影。
