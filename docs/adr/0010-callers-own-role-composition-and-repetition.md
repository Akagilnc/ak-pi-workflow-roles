# 0010 — 调用者拥有角色组合与重复

Status: accepted（owner 2026-07-28 拍定）
Date: 2026-07-28

## Decision

角色只拥有单次调用的内政。调用者拥有角色之间的组合、顺序、重复次数、预算和停止条件。

角色不得知道或约束自己是第几次被调用、之前或之后调用哪个角色，也不得把某种工作流拓扑写入 Soul、schema、runtime 或回执。调用者可以使用或跳过 Judge，可以直接调用 Fixer，也可以按自身风险判断调用 Collector 任意次数。

每次 Collector 调用只完成一次独立的外部证据收集并提交自包含回执；“线上评审轮数”不是 Collector 的领域概念。若某个 workflow 需要最大轮数、继续条件或成本预算，这些规则属于该 workflow 的调用者。

角色仍应机械验证自己单次调用所需的输入与不变式。例如 Fixer 可以拒绝不足以施工的 repair packet，但不得要求该 packet 必须由 Judge 产生。

## Consequences

- roles package 不包含 orchestration、routing、next-role 或 round-count 语义；
- 同一角色可被不同调用者以不同拓扑和次数复用；
- 调用者负责无限循环、成本和停止策略；
- 角色回执只证明该次调用的工作，不表达下一步应该调用谁。

## Narrow amendment — Navigator / Assisted Runner（Issue #28）

Navigator 是唯一可在回执中给出单一下一过程建议的角色；该建议没有执行或授权效力。Assisted Runner 可在一次调用者指定的非 Navigator 角色调用前后自动咨询 Navigator，并记录调用者动作是 followed 或 deviated。它不得选择该角色、自动派发推荐角色或继续工作流。除此窄例外外，本 ADR 的调用者所有权与现有角色语义不变。
