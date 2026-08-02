# Canonical JSON 不是输入输出格式契约

Status: accepted（owner 大扫除裁决，2026-08-02）

F013 从输入输出格式契约中删除。需要判断两个内容相等的 consumer 直接验证内容相等；确实需要稳定摘要的 consumer 可保留自己的序列化实现，但序列化不得成为额外的输入输出拒绝条件。Assisted 用途随机制删除，Navigator 用途归 #28。
