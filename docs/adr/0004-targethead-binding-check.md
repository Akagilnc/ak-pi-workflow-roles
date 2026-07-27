# 0004 — targetHead 绑定值校验取代 per-run schema 注入

Status: proposed(owner 2026-07-27 grill 拍定;评审闭环后转 accepted)
Date: 2026-07-27

判官回执 schema 静态化,含**可选** `targetHead` 字段;调用方经 `AK_JUDGE_TARGET_HEAD`(完整 SHA)绑定时,交卷工具在 soul 审计前 fail-closed 校验全等,错值出不了车间门(session 内重交);绑定不在场(standalone)则该字段自由。上一代「每次运行现造 schema-const + 整份 env 注入」机制退役。不造通用绑定框架——一个真实绑定一个环境变量。收货方(编排器)保留单行全等 assert 作下游兜底,绑定漏设时失败会响。
