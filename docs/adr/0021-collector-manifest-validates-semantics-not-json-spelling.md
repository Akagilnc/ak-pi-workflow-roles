# Collector manifest 校验语义，不校验 JSON 拼写

Status: accepted（authority/provenance: ADR 0019）

Collector manifest 由标准 JSON parser 解析，继续拒绝非法 JSON、非法 UTF-8，以及缺少生产收集所必需的 leg、request 与 reference 类型、关系或身份语义的解析值。删除 `assertCollectorManifestJsonIdentity` 自制词法扫描器及其专属测试；`1`、`1.0`、`1e0` 等解析为同一数值的字面形式不再区别接受，重复 key 按标准 parser 的既定解析结果进入后续必需语义校验。

后续裁决明确优先：ADR 0025 取代精确字段集合拒绝，ADR 0035 取代包内 60,000 UTF-8 bytes 上限，ADR 0044 在没有真实 reader branch 的位置取代固定 `version === 1`。除此之外不从原始 JSON 拼写建立第二套契约。

没有真实运行证据证明 JSON 数值拼写或重复 key 曾导致错误收集；最终解析对象仍受必需的生产语义校验。为原始文本建立第二套 JSON parser 只增加格式拒绝、双解析语义和维护成本，不保护独立行为不变式。
