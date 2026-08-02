# #58 大扫除：构造计划（待 Judge plan 裁决）

## 身份与边界

本文是 `packets/judge-plan.md` 模板的一次实例化：按 Behavior / Owner / Red / Green / Scope 记录 #58 的拟施工变更。

它**不是** authority，不是验收合格证明，也不声称施工已发生。文件名不是判词。范围与类别裁决只来自 [issue #58](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/58) 与 accepted ADR 0019–0045；本文只把它们落成可施工、可证伪的条目。

计划需先过 Judge plan 裁决，再交 Fixer 施工。

## 施工阻塞与基线失效（ADR 0046）

**本计划当前不可施工。** ADR 0046 将 #58 的施工时点排在 [#28](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/28) 合并之后。

两项后果直接作用于本文：

1. **Navigator 例外取消。** #28 合并后，ADR 0020/0026/0027/0028/0030/0035/0045 的 Navigator deferral 解除。下文各条 Scope 中所有「Navigator 不动（#28）」「Navigator 边界不动」的限定语，**仅在 #28 合并前有效**；其后 Navigator 的同类实例回落为普通实例，按各自类别裁决一并处置。P3 末尾关于 `test/schema-contract-parity.test.ts` 中 Navigator 半边的待决问题随之消失——届时它只是一个普通的 D5 实例。
2. **证据基线失效。** 本文与两份扫描文档钉在 `69446586ee7e821d47b8ed7f73c1d8fdcf2dbc68`。#28 将改动 Navigator 及其共享接缝，故施工前须在 #28 的 merge commit 上重钉并按同一批类别重扫全仓，并据此补入 Navigator 的实例与 Red。下文的类别裁决、Owner 与各类 Behavior/Green/Scope 骨架不因重扫而改变；变的是实例索引与钉住的 commit。

已完成的 Judge 裁决（`.ak/work/issues/58/runs/judge-scan-adjudication-001`）中，COV1「施工前无需再补扫」以生产源码未变为条件，该条件已失效，须在重扫后重新提交；其余 11 条裁词继续有效并已落入下文 Scope。

## 封存的 authority 身份

| 材料 | 路径 | 身份 |
| --- | --- | --- |
| 票面（范围与类别裁决） | `gh issue view 58` | issue #58 正文 |
| 类别裁决 ADR | `docs/adr/0019`–`0045` | commit `69446586ee7e821d47b8ed7f73c1d8fdcf2dbc68` |
| 施工目标 | 仓库 HEAD | `69446586ee7e821d47b8ed7f73c1d8fdcf2dbc68` |

## 封存的证据身份

证据不是 authority。以下只用于定位实例与复现 Red。

| 材料 | 路径 | SHA-256 |
| --- | --- | --- |
| 收敛版扫描索引 | `docs/research/issue-58-cleanup-scan.md` | `966df7fb10f9590973b590aac2ee3f849848d52b0070c4670bc25d1b68ac5912` |
| 原始 finding 转录 | `docs/research/issue-58-cleanup-scan-findings.md` | `fe4ab0c73a63cf55124eaac17f4ec691a52f956d3e902a5120fc5a9d658da631` |
| 开放问题裁决卷宗 | `.ak/work/issues/58/runs/judge-scan-adjudication-001/task.md` | `49d4d253fa1733ab6c34825534b38575b670005b1ef85a90d2215266a3cc74af` |
| 该次 Judge session（含受理回执） | `.ak/work/issues/58/runs/judge-scan-adjudication-001/session/2026-08-02T14-02-41-090Z_019fc2c8-b442-7af6-9e7f-a565a99363eb.jsonl` | `8e54a33054e297f8a179c9aa4d8f59f6a6aacd990ac0e205b769affda911bba6` |

该 Judge 回执判词为 `continue`，12 条，采纳 9 / 驳回 3 / 上抛 0。下列 Scope 中标注「Judge MJx / BSx」处即引用其裁词。

## 施工总则

- 一个分支、一个 PR、一次 merge；每个变更独立 commit（一次性大扫除）。
- 不新增常驻 scanner、gate、统计机制、第二 driver 或免疫流程。
- 每类删除先用该类现有拒绝反例形成失败测试，再证明接受面扩大。
- 施工中发现的未列同类实例一并处理——本文与两份扫描文档都不是白名单。

---

## P1 Assisted Runner 整删

| Fact | Content |
| --- | --- |
| **Behavior** | 包不再提供 Assisted 调用面；保留角色与 Navigator 的直接调用不受影响。 |
| **Owner** | package public surface（`package.json` 的 `bin`/`files`/`scripts`）、`src/assisted-*.ts` 整个深模块、`src/role-runtime.ts` 的 re-export。 |
| **Red** | 当前 `package.json` 的 `bin` 暴露 `ak-assisted-run`；`src/role-runtime.ts` re-export Assisted 符号；`test/assisted-*.test.ts` 共 9 个文件在当前 HEAD 通过。 |
| **Green** | 包安装后无 assisted bin/export/schema/state writer；`src/`、`bin/`、`schemas/`、`scripts/`、`package.json` 不再引用任何 Assisted 符号或路径；各保留角色与 Navigator entrypoint 仍可调用；`npm test` 与 `npm run build` 通过。 |
| **Scope** | 不修 Navigator（ADR 0020/0045 defer 至 #28）。禁止留兼容 stub、tombstone parser、迁移 reader、只读 status/recover 或第二 driver。`src/{canonical-json,uuidv7,sha256}.ts` 本体不在本条删除范围，其残余消费方复查见 P3。`test/{pi-test-harness,navigator-evidence,navigator-evidence-resource-budget,package-entrypoint.integration}.test.ts` 中的 Assisted 引用随之解耦，但不得借机改 Navigator 行为。 |

## P2 activation 健康 trace 删除

| Fact | Content |
| --- | --- |
| **Behavior** | 健康激活不产生 lifecycle trace；失败仍在首个 model turn 之前 fail closed，且 cause 可追到原异常。 |
| **Owner** | `src/role-runtime.ts` 的共享 activation envelope。 |
| **Red** | 本次 Judge 调用留下的 `.ak/work/issues/58/runs/judge-scan-adjudication-001/stderr.log` 实录健康路径 trace：`{"role":"judge","stageId":"load-and-install","status":"started"}` 与同 stage 的 `"completed"`。健康 trace 现存且确在发。 |
| **Green** | 同形调用的 stderr 不再出现健康 stage 记录；任一 loader/install/preflight 失败时 model-turn 计数保持 0、进程非零退出、抛出或记录的 cause identity/message 可追到原异常；trace 写入失败不再构成健康调用的新失败面。 |
| **Scope** | 保留 fail-closed barrier 与失败 cause（ADR 0019）。不保留 stage registry、started/completed record schema、stderr JSONL、重试 writer 或健康统计。`schemas/activation-trace.schema.json`、`scripts/generate-activation-trace-schema.ts` 与 `package.json` 的 `generate:activation-trace-schema` 步骤随删。不以日志格式、metrics、event registry 或新 gate 替代。 |

## P3 平行 schema / validator 收成单真源

| Fact | Content |
| --- | --- |
| **Behavior** | 一个工具输入或输出边界的字段、类型与 union 叶只由注册给该工具的 schema 定义；runtime 只在其后校验跨字段关系、实时状态与专业语义，不再手写第二份 shape validator。 |
| **Owner** | 各工具注册边界的 schema owner；`package.json` 的 `files`/`exports`。 |
| **Red** | `src/package-contracts/fixer-packet.ts:72` 先 `Value.Check(fixerPrerequisitesSchema)`，`:45` 的 `parseFailure` 随即手写一遍完全同构的逐字段校验；`src/doctor-contracts.ts:94` 与 `:95` 是同一 Doctor 载荷家族的两份边界 validator（仅差一个 `cost` 字段）；`src/collector-role.ts:56` 显示 `registerTool` 的 `parameters` 与 `collectorToolArgumentsValid` 消费同一批 schema 对象，同一契约被 Check 两次。 |
| **Green** | 单一边界 schema 接受后 runtime 不再因同一 shape 二次拒绝；发布包不含无人消费的 schema；语义反例仍由 owner seam 拒绝。 |
| **Scope** | `schemas/collector-legs-v1.schema.json` 整删（ADR 0022）。`schemas/assisted-call-v1.schema.json` 随 P1、`schemas/activation-trace.schema.json` 随 P2。**Navigator receipt 的四份平行表达**（`schemas/navigator-receipt-v1.schema.json`、`src/navigator-contracts.ts` 的 import 与 validator、`src/package-contracts/navigator-output.ts` 的 recorded validator）**记录为线索但不在本次施工**——ADR 0045 明确 defer 至 #28。不以 generator、parity test 或第二 schema registry 替代收口。 |

> **待 plan-Judge 拍**：`test/schema-contract-parity.test.ts` 同时维持 Assisted 与 Navigator 两组 parity。Assisted 半边随 P1 消失；剩下的 Navigator 半边是删（它只是同步维持器，删除不改 Navigator 运行行为）还是留（删它触及 Navigator 相关面，可能撞 #28 deferral）？本计划不自行决定。

## P4 闭合对象 / 精确键 / 未知字段拒绝

| Fact | Content |
| --- | --- |
| **Behavior** | 在所有必需字段相同的情况下，附加未知字段不改变生产分支与结果；缺失必需字段仍拒绝。 |
| **Owner** | 每个真实边界的单一 schema owner；共享 terminating receipt 由 `src/package-contracts/terminating-tools.ts` 收口，不得另留 receipt validator。 |
| **Red** | `src/compliance-transport.ts:113-120` 对 `{status:"pass"}` 抛 `arguments must have exact keys`（要求恰好 `status` 与 `violations` 双键），`:132` 进一步要求 `pass` 携带空 `violations` 数组；`src/package-contracts/judge-output.ts:84` 对多带字段的 converged 抛 `Judge converged forbids extra keys`。 |
| **Green** | 仅含 `{status:"pass"}` 的合规决定被 audit consumer 接受；`{status:"revise"}` 缺失或空 violations 仍拒绝；各 terminating output 的展示性附加字段被投影掉而非拒绝；两者的未知字段均不改变结果。 |
| **Scope** | 不重写各角色状态语义，不删状态真正需要的字段（`revise` 的 violations、Fixer 的 classResults、Doctor 的 evidence）。不以 open-object schema 副本替代。Navigator 边界不动（#28）。`src/compliance-transport.ts` 是五个 auditor 共用的唯一真源——只改测试不改此文件，五个角色运行时行为一条不变。 |

## P5 表现形式法条

| Fact | Content |
| --- | --- |
| **Behavior** | 等价 JSON 数字与键顺序、可解码的 base64/digest 表示、非规范但语义相同的输入得到相同结果；文本只做一次严格 UTF-8 解码。 |
| **Owner** | 首次消费 value/bytes 的模块：Merger input consumer、Collector manifest loader、Collector 激活接缝、外部文本 reader。 |
| **Red** | `src/package-contracts/judge-output.ts:74` 拒绝含逗号的 class name；`src/package-contracts/fixer-packet.ts:4,57` 拒绝不匹配 `^[A-Za-z0-9][A-Za-z0-9._-]*$` 的 prerequisite id；`src/collector-role.ts:234` 对整段 kickoff 自由文本逐字节相等拒绝（Judge BS3 裁定归本类）；`src/merger-contracts.ts:6,43,45` 拒绝非小写 hex 外观与非 canonical base64。 |
| **Green** | 上述输入不再因拼写或呈现形式被拒；真 malformed 的必需 value、以及 digest 字节不相等，仍被拒。 |
| **Scope** | **保留** GitHub login 的大小写折叠（`src/collector-evidence.ts:144,188,248,285,316`、`src/collector-ledger.ts:736`、`src/collector-github.ts:477`）——外部真实语义，删了会把同一作者判成两个人。**保留** `src/merger-contracts.ts:47` 的现场重算摘要相等（ADR 0028 + Judge MJ5）；按 Judge MJ5 的附加要求，删掉 `digestPattern` 后比较必须显式按 digest value 进行，**不得把当前直接字符串比较的隐含小写效果当作既有例外蒙混过关**。保留内部为稳定输出而做的排序。Navigator 的 OID/SHA-256 正则不动（#28）。不新增 canonicalizer。 |

## P6 重复身份外壳与无 reader branch 的 version

| Fact | Content |
| --- | --- |
| **Behavior** | 纯文本按文本交付；无真实多版本读取分支的 version 删除；真实字节身份由现场 owner 重算而非随载荷自报。 |
| **Owner** | Reviewer settlement / receipt owner；Coder terminating tool owner（`src/package-contracts/worker-output.ts`）；各真实 version reader。 |
| **Red** | `src/package-contracts/worker-output.ts:39` 对 `{status:"planned", report:"x", commitSha:"abc"}` 抛错（commitSha 与 status 的联动拒绝）；`src/package-contracts/reviewer-output.ts:99` 要求 `report.utf8Length === Buffer.byteLength(report.text,"utf8")` 且 `report.sha256 === sha256Hex(report.text)`——载荷自证自己的身份壳。 |
| **Green** | Coder 输出不再有 `commitSha` 概念，上述输入不再因该字段被拒；Reviewer 报文按纯文本交付，不再要求随附长度与摘要；删除的 version 字段不再参与任何拒绝。 |
| **Scope** | **保留** Fixer 的 per-class `commitSha` 及 `src/package-contracts/fixer-output.ts:75/95` 的跨类互异（Judge MJ4 以「事实不成立」驳回删除；#58 票面非目标节直接承接 #59 的 per-class commit 身份/互异要求）。保留 runtime-owned Git facts、canonical Skill 内容绑定（ADR 0032）与 digest 字节相等。删除 version 前须逐个证明确无 reader 分支（ADR 0044）。Navigator 的 version 与身份字段不动（#28）。不换另一种 identity envelope。 |

## P7 package 自设的任意上限

| Fact | Content |
| --- | --- |
| **Behavior** | 超过 package 自设阈值但满足外部接口最小条件的输入继续；真正的 OS/provider hard failure 原样失败。 |
| **Owner** | 实际读取或调用的模块，以及唯一外部硬限制的 adapter。 |
| **Red** | `src/doctor-contracts.ts:92,100` 拒绝 `limit > 4096`；`src/collector-evidence.ts:12,13` 的 8 MiB / 32 MiB 上限；`src/collector-config.ts:6` 的 60000 字节 request body 上限；`src/collector-ledger.ts:1017` 对单次 `durationMs` 的额外上限。 |
| **Green** | 上述阈值不再产生拒绝；真实外部失败原样传播。 |
| **Scope** | **保留**（Judge MJ3）`offset` 为整数且 ≥ 0、`limit` 为整数且 ≥ 1、`offset` 不越过内容——这些是分页读取能够实际执行的最小条件，删掉会产生反向或无意义的 coverage 区间；同形的 `src/navigator-evidence.ts:8` 判 keep，两处应对齐。**保留** `src/collector-github.ts:492,501,510` 的 `per_page`（GitHub API 真实参数）。**保留** `COLLECTOR_ELIGIBILITY_MS` 作为 deadline / eligibility 语义（Judge MJ7：`src/collector-ledger.ts:560-681` 仍消费它），只删它充当输入上限的用法。不加配置化 ceiling 或统计。 |

## P8 Collector 运营批次法

| Fact | Content |
| --- | --- |
| **Behavior** | 每个角色仍只有一个被接受的最终回执；运营批次分类不再锁死 invocation。 |
| **Owner** | `src/collector-ledger.ts` 与 `src/collector-role.ts`。 |
| **Red** | `classifyCollectorBatch` 现存并驱动 `latchFatal` 锁死 invocation；sole-final 法在 `assertOutputObservationLaw`、`beginOperational`、`markOutputAccepted`、`buildCollectorReceipt` 四处各写一份。 |
| **Green** | sole-final 仍拒绝第二次交卷；同一 assistant 消息中的兄弟工具调用不再毒化本次 invocation；整条 assistant 消息扫描与 singleton operational batch 不再存在。 |
| **Scope** | 保留 sole-final 交卷边界（ADR 0041）。`fatal` / `poison` 需逐处分辨：表达未识别异常真因或 documented external failure 的路径按失败诚实宪法保留，只删运营批次分级。四份 sole-final 同构表达收成一处（DRY）。 |

## P9 Collector 回执受理缺陷（Judge 裁 fix_now）

| Fact | Content |
| --- | --- |
| **Behavior** | runtime 生成的真实 Collector 回执被自身受理路径识别，并只向 Doctor 投影其实际消费的事实。 |
| **Owner** | `src/package-contracts/collector-output.ts::validateAcceptedCollectorReceipt`、`src/collector-receipt.ts::buildCollectorReceipt`、`src/package-contracts/terminating-tools.ts::acceptedFacts`。 |
| **Red** | `src/package-contracts/collector-output.ts:414` 的闭合键只放行 `["evidenceId","kind","versionId","contentDigest","firstObservedAt","raw"]`，而 `src/collector-evidence.ts:36` 起的 `CollectorEvidenceRecord` 携带 `stableGitHubId` 等十余字段，`src/collector-receipt.ts:726` 原样拷贝记录进回执——真实回执抛 `evidenceRecords[0] has unknown key stableGitHubId`。Judge 已用无落盘内联 probe 机械复现。全仓无测试引用 `validateAcceptedCollectorReceipt`。 |
| **Green** | 由 `buildCollectorReceipt` 产出的真实回执被受理路径接受；`src/package-contracts/terminating-tools.ts:192` 不再返回 `{}`，而是投影 Doctor 实际消费的事实（至少 `status`）。新增的回归测试从真实构造路径进入，而非直接喂手造对象。 |
| **Scope** | 不新建 Collector receipt 的第二真源，不加迁移层或兼容 shape。本条与 P4 同类（闭合键），但因存在现行缺陷与独立 Green 而单列。Judge 认定 `acceptedFacts` 返回 `{}` 构成 ADR 0042 所指 builder/validator 自证循环并丢弃 consumer facts。 |

---

## 明确不属本次施工

| 事项 | 归属 | 依据 |
| --- | --- | --- |
| Navigator 的全部同类实例（闭合键、OID/SHA 正则、version、四份平行 schema） | **仅 #28 合并前**归 #28；其后回落为 #58 普通实例 | ADR 0046 解除了 ADR 0020/0026/0027/0028/0030/0035/0045 的 deferral 前提。重扫后须补入本计划，不再作为范围例外 |
| canonical Skill 的调用路径发现、安装 preflight、调用样板 | #11 | #58 票面非目标节 |
| 运行时能力面的拒绝（工具面闭合集合、required-tool 恰好一份的四处实现） | 不在 #58 扫描范围 | Judge BS1：CONTEXT 将其定义为 role gating，票面扫的是输入/输出/持久化及其 schema；四处各持不同工具集合，无通用 DRY 硬规则要求收一处 |
| 运行环境前置条件的拒绝（model / provider / auth 不可用） | 不在 #58 扫描范围 | Judge BS2：属运行环境而非格式数据，票面已规定其走非回执故障通道 |
| 防止复杂度再次无收益增长的免疫机制 | 独立治理线 | CONTEXT「免疫」词条；两条线不得互相吞并 |

## 验收

1. 对同一批行为类别（P3–P8 各自的类别，加 P1/P2 的机制面）重新做全仓反向扫描。
2. 验收看**同类拒绝行为是否清完并记录有理由的范围例外**，不是本文或两份扫描文档是否逐条打勾（ADR 0045）。
3. 每个保留实例必须映射到已批准例外，并写明真 consumer 是谁、不校验会导致什么不可静默恢复的后果。
4. `npm test`、`npm run typecheck`、`npm run build` 通过。注意：本次删除会连带删除大量断言被删规则的负向测试，**测试全绿不构成范围正确的证据**——范围正确性由第 1–3 步举证。

## 明确不主张

- 文件名不是判词，本文不授权也不证明 Apply 成功。
- 本文不声称施工已发生。
- 本文不产生编排、下一角色或阶段机语义。
- 本文不主张任何机械 schema/runtime 强制。
- 施工次序建议（P1、P2 先删机制以减少后续实例，P3 收口后再做 P4）是合同的推论，不是规定流程。
