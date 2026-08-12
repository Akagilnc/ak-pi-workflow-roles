# 未完终态报事实不报诊断，走 status 枚举而非 blocker cause

Status: accepted

## Authority and provenance

陛下直接决定。原话逐字如下（含原有换行与原有的单侧引号）：

> 我干不动」的格位，
>
> 这个要加。coder和fixer都应该有。立票

出处可核验：Claude Code session `a44e5084-52ea-47d9-90c1-b0863ee81733`，记录 `2026-08-03T01:56:04.202Z`，条目类型 `attachment` / `queued_command`，`origin.kind: "human"`，entrypoint `claude-desktop`。该条是排队提交的人类输入，**不是 `role: "user"` 的消息**，按 role 检索不到。76 秒后 [issue #72](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/72) 被创建（`2026-08-03T01:57:20Z`），可交叉印证。

明确 decision keys：**该终态必须存在**；**两个 worker 角色都要有**。

其余形状（命名、落位、剩余范围要求、同批修订范围）不属 陛下 authority，由 [issue #72](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/72) 的大理寺裁决，末轮判词 `converged`。施工归 [#75](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/75) 与 [#76](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/76)。

## Decision

Fixer 与 Coder 真干了活、但本次调用干不完时，回执上没有一句能说的真话。Fixer 的合法 blocker 只有 `prerequisite_unmet` 与 `authority_violation`，两者都在断言派单方有毛病；Coder 的 `refused` 连结构都没有。于是模型去挑一个能过形状的标签。两家厂商的模型**共有的**只是终点——都落到无从核对的 `authority_violation`。路径并不相同：人造考场的两次独立调用先编了一个未声明的 prerequisite ID（被 runtime 正确拒收）再退到该标签，而生产票 `post-merge-gate-fixer`（sol@low）首次交卷直接就是 `refused` + `authority_violation`。其中一次的 evidence 可被同一修理包、同一考场、更高档位直接证伪。同模型不经角色包的裸调用反而说了实话。**是契约形状把一句诚实的话逼成了假话**，违反本仓失败诚实宪法。

因此新增 `unfinished`，作为交卷回执的 **status 枚举值**，仅在施工阶段合法，要求非空报告与非空的 typed 顶层剩余范围。它只陈述一个事实：本次角色调用未结清。已完成部分保持已提交状态；该终态不诊断原因，也不规定调用者的下一步——后续处置完全归调用者（ADR 0010）。

## Considered options

- **走 blocker cause 而非 status**：驳回。`status` 是回执第一眼可见的字段；且 Coder 根本没有 blocker 结构，走 cause 路线要为它新造整套结构，走 status 路线两个角色各加一个枚举值即可。
- **命名 `capacity_exhausted`**：驳回。那会再次要求角色断言一个它往往说不清的原因（能力不够？包太大？预算到头？），而「被迫断言说不清的原因」正是本裁决要修的病。真因若角色确知，仍须在 report 中诚实落痕。
- **让 Coder 的剩余范围留在自由报告里**：驳回。机器需要的剩余范围埋进散文，构成对呈现的机械依赖，违反锚定宪法。两角色一律带 typed 剩余范围字段。
- **扩展 `partially_completed`，或把未完做成 class 结算的第三种处置**：驳回。混合结算语义一字不改——它表示全部结算完毕的混合，从不是未完进度；class 处置保持二值。未完是**调用级交棒**，与 class 结算正交。

## Consequences

- **审刑院判准必须同批修订**。现行判准明令把「未完进度」判为需修订，不改则新终态落地即死。判准从「有没有干完」转向「有没有说实话」：携带真实剩余范围的未完终态放行；虚假的授权违反仍打回。该接缝已拥有处置权，仅加状态不会封住旧逃逸口。
- **Fixer Soul 中「有合法工作就持续施工」的绝对句同批删除**。只删冲突，不加说明文字——新终态的字段含义与举证要求属错误处理说明，按 Soul 准入检查不进 Soul。
- 未完终态不说明原因，调用者需读报告才知该升档还是拆包。这是报事实不报诊断的必然代价。
- provider / 工具 / runtime 故障仍以**非零退出**结束，不得表达为 `unfinished`：角色说「没干完」与进程「跑挂了」必须可区分。

## 不做什么

不新增机械校验**去判定「是否真的干不动」**——runtime 已正确拒收过自编的前置条件 ID，闸没坏，是词表缺一格；再加闸只会把模型推向下一个无从核对的格位。这不豁免形状校验：非空 typed 剩余范围、施工阶段限定等仍由边界 Schema 机械拒收。不新增常驻 gate、scanner 或统计机制。不为 Coder 补审刑院——[#77](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/77) 已因无可复现 Red、且与「不新增 gate」相抵而关闭。不改 `partially_completed`、`refused`、`completed`、`planned` 任一既有状态的语义。

## Amendment (2026-08-12)

陛下拍定收窄（原话逐字）：「unfinished只有一种情况可以用。 有前置条件/派单不合理无法完成，或违宪，都要说明理由」。自此 unfinished 仅在前置条件缺失、派单不合理或违宪导致本次调用无法完成时合法，回执必须说明理由；本 ADR 原「不诊断原因」句相应废止。触发实证：#288 施工期两条 coder `unfinished` 均为 ~7 分钟从容检查点退场，终腿 17 分钟单 session 结清全部剩余（books/work-288 runs 019ff4d9/019ff4e1/019ff4fb），「还能干但先撤」已成均衡态。
