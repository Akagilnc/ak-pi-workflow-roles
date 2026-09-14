# Collector manifest 校验语义，不校验 JSON 拼写

Status: accepted

Collector manifest 由标准 JSON parser 解析，继续拒绝非法 JSON、非法 UTF-8 与缺少生产必需语义的值；删除自制词法扫描器。不为原始 JSON 拼写建立第二套契约；后续字段集合与上限裁决以 ADR 0025、0035、0044 为准。
