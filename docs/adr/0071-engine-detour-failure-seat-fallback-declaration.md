# 0071 — 引擎绕行失败＝整条 run 失败；禁座席顶班、禁跳过绕行

Status: proposed（随 #380 施工；PR 评审闭环后转 accepted）

**决策**：引擎绕行是**强制**的——席位必须实际调用 CLI。绕行失败＝**返回 typed 失败并停止，整条 run 失败**。失败后在座劳务**禁止**；**零次调用即在座劳务同样禁止**（没试过 ≠ 试了失败，不是顶班而是违规）。不得静默换用其他引擎 id。

**法源**：owner 2026-08-22 逐字令「我现在要的就是没有 backup。我现在的话大于我之前的话」——**明文推翻**本 ADR 原决策（座席顶班＋`engineLaborFallback` 申报）及其所据的 owner 2026-08-17 三道令中「顶班是合法 backup」一条。

**为什么改**：顶班让「外包」变成可选项——席位够强时会直接在座干完，`--engine` 形同虚设（实测：多条 judge run 的 `ak_engine_detour` 调用次数为 0，无 failure 可申报）。要外包真发生，唯一办法是让不外包等于失败。

**被推翻的内容**：原「座席顶班（原主路）照常劳务并交卷」＋`engineLaborFallback` 三键申报（`engine`/`failure`/`laborBy`）。申报机制随顶班一并废止——没有顶班就没有要申报的顶班。

**同步改动**：`resources/engines/{agy,opencode,grok-4.6,ox-alpha}.md` 的 Failure handling 段已改硬为同一措辞。
