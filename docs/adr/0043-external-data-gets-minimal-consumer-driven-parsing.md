# 外部数据只做 consumer 驱动的最小解析

Status: accepted

不可信外部数据进入项目时只提取 consumer 必须使用的字段并验证可用；未知字段忽略，不建立完整外部镜像 schema，不对 runtime 自生成内部对象再次格式复核。
