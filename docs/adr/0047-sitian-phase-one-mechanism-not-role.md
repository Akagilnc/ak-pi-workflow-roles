# 司天第一期：确定性机制，不是角色；两面对账已删

Status: accepted

司天第一期是确定性机制，不设 LLM 角色，已删的 Docket Recorder 不复活。原设计「调用方预派 correlation id 落存根 × 信封受理后写匹配激活事实」的两面对账从未接通（A 面存根无写入者，对账器零生产调用，B 面 `waiting.jsonl` 空转），#855 整套删除：B 面路径/写入/导出、A 面存根定义、对账器及其专属测试一并去掉。幽灵腿改由现有 run-state 与 writer lease 在太史读卷面照实报出，不另造对账层。
