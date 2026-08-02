# Collector manifest 校验语义，不校验 JSON 拼写

Status: accepted（owner 大扫除裁决，2026-08-02）

Collector manifest 继续拒绝非法 JSON、非法 UTF-8、错误的解析值与会改变收集行为的结构或关系：精确字段集合、`version === 1`、leg/author/request 约束、UTF-8 字节上限、唯一性及跨 leg author 不重叠均保留。删除 `assertCollectorManifestJsonIdentity` 自制词法扫描器及其专属测试；`1`、`1.0`、`1e0` 等解析为同一数值的字面形式不再区别接受，重复 key 按宿主标准 JSON parser 的既定解析结果进入后续语义校验。

没有真实运行证据证明 JSON 数值拼写或重复 key 曾导致错误收集；最终解析对象仍受生产校验。为原始文本建立第二套 JSON parser 只增加格式拒绝、双解析语义和维护成本，不保护独立行为不变式。
