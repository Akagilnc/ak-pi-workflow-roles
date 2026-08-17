# 0071 — 引擎绕行失败＝座席顶班 + typed 回执机械可读申报；单一共享机制

Status: proposed（随 #380 施工；PR 评审闭环后转 accepted）

**决策**：引擎 detour 失败（非零退出 / 空 stdout / spawn 失败 / 超时）后回主路——座席顶班照常劳务并交卷；typed 回执必须带机械可读 `engineLaborFallback`（`engine` / `failure` / `laborBy:"seat"`）；顶班+申报为全仓单一共享机制，席位只是参数。

**法源**：[ADR 0069](0069-labor-outsourcing-engine-generic-one-logic.md) 决策键 `detour-rejoins-main-road`（绕行汇回主路；成文从未写「外包失败就不准走原路」）+ owner 2026-08-17 三道逐字令（顶班是合法 backup；罪只在静默；一样的代码不许按席复制）。
