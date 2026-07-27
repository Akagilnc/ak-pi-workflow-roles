# 0004 — targetHead 绑定闸 deferred:等第一个真实绑定方拉动

Status: deferred(owner 2026-07-27 grill 拍定后同日复裁:standalone 世界没有绑定方,建闸即预造,违 ADR 0001)
Date: 2026-07-27

判官回执的 targetHead 机械绑定闸**本期不建**。原设计形状保留在此作拉动时的施工图:回执 schema 静态化含可选 targetHead;绑定方经单一 env(完整 SHA)注入,交卷工具在 soul 审计前 fail-closed 全等校验;不造通用绑定框架;收货的调用方保留单行全等 assert 兜底。两条不受 defer 影响的既定判断:①「每次运行现造 schema-const + 整份 env 注入」类机制不复活;②判官应报告所判 head 属 soul 层要求(证据只认当前 head),不待机械闸。
