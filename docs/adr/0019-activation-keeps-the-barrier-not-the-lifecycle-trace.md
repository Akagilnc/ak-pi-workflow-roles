# Activation 保留关门，不保留生命周期轨迹

Status: accepted

共享 activation 接缝继续 fail closed：非法激活以真实 cause 响亮失败。删除健康启动的 stage、轨迹、发布 Schema 与配套格式校验；失败只留 cause-bearing stderr。本条与 ADR 0021–0045 同属「只验证必须有的」大扫除族。
