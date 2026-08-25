# 判官「可信 typed 指针 + 抽查」白名单草案（#448 D）

> **状态：待御批、未生效。**  
> 本文件是治理法直改素材，**不是**施工授权。在陛下御批并落宪之前：  
> - 不得降低大理寺/审刑院/符宝郎的独立核验义务；  
> - 不得被工厂腿、修正案或 README 当作已生效行为契约；  
> - 任何「免重验」实现均属越权。

## 依据

- 票面 #448 D：C 诊断产出「机器已录 typed 事实」清单后，拟白名单**另呈御批**。  
- 诊断真源：[`2026-08-25-judge-verdict-rework-amplification.md`](./2026-08-25-judge-verdict-rework-amplification.md)（asOf `2026-08-25T06:15:18Z`）。  
- 安全性假设（**待检验，非定论**）：r1 基线 20 次打回 primary 均落在 LLM 主张类；**未见** typed 机器事实算错样本。拍板权在陛下。

## 拟议白名单范围（草案）

仅当拟判引用的事实同时满足：

1. **机器已跑**：来自父腿/官卷/生命周期的 typed 字段或 closed toolIntervals；  
2. **已落卷**：指针可开卷（runId / toolCallId / 路径 / sha256）；  
3. **类别 ∈ 下表**；

则允许判官以**可信指针 + 有界抽查**代替对该条的逐项重算——**仍须**对非白名单主张与全部 OWNER 点名项做独立核验。

| 候选 ID | typed 事实类 | 拟信任动作 | 仍须核验 |
| --- | --- | --- | --- |
| W1 | `ak_judge_output` / 官终局的 `status` 枚举与 `isError` | 可引用历史提交次数/信道分布而不重放 LLM | 不得用其证明「内容正确」 |
| W2 | gate-cycles `officerWallMs` span（startedAt/endedAt） | 可引用已发表 gate-cycles 数字 | 类归因仍由报告层负责 |
| W3 | 冻结附件 `sha256` + byteLength | 可声明「附件字节未变」 | 附件语义仍要读 |
| W4 | admitted-request 结构字段（issue/role/runId） | 可引用身份绑定 | 票面正文仍要读 tracker/真源 |
| W5 | closed toolIntervals 的 toolName + duration（非 command 文本） | 可汇总工具占用 | **command 语义分类不在白名单**（除非另批） |
| W6 | 打包角色 terminating receipt 的 discriminator（status/judgeStatus） | 可引用终局形态 | findings/note 散文不在白名单 |

## 明确排除（草案默认不信任）

- 任何 findings / note / 报告散文 / bash.command 文本  
- 「已独立核验 src/…」类主张  
- OWNER 点名交付是否齐全  
- 法源/源码引语是否过度解释  
- 未落卷的口头或 session 外计算  

## 抽查义务（草案）

若御批生效，建议最低抽查（数值待批）：

- 每个 converged 判词：对白名单引用至少抽查 **N=1** 条开卷核对；  
- 每个 continue 修复轮：对上轮已信任指针若复用，须声明 pointer 未变（sha256/span 键），否则退出白名单。  

## 生效条件

1. 陛下明示御批本草案或修订稿；  
2. 修订进入仓级宪法/ADR 真源（直改通道）；  
3. 施工票单独授权实现与测试。  

**在此之前本草案零效力。**
