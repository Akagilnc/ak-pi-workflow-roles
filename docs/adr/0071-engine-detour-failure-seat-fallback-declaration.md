# 0071 — 引擎绕行失败＝座席顶班（原主路）+ typed 回执机械可读申报；单一共享机制

Status: proposed（随 #380 施工；PR 评审闭环后转 accepted）

**决策**：引擎绕行失败＝座席顶班（原主路）照常劳务并交卷；typed 回执必须带机械可读申报 `engineLaborFallback`（三键：`engine` / `failure` / `laborBy`）；顶班与申报为全仓单一共享机制，席位只是参数。

**法源**：[ADR 0069](0069-labor-outsourcing-engine-generic-one-logic.md) 决策键 `detour-rejoins-main-road` + owner 2026-08-17 三道逐字令（见 issue #380：顶班是合法 backup；罪只在静默；一样的代码不许按席复制）。
