# 0076 — 工厂故障响应四例（汇集既裁，不另立泛化法）

Status: accepted（票 #598；给事中署章 run `01a05fb3-76b0-7760-af93-2c0086abba29` countersignStatus=converged；decision keys 与权威来源见下）

## 本票边界

本 ADR **只汇集**四例及其权威来源，**不另立**泛化故障法条，**不平行再定义**既有宪法／ADR。不扩展到未列举场景。旧评论中「从卷宗断点恢复或至少半径受限」二选一**不写入**。四例代码修复各归子票 #592／#597／#593／#599。护栏三问（宿主全局规则 #11／#12）只作既有判据引用，本 ADR 不重写。

## 四例（第 1／2／4 例绑 owner 原话；第 3 例为现行法适用，非 owner 裁定）

### 第 1 例 — 共享配置未知席位键：跳过留痕，不炸 CLI

| | |
| --- | --- |
| **decision key** | `unknown-seat-skip` |
| **值** | 共享配置里他线／他版本写入的未知席位键 → 跳过留痕，不炸 CLI |
| **权威来源** | owner authority |
| **绑定原话** | 「这种没有的席位跳过就好。直接报错？你设计的系统怎么这么喜欢报错？」 |
| **子票** | #592 |
| **实证接缝（修复前）** | `src/public-cli/config.ts` 对未知席位键 fail-closed 抛错 |

### 第 2 例 — 闸回执格式病不得中止已受理交卷

| | |
| --- | --- |
| **decision key** | `gate-receipt-format-must-not-abort` |
| **值** | 闸回执格式病不得中止已受理交卷 |
| **权威来源** | owner authority＋既有法源指针 |
| **绑定原话** | 「又来了！我他妈骂过你多少次这种设计了！」 |
| **既有法源** | 仓级 `CLAUDE.md` 第 0 条「代码对角色交上来的东西没有拒收权，也不得因形状不合中止本局」；[ADR 0074](0074-gate-province-reorg-jishizhong-chaiyuan-split.md) `gate-non-mandatory`（交卷闸语义零改动）；gatekeeper 合法 `status=pass`（`src/gatekeeper-role.ts`）；近邻 [ADR 0055](0055-shape-validation-failure-must-not-abort-the-run.md)（形状校验失败不得中止本局——本例不重写该条） |
| **票庭核实** | run `01a05f9e-b95a-7791-8f0a-9b0287c3ba20`：写侧合法、读侧 bug |
| **子票** | #597 |
| **实证接缝（修复前）** | `src/analyst-gate-cycles-read.ts` 读侧把合法 gate pass 判为不可读 |

### 第 3 例 — 引擎／宿主失败后活进程须响亮终局

| | |
| --- | --- |
| **decision key** | （无——本例**不是** owner 裁定，不入院下 authority） |
| **值** | 引擎／宿主失败后，仍存活的进程须响亮终局；不得无声停留在 running |
| **权威来源** | **现行法适用**（失败诚实宪法；[ADR 0018](0018-activation-fails-closed.md) 响亮终结；[ADR 0071](0071-engine-detour-failure-seat-fallback-declaration.md) 引擎失败＝整条 run 失败）。**无 owner 专属原话，不得标作 owner authority。** |
| **票庭核实** | run `01a05fa6-3d5f-725c-a537-f3a8e1cd633e`：typed 基础设施失败申报后宿主未收口 |
| **子票** | #593 |
| **本票不主张** | 被杀／崩溃的孤儿 run 无法自写终态（生命周期归共享信封，见 ADR 0018）。若需处置，另立子案落到共享生命周期／监督接缝，只写外部终态。本票不主张、不写施工。 |

### 第 4 例 — 中断的腿不整轮作废（负面裁定）

| | |
| --- | --- |
| **decision key** | `interrupt-does-not-void-round` |
| **值** | 中断的腿不整轮作废；「one-shot ⇒ 禁 resume ⇒ 中断即作废」属未获批的机制膨胀 |
| **权威来源** | owner authority（负面裁定） |
| **绑定原话** | 「什么时候又有one shot腿这个概念了？」 |
| **出处核** | 「one-shot」二字仅见 #572 票面（命令面形状描述）；全仓 ADR 零命中；「不可 resume、中断即整轮作废」是实现对该词的自行扩张，无任何法源写明。#572 所引「judge 式 one-shot 模式」自相矛盾（judge 腿可 resume） |
| **子票** | #599 |
| **实证接缝（修复前）** | `src/public-cli/cli.ts` 对 `ONE_SHOT_ROLES` 禁 resume；`src/packaged-role-registry.ts` 的 `ONE_SHOT_ROLES` 表 |
| **明确不写入** | 旧评论「从卷宗断点恢复或至少半径受限」二选一——本 ADR 只裁负面（不作废），不处方恢复机制 |

## Decision keys 总表（仅 owner 裁定条）

| key | 值 | 绑定原话（逐字） |
| --- | --- | --- |
| `unknown-seat-skip` | 共享配置未知席位键跳过留痕，不炸 CLI | 「这种没有的席位跳过就好。直接报错？你设计的系统怎么这么喜欢报错？」 |
| `gate-receipt-format-must-not-abort` | 闸回执格式病不得中止已受理交卷 | 「又来了！我他妈骂过你多少次这种设计了！」 |
| `interrupt-does-not-void-round` | 中断的腿不整轮作废；one-shot 禁 resume 扩张未获批 | 「什么时候又有one shot腿这个概念了？」 |

第 3 例无 decision key。本 ADR 正文中未被上表绑定的措辞属驱动方综合，不主张 owner authority。

## 与既有法源的关系

- **不 supersede** ADR 0018／0055／0071／0074；本票只按例引用。
- **不**把护栏三问重写成新法；引用宿主全局 #11／#12 既有判据。
- **不**把第 3 例写成 owner 新裁；它是对失败诚实宪法＋0018＋0071 的适用记载。
- 起居录真源：`ticket-provenance/bf7db3a1fea244ba0c173404b5abb382/` 条 13＝现正文。

## 实施归属

| 例 | 子票 | 本 ADR 做的事 | 本 ADR 不做的事 |
| --- | --- | --- | --- |
| 1 | #592 | 记载 `unknown-seat-skip` | 改 `config.ts` |
| 2 | #597 | 记载 `gate-receipt-format-must-not-abort` | 改读侧 |
| 3 | #593 | 记载现行法适用口径 | 改宿主收口；处置孤儿 run |
| 4 | #599 | 记载 `interrupt-does-not-void-round` | 设计 resume／断点恢复机制 |
