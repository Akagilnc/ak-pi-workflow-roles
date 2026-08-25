# 2026-08-25 判词返工放大诊断（#448 C 首单）

> 票庭 r5 已 converged；本报告只回答 r1 固定基线上 33 次拟判提交 / 20 次打回的**根因分布与义务重量**，不施工削减、不降证据标准。
> 统计 regime：LLM 软判合法；引证为卷宗指针（runId / 官卷 file / toolCallId）；不誊 findings 原文进报告。

## 取数口径（闭合）

| 项 | 值 |
| --- | --- |
| asOf（冻结时刻） | `2026-08-25T06:15:18Z` |
| **主样本窗（r1 固定基线）** | `[PR #452 merge 2026-08-24T17:48:17Z, PR #457 merge 2026-08-25T05:02:39Z)` |
| 入总体判据 | 簿 `ak-pi-workflow-roles` 下 `runs/<runId>@judge` 目录存在，且 runId UUIDv7 嵌入时间 ∈ 主样本窗 |
| 分析单位 | **每次拟判提交**（父腿 `ak_judge_output` toolCall 一次＝一单位） |
| 打回定义 | 对应 `toolResult.isError === true`（含符宝郎/门下省封驳与审刑院 revise） |
| 耗时字段 | 官卷 / 审刑院卷 `session/auditor-roles/*.jsonl` 的 first→last usable timestamp → `auditorWallMs`（gate-cycles 同核的 span；**分析归因口径，非模型 turn 内因果分时**） |
| 多 finding 归因 | **互斥 primary-root 一类**；该次打回全部 `auditorWallMs` 只计入 primary；secondary 仅多标签次数、**不分摊时长** |
| 提交间隙父腿时间 | **不归因**到任何 primary 类 |
| 义务称重代理 | 拟判 `arguments` JSON UTF-8 **bytes**；对应 assistant 消息 `usage`（若卷中有）。**局限**：bytes≠token 计费、usage 缺席时不臆造；不得把连续模型 turn 墙钟臆分成多项因果耗时 |
| asOf 后新增 run | 本报告**不入主分母**；另立分母须新开诊断 |

## 目录总体对账（互斥、守恒）

| 类别 | 定义 | 数 |
| --- | --- | ---: |
| **directoryTotal** | 主样本窗内 `@judge` 目录 | **13** |
| readable（有 session.jsonl 且可枚举拟判提交） | 同上 13 个均可读 | 13 |
| live / missing_invocation / corrupt | — | 0 |

**守恒**：`13 = 13 (readable) + 0`。

主样本 13 runId（时间序）：

1. `01a034f1-75bf-71a6-bcf5-d1299145b1a5`
2. `01a03513-e21a-7641-926d-83c0140c4e0a`
3. `01a03532-fc81-7316-889a-5c93a916fa17`
4. `01a03553-4cc3-70e4-b1c7-f7012806e53e`
5. `01a03574-88e2-72e7-8636-b933352418b2`
6. `01a036aa-2672-7ddd-879e-53d693acdd0b`
7. `01a036b7-923c-7093-8d11-f069097c05a8`
8. `01a036c9-ed9c-76e0-8250-0ae5e04fd647`
9. `01a036dc-fc36-7935-88eb-172758e98cf6`
10. `01a036f9-0845-7fb9-94ac-e09b13e951f2`
11. `01a03706-89af-7dcd-a7ce-52291d142fc3`
12. `01a03723-a26b-7850-bf45-b04e907975d1`
13. `01a03731-f0e8-7f95-b59f-6e0e3bca2bc3`

## 提交与打回总体

| 项 | 数 |
| --- | ---: |
| 拟判提交（`ak_judge_output`） | **33** |
| 其中打回（`isError:true`） | **20** |
| 其中接受（`isError:false`） | **13** |
| 打回·门下省/符宝郎（`Gatekeeper requires rewrite`） | **9** |
| 打回·审刑院（`Judge verdict violates its soul`） | **11** |
| 配对 gate-cycles 官轮（dispatch+officer） | **33**（与提交数同阶；每提交进闸一次） |
| 官轮 pass / bounce | 24 / 9 |
| 审刑院卷（`ak_soul_audit_decision` accepted） | 24（pass 13 + revise 11） |

与 r1 固定基线「13 run / 33 交卷 / 20 打回」一致（庭上两轮独立重算口径：父腿 toolResult 错误数）。

## Primary-root 分类（互斥）

**类定义（申报，可重算）**：

| primary-root | 定义 |
| --- | --- |
| `unverified_claim` | 判词主张已核验/已对齐，但卷宗工具轨迹未见打开对应源头（或仅 stat/name-status/测试冒充内容核验） |
| `missed_named_item` | 票面或 OWNER **点名**交付项在拟判中被漏列、误称已交付、或未进入处置 |
| `misquote` | 歪引/过度解释法源或源码、或关键事实计数/指针与卷宗不符 |
| `format_obligation` | 纯格式/字段形状义务导致的打回（本基线 **0**） |
| `other` | 其余（错误 escalate 处置、修复边界漏同类、宪法适用失败但不落入上表者） |

**逐次打回 primary 账**（时长＝拒绝该次拟判的官卷/审刑院卷 span；指针到 run + 卷 file）：

| # | runId | 闸 | primary-root | auditorWallMs | 指针（卷） |
| ---: | --- | --- | --- | ---: | --- |
| 1 | `01a034f1-…` | soul | missed_named_item | 87860 | `…/auditor-roles/2026-08-24T18-08-18-305Z_01a034f5-…jsonl` |
| 2 | `01a03532-…` | soul | unverified_claim | 72026 | `…/2026-08-24T19-21-44-157Z_01a03538-…jsonl` |
| 3 | `01a03553-…` | notary | missed_named_item | 68565 | `…/2026-08-24T19-56-01-621Z_01a03558-…jsonl` |
| 4 | `01a03553-…` | soul | other | 94839 | `…/2026-08-24T19-58-32-450Z_01a0355a-…jsonl` |
| 5 | `01a03574-…` | notary | missed_named_item | 38601 | `…/2026-08-24T20-31-43-145Z_01a03578-…jsonl` |
| 6 | `01a03574-…` | soul | other | 61184 | `…/2026-08-24T20-33-43-592Z_01a0357a-…jsonl` |
| 7 | `01a03574-…` | notary | misquote | 87588 | `…/2026-08-24T20-35-20-105Z_01a0357c-…jsonl` |
| 8 | `01a036b7-…` | soul | unverified_claim | 65956 | `…/2026-08-25T02-27-26-461Z_01a036be-…jsonl` |
| 9 | `01a036b7-…` | notary | misquote | 81024 | `…/2026-08-25T02-30-45-234Z_01a036c1-…jsonl` |
| 10 | `01a036c9-…` | soul | misquote | 84175 | `…/2026-08-25T02-48-00-742Z_01a036d1-…jsonl` |
| 11 | `01a036dc-…` | soul | unverified_claim | 110755 | `…/2026-08-25T03-08-50-365Z_01a036e4-…jsonl` |
| 12 | `01a03706-…` | soul | unverified_claim | 62620 | `…/2026-08-25T03-52-53-518Z_01a0370c-…jsonl` |
| 13 | `01a03706-…` | soul | other | 78571 | `…/2026-08-25T04-00-48-661Z_01a03713-…jsonl` |
| 14 | `01a03723-…` | soul | misquote | 61191 | `…/2026-08-25T04-25-00-940Z_01a0372a-…jsonl` |
| 15 | `01a03731-…` | notary | misquote | 95635 | `…/2026-08-25T04-38-09-021Z_01a03736-…jsonl` |
| 16 | `01a03731-…` | notary | misquote | 86218 | `…/2026-08-25T04-41-16-676Z_01a03738-…jsonl` |
| 17 | `01a03731-…` | notary | misquote | 111299 | `…/2026-08-25T04-43-16-650Z_01a0373a-…jsonl` |
| 18 | `01a03731-…` | notary | misquote | 108657 | `…/2026-08-25T04-45-32-287Z_01a0373c-…jsonl` |
| 19 | `01a03731-…` | notary | misquote | 109346 | `…/2026-08-25T04-47-54-379Z_01a0373f-…jsonl` |
| 20 | `01a03731-…` | soul | misquote | 89827 | `…/2026-08-25T04-51-37-024Z_01a03742-…jsonl` |

（完整路径前缀：`~/.ak-roles/books/ak-pi-workflow-roles/runs/<runId>@judge/session/auditor-roles/`。）

### 逐类汇总（次数 · 耗时 · 占比）

| primary-root | 次数 | auditorWallMs Σ | 占打回墙钟 | 占打回次数 |
| --- | ---: | ---: | ---: | ---: |
| `misquote` | **10** | **914960**（15.25m） | **55.3%** | **50%** |
| `unverified_claim` | **4** | **311357**（5.19m） | **18.8%** | **20%** |
| `other` | **3** | **234594**（3.91m） | **14.2%** | **15%** |
| `missed_named_item` | **3** | **195026**（3.25m） | **11.8%** | **15%** |
| `format_obligation` | **0** | 0 | 0% | 0% |
| **合计** | **20** | **1655937**（27.60m） | 100% | 100% |

**Secondary 多标签（仅次数，不分摊时长）**：

| secondary 标签 | 次数 | 说明 |
| --- | ---: | --- |
| `notary_channel` | 9 | 打回信道为符宝郎 |
| `soul_audit_channel` | 11 | 打回信道为审刑院 |
| `repeated_same_defect_cluster` | 5 | 同一 run `01a03731-…` 上连续 misquote 链（#15–19） |
| `owner_named_gap` | 3 | 与 `missed_named_item` 同批，点名 OWNER 行 |

### 分类方法（可复核）

1. 读父腿 `ak_judge_output` 的 error toolResult 文本前缀，区分 notary / soul 信道。  
2. 打开对应官卷/审刑院卷 accepted 终局 toolCall 的 `findings` / `violations`（指针上表；正文不誊）。  
3. 按上表类定义选**唯一** primary；若多 finding，取决定封驳的主因（通常即 findings[0] 主题）。  
4. `auditorWallMs` 取该卷 span，整段计入 primary。

## 义务称重（可观察代理）

| 代理 | 全体 33 提交 | 20 打回 | 13 接受 |
| --- | ---: | ---: | ---: |
| 拟判 JSON bytes · 合计 | 167825 | 91082 | 76743 |
| 拟判 JSON bytes · 中位 | 4974 | 4786.5 | 5620 |
| 拟判 JSON bytes · 均 | 5086 | 4554 | 5903 |

**观察（非因果断言）**：

- 打回提交的拟判 bytes **不高于**接受提交（中位/均均更低）→ 本基线**不支持**「判词越写越长所以被打回」的简单体积假说。  
- 返工放大更贴近 **重复核验义务 + 误引/未核后的整轮重跑**（见 primary 分布），而非格式字段膨胀。  
- 父腿 assistant `usage` 在多份卷中缺席或不完整；本报告**不**用残缺 usage 拼 token 总量。完整 token 称重若需要，须另立 asOf 后补扫且申报缺测。

**局限（明示）**：bytes 是序列化体积代理；不包含工具轨迹长度、不包含官取证 bash 次数；提交间隙父腿墙钟未计入 primary。

## 机器已录 typed 事实清单（供 D 草案消费）

下列事实在闸/生命周期中**已由机器跑过并 typed 落卷**（非 LLM 散文主张）。D 白名单若采纳，仅能覆盖此类——且须御批：

| 键 | 机器来源 | 基线观察 |
| --- | --- | --- |
| `toolResult.isError` on `ak_judge_output` | 父腿 session | 33 提交可枚举 |
| gate dispatch/officer `status` + `officer` | `auditor-roles` accepted toolResult pair | 33 配对轮 |
| `officerWallMs` / span | gate-cycles 同核 timestamp span | bounce 9 轮可加总 |
| soul audit `status` revise/pass | `ak_soul_audit_decision` accepted | 24 卷 |
| 冻结附件 sha256 / admitted-request | `runs/*/attachments`, `admitted-request.json` | 各 run 在场 |
| 测试命令 closed toolIntervals | 父腿 typed intervals（#446 报告已用） | 本诊断未再汇总 |
| 打包角色终局 discriminator | terminating tool details.status / judgeStatus | 与 isError 联立 |

**未见**「typed 机器事实本身算错」导致的打回样本；20 次 primary 均落在 LLM 主张/对齐/引语类（与庭上抽样假设方向一致，**仍非定论授权 D**）。

## 诊断结论（供削减修正案，不施工）

1. **最大头是 `misquote`（10/20，55% 打回墙钟）**，且 5/10 集中在单 run 连续重写链 → 削减应优先考虑「已核事实的稳定引用形态 / 禁止在未打开源头时改写对方前提」，而非砍独立核验。  
2. **`unverified_claim`（4/20，19% 墙钟）** 全部是审刑院 intercept：拟判宣称累计实现已核但未读 src → 与「独立核验义务一分不降」同向；减负不能变成跳过打开源头。  
3. **`missed_named_item`（3/20）** 全是 OWNER/票面点名行 → 进单符宝郎（本票 A）可拦截派单漏项，但**不能**替代拟判生成后新生的歪引（B 已否决）。  
4. **格式义务本基线为 0** → 瘦身 schema/字段形状**不是**本窗口主因。  
5. 拟判 bytes 代理**不**支持「义务文本过长」为主因。

**削减方案不在本报告施工**；须以修正案回票庭续审（票面 AC）。

## D 待御批草案（未生效）

见同目录：[`2026-08-25-judge-typed-trust-whitelist-draft.md`](./2026-08-25-judge-typed-trust-whitelist-draft.md)。  
状态：**待御批、未生效**；不得被施工腿当作已授权降标。

## 机器摘要（可核）

```json
{
  "ticket": 448,
  "asOf": "2026-08-25T06:15:18Z",
  "window": {
    "startInclusive": "2026-08-24T17:48:17Z",
    "endExclusive": "2026-08-25T05:02:39Z",
    "label": "PR#452-merge..PR#457-merge"
  },
  "population": {
    "directoryTotal": 13,
    "readable": 13,
    "excluded": 0,
    "conservation": "13=13+0"
  },
  "submissions": 33,
  "bounces": 20,
  "accepted": 13,
  "bounceByChannel": { "notary": 9, "soul_audit": 11 },
  "primaryRoot": {
    "misquote": { "count": 10, "auditorWallMs": 914960 },
    "unverified_claim": { "count": 4, "auditorWallMs": 311357 },
    "other": { "count": 3, "auditorWallMs": 234594 },
    "missed_named_item": { "count": 3, "auditorWallMs": 195026 },
    "format_obligation": { "count": 0, "auditorWallMs": 0 }
  },
  "auditorWallMsTotal": 1655937,
  "draftBytes": {
    "all": { "n": 33, "sum": 167825, "median": 4974, "mean": 5086 },
    "bounce": { "n": 20, "sum": 91082, "median": 4786.5, "mean": 4554 },
    "accepted": { "n": 13, "sum": 76743, "median": 5620, "mean": 5903 }
  },
  "attributionRule": "mutex-primary-root; full auditorWallMs to primary; secondary labels count-only; parent-gap excluded",
  "reduction": "deferred-to-amendment",
  "whitelistDraft": "docs/research/2026-08-25-judge-typed-trust-whitelist-draft.md"
}
```
