> Historical research: this scan records pre-Issue #28 surfaces and is not a current implementation inventory.

# #58 大扫除：不完全证据索引

## 身份与边界

本文是一次历史扫描留下的**不完全证据索引**。它只记录已读证据和 grep 线索，供 #58 施工前、施工中和施工后的按类全仓反向扫描参考。

它不是施工白名单、任务清单、完整性证明、验收清单、新 gate 或新 decision source。条目缺席不表示不在范围内，条目出现也不自动决定处置；实际范围、类别裁决、保留例外和验收方法只来自 [GitHub issue #58](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/58) 与其 accepted ADR 0019–0045。#58 要求一个 issue、一个 PR、一次 merge；内部工作不能把本文变成另一套分包或次序。

本索引的历史扫描目标是 commit `58f70f10ffc2da3a3a602e23fa8a8d65a61fa13a`。随后 `3fb3e625ff5c9618a965e5ae9a3051f984731c35` 修正了 ADR authority chain，并明确了 Navigator 的 #28 deferral 等边界。`58f70f1..3fb3e62` 只改 `CONTEXT.md` 和 ADR；下列生产源码线索在当前 HEAD `3fb3e625ff5c9618a965e5ae9a3051f984731c35` 复核时没有对应源码 diff。

本地 `.ak/work/issues/58/design.md` 是 ignored/untracked 的过程材料，不是本文 authority，也不用于补充或改写 issue/ADR 决定。

## 证据质量与覆盖

历史扫描对 `src/`、`test/`、`schemas/`、`scripts/`、`bin/`、`packets/`、`docs/`、`README.md` 和 `package.json` 做过 D1–D6 与 Collector 运营批次法相关机械签名的 grep。这个范围说明搜索发生过，不证明同类已穷尽。

当前复核中逐字读过，以下标为 **[读]**：

- `src/compliance-transport.ts`
- `src/package-contracts/worker-output.ts`
- `src/package-contracts/judge-output.ts`
- `src/package-contracts/navigator-output.ts`
- `src/package-contracts/fixer-packet.ts`

其余下列位置只标 **[grep]**：它们是待沿真实 consumer 复核的线索，不保证类别归属、处置或完整行号。尤其是 `collector-*`、`doctor-contracts.ts`、`merger-contracts.ts`、`reviewer-*`、测试和文档，本文没有冒充逐文件通读。

未完成的证据工作包括：逐条区分测试中的行为 oracle 与纯格式断言；逐段阅读 README/docs/packet 叙述；沿每个保留项找到真实 key/reference、I/O、external limit 或 branch consumer；施工后按同一行为类别重扫全仓。

## 类别线索

以下分组沿用 issue #58/ADR 的类别语言，仅作为发现索引。每类都必须重新全仓扫描；不能只处理表中路径。

### D1：闭合对象、精确键集合、未知字段拒绝

**[读]**

- `src/compliance-transport.ts`：tool schema 使用 `additionalProperties: false`；`readComplianceDecision` 要求精确双键，并要求 `pass` 携带空 `violations`。
- `src/package-contracts/worker-output.ts`：Coder validator 通过 `exact()` 闭合输出；另见 D3 的 `commitSha`。
- `src/package-contracts/judge-output.ts`：`hasExactKeys()` 闭合 verdict、class、fix 和 decision gate；`converged` 有专门的 extra-key 拒绝。
- `src/package-contracts/navigator-output.ts`：`rec()` 把必需字段检查与精确键数绑定。该文件只作为发现证据；依 ADR 0020/0045，Navigator 修正归 #28，#58 不修改 Navigator。
- `src/package-contracts/fixer-packet.ts`：TypeBox schema 与 `parseFailure` 都要求 prerequisite 精确 `{id, requirement}`。其中 prerequisite identity/reference 语义须按 #59 与 ADR 0039 的真实 consumer 保留；精确键和 ID 拼写不是因此整体豁免。

**[grep]**

- `src/package-contracts/reviewer-output.ts`
- `src/collector-config.ts`, `src/collector-tool-schemas.ts`
- `src/doctor-contracts.ts`, `src/merger-contracts.ts`
- `src/reviewer-role.ts`, `src/judge-role.ts`, `src/navigator-contracts.ts`
- `src/activation-trace.ts`
- `schemas/*.schema.json`
- contract/role tests 中的 extra-key rejection

这些命中不能机械地全部删除：真实 status 分支必需字段、sole-final、live binding 和真实 reference consumer 属 issue 已批准的保留类别；未知字段拒绝与重复 shape owner 才是本类扫描对象。

### D2：表现形式法条

**[读]**

- `src/package-contracts/navigator-output.ts`：小写 SHA-256/OID 正则；再次受 #28 deferral 约束。
- `src/package-contracts/judge-output.ts`：class `name` 禁逗号；optional `note` 提供时被要求 trim 后非空。
- `src/package-contracts/fixer-packet.ts`：prerequisite ID 字符集正则与 nonblank `requirement`。

**[grep]**

- OID/digest/UUID 拼写：`src/navigator-contracts.ts`, `src/merger-contracts.ts`, `src/git-object-id.ts`, `src/uuidv7.ts`, `src/package-contracts/reviewer-output.ts`, `src/reviewer-pinned-git.ts`
- 大小写/NFC/排序：`src/collector-config.ts`, `src/collector-role.ts`, `src/reviewer-admission.ts`, `src/reviewer-bundle-materializer.ts`, `src/reviewer-construction.ts`, `src/reviewer-git-snapshot.ts`, `src/package-contracts/terminating-tools.ts`, `src/doctor-contracts.ts`
- JSON/base64/UTF-8 呈现：`src/collector-config.ts`, `src/exact-utf8.ts`, `src/merger-contracts.ts`

外部真实语义不能由关键词误杀。例如 GitHub login 的 case folding 命中 `src/collector-evidence.ts`、`src/collector-ledger.ts`、`src/collector-github.ts`；是否保留由实际 GitHub consumer 语义决定。内部稳定输出排序也不等于输入拒绝。digest 现场字节绑定可保留，但 hex 呈现本身不取得拒绝权。

### D3：重复身份外壳与无 reader branch 的 version

**[读]**

- `src/package-contracts/worker-output.ts`：Coder output 仍接受可选自报 `commitSha`，并对 `planned` 另加联动拒绝；issue #58/ADR 0024 明确删除该字段。
- `src/package-contracts/navigator-output.ts`：读取 `version === 1`；只记录为 #28 线索。

**[grep]**

- Reviewer `{text, utf8Length, sha256}` 与 `version`：`src/package-contracts/reviewer-output.ts`, `src/reviewer-role.ts`, `src/reviewer-pinned-git.ts`, `src/reviewer-prompt-identity.ts`
- 其他 version：`src/collector-config.ts`, `src/merger-contracts.ts`, `src/reviewer-admission.ts`
- Coder `commitSha` 的其他表达：`src/package-contracts/terminating-tools.ts`

同名字段不等于同类语义。`src/package-contracts/fixer-output.ts` 的 per-class `commitSha` 受 #59 已批准 settlement 语义约束，不能因 Coder 字段同名而删除；但其展示限制、闭合 shape 或重复 validator 仍须按 #58 独立分类。

### D4：package 自设任意上限

**[grep]**

- `src/doctor-contracts.ts` 的 evidence page limit
- `src/collector-evidence.ts` 的 snapshot/receipt byte ceilings
- `src/collector-config.ts` 的 request-body byte ceiling
- `src/collector-ledger.ts` 的 wait ceiling
- `src/navigator-evidence.ts`, `src/navigator-role.ts` 的 read limits（仅 #28 线索）
- `src/assisted-acquisition.ts` 的 evidence ceiling（随 Assisted 机制删除）
- `src/compliance-transport.ts` 的 `maxTokens` 是生成预算而非输入 shape 拒绝；本文不再断言它当然在类内或类外，须按真实外部硬限制、消费后果和 issue 的行为定义分类。

`src/collector-github.ts` 的 `per_page` 命中看起来是 GitHub API 参数，但仅 grep 不足以证明阈值 authority；应在 adapter consumer 处核对，而不是按数字常量批量改动。

### D5：平行 schema、validator 与 parity 表达

**[grep]**

Navigator receipt 的仓内表达包括：

- `schemas/navigator-receipt-v1.schema.json`
- `src/navigator-contracts.ts` 的 schema import 与 active validator
- `src/package-contracts/navigator-output.ts` 的 recorded validator（该文件已读）
- `test/schema-contract-parity.test.ts`

仓内引用搜索只找到发布 JSON 被 `src/navigator-contracts.ts` 引用；这只说明**仓内未发现另一个生产 consumer**，不能证明不存在包外 consumer。整组是 ADR 0042/0045 要求记录但 defer 给 #28 的线索，不授权 #58 改 Navigator。

其他 **[grep]** 线索：

- `schemas/collector-legs-v1.schema.json`
- `schemas/assisted-call-v1.schema.json`
- `schemas/activation-trace.schema.json`
- `scripts/generate-activation-trace-schema.ts`
- Judge/Merger tool schema 与 runtime validator
- `test/schema-contract-parity.test.ts`

issue/ADR 要求沿真实边界收薄为一个 owner 或删除无人消费发布面；本索引不指定采用哪一种实现，也不把“有多个文件”本身当作完整证明。

### D6：已判删除机制的专属格式面

**Assisted Runner [grep]**：`src/assisted-*`, `bin/ak-assisted-run.js`, `scripts/build-assisted.mjs`, `schemas/assisted-call-v1.schema.json`, `src/role-runtime.ts`, `package.json`, README 以及 `test/assisted-*` 和其他引用 Assisted contract 的测试。ADR 0020 的决定是完整删除 Assisted 专属实现/公开面；这个路径集合只是已发现入口，不是残余清单。

**activation healthy trace [grep]**：`src/activation-trace.ts`, `src/role-runtime.ts` 的 stage/healthy emission, `schemas/activation-trace.schema.json`, `scripts/generate-activation-trace-schema.ts`, `package.json`, `test/activation-envelope-contract.test.ts` 及其他 trace assertions。ADR 0019 保留 model turn 前 fail-closed barrier 与真实 failure cause，删除健康 lifecycle trace；不能把“删 trace”误读成删 barrier。

### Collector 运营批次法

**[grep]**：`src/collector-ledger.ts`, `src/collector-receipt.ts`, `src/collector-role.ts` 中的 `batch`, `singleton`, `poison`, `fatal` 与相应测试。ADR 0041 保留 sole-final submission，删除 singleton operational batch、whole-message classifier 和 sibling poison/fatal 等运营批次法。

`fatal` 等词不能按文本批量删除：表达未识别异常真因或 documented external failure 的路径必须保持失败诚实；只有运营批次分类属于本类。

## 已有设计对三处历史疑问的归类

以下不是新 Judge ruling，只是把原扫描的三处“待裁决”按 issue #58 与 accepted ADR 重新归位：

1. **Navigator receipt 中的 Assisted 旅程字段**：记录为扫描线索，但实现仍归 #28。ADR 0020 删除 Assisted-only surfaces，同时明确 #58 不修改或重建 Navigator；Assisted 删除不能被用作在 #58 改 Navigator 的授权。
2. **Judge class `name` 唯一性**：`src/package-contracts/judge-output.ts` 当前确有 `Set` 拒绝重复 name，但本次已读检查没有证明按 name 建表、解引用或归属的 consumer。ADR 0039 只允许为已证明的真实 key/reference consumer 保留唯一性；不能因“可能用于对账”自行创造例外。
3. **optional `note` 非空**：当前 validator 对提供的 note 作 nonblank 拒绝。issue 的既有裁决是 optional/free 字段不因自身格式被拒绝，除非 consuming branch 真正需要它；当前 `note` 不为任何 status 分支必需，因此不需要新判词。其他 optional 字段仍须逐 consumer 应用同一既有规则，不能从这个实例泛化出新格式法。

## 使用方式

施工者应从当前施工 HEAD 沿真实边界正向追 consumer，再按 issue 的行为类别反向扫 validator、schema、parser、runtime、持久化、测试和文档。本文只帮助定位起点。任何保留实例都应能引用 issue/ADR 已批准例外，并指出真实 consumer 与静默失败后果；任何新发现的同类实例都不能因未列在本文而跳过。施工后按同类重扫，验收行为而不是给本文条目打勾。
