# 删除不参与真实分支的固定 version 字段

Status: accepted

删除输入输出中不参与 consumer 实际分支选择的固定 version 字段；只有同一 consumer 真实同时读多版本或已有持久数据需迁移时才保留。
