# #58 大扫除：深读扫描原始 finding（机器生成）

## 身份与边界

本文是一次 15-agent 并行深读扫描的**原始产出转录**，由脚本从 workflow 结果直接生成，未经人工裁决。

它不是施工白名单、不是验收清单、不是 authority，也不改写 [issue #58](https://github.com/Akagilnc/ak-pi-workflow-roles/issues/58) 与 ADR 0019–0045 的任何裁决。每条 `klass` / `verdict` 是 agent 的判断，**不是 Judge 裁决**；其中已知存在错判（见文末「纠判」节）。

配套的收敛版索引见 [issue-58-cleanup-scan.md](issue-58-cleanup-scan.md)。两份都只是发现证据；实际范围与验收方法只来自 issue 与 ADR。

扫描目标 commit：`58f70f10ffc2da3a3a602e23fa8a8d65a61fa13a`。

## 覆盖

| 区域 | finding 数 | 读过文件数 |
| --- | --- | --- |
| collector-output | 28 | 8 |
| collector-ledger | 58 | 13 |
| collector-io | 57 | 22 |
| reviewer-output | 59 | 28 |
| reviewer-seams | 64 | 31 |
| doctor | 30 | 17 |
| merger | 51 | 24 |
| worker-shared | 44 | 11 |
| navigator | 48 | 22 |
| utils | 33 | 32 |
| 测试面（test/ 下 collector-*、reviewer-*、navigator-*、assisted-* 以及 schema-co | 104 | 65 |
| 测试面（judge-* / fixer-* / merger-* / doctor-* / soul-* / canonical-* / c | 120 | 51 |
| 文档与包发布面（README.md / docs/development-closure.md / packets/ / package.j | 55 | 44 |

按类别：D1=89 · D2=94 · D3=79 · D4=36 · D5=81 · D6=45 · K7=32 · K1=33 · K2=43 · K3=90 · K4=16 · K5=40 · K6=29 · K8=13 · UNCLEAR=31

按处置：shrink=170 · delete=268 · keep=261 · needs-adjudication=52

**已知覆盖缺口**：本次 fan-out 的区域划分漏掉了 `src/compliance-transport.ts`、`src/package-contracts/{worker-output,judge-output,fixer-packet}.ts` 四个文件（它们在收敛版索引里是 **[读]** 条目）。补漏 critic 已单独扫回，结果并入文末「补漏」节。

---

## D1 闭合对象 / 精确键 / 未知字段拒绝（89）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 116 | delete | `Contradictory semantic fields are rejected, including top-level `commitSha` or `classesRepaired`, fields from the opposite class-result disposition, a` | 这是按"额外字段"拒绝输出的黑名单；ADR 0025/0040 明令每个分支只要求自身必需材料、不得据判别字段禁止额外字段。 |
| 178 | shrink | `Reviewer terminates with this exact receipt:` | "exact receipt" 承诺精确对象形状；ADR 0042/0025 删除精确 receipt 壳，改述为"必需字段 status/report"。 |
| 253 | shrink | ``ak_merger_output` is singleton and terminating. Its exact leaves are:` | singleton/terminating 按 ADR 0041 留；"exact leaves" 的精确形状承诺按 ADR 0023/0025 改述为工具 Schema 直接表达的必需字段。 |
| 277 | delete | ``classes` is forbidden on `converged` and `escalate` receipts.` | 按额外字段拒绝输出；ADR 0025/0040 规定判别字段只选分支、每分支只要求自身必需材料，不得禁止额外字段。 |

### `schemas/collector-legs-v1.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 5 | delete | `"additionalProperties": false,` | 闭合对象拒未知字段（文件内三处）；ADR 0025 规定只检查必需字段。src 侧同形镜像须一并删。 |

### `schemas/navigator-receipt-v1.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 5 | keep | `"additionalProperties": false` | [#58 不改，defer→#28] 全文 24 处 additionalProperties:false（L5,37,50,73,109,161,248,351,393,434,449,476,488,517,529,578,630,672,733,748,795,807,856,868），是发布 schema 面的 D1 主体。 |

### `src/canonical-json.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 50 | delete | `const extraKey = keys.find((key) => key !== "length" && (!/^(0\|[1-9][0-9]*)$/.test(key) \|\| Number(key) >= item.length)); if (extraKey !== undefined` | Exact-key-set rejection over array own keys — unknown members must not participate in validation at this layer. |

### `src/collector-config.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 382 | delete | `function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(value); return keys.length === exp` | Closed-object helper (keys.length === N) used at lines 411, 436 and 509 to reject unknown manifest fields; only the required fields need checking, unknown keys must not reject. |
| 411 | shrink | `const expected = hasRequest ? ["id", "expectedAuthors", "request"] as const : ["id", "expectedAuthors"] as const; if (!exactKeys(raw, expected)) fail(` | Per-leg closed key set (with a branch just to keep the set exact when request is present) must shrink to presence checks for id and expectedAuthors. |
| 436 | shrink | `if (!isPlainObject(request) \|\| !exactKeys(request, ["body"])) { fail(`Collector leg \"${id}\" request must be an object with only body`); }` | request only needs a usable body string; rejecting sibling keys inside request is closed-object law with no consumer. |
| 509 | shrink | `if (!isPlainObject(parsed) \|\| !exactKeys(parsed, ["version", "legs"])) { fail("Collector manifest must be an object with only version and legs"); }` | Keep only 'parsed is an object and legs is usable'; the exact-key closure at the top level rejects harmless extra keys such as comments or future annotations. |

### `src/collector-receipt.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 99 | shrink | `if (!Value.Check(collectorOutputArgsSchema, raw)) { fail("Collector output failed schema validation"); }` | 保留为唯一边界真源，但其背后的 collector-tool-schemas.ts 各层 additionalProperties:false 属闭合对象，应改为只校验必需字段（legId/status/rationale/evidenceRefs 非空），未知字段不参与本层拒绝。 |
| 484 | delete | `if (candidateIds.length !== configuredIds.length) { fail("Collector output must cover exactly the configured leg set"); }` | 精确集合基数法；去重（L487）+ 全配置腿到齐（L490）+ 每条腿必须解析到真实 leg（L508）已完全覆盖真实需求，这条只多不少地拒绝。 |

### `src/collector-tool-schemas.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 11 | delete | `export const collectorObserveArgsSchema = Type.Object({}, { additionalProperties: false });` | additionalProperties:false on an argument-less tool — rejects a call that carries a stray key even though nothing reads it. |
| 11 | shrink | `export const collectorObserveArgsSchema = Type.Object({}, { additionalProperties: false });` | Closed empty object rejects any extra property on a no-argument tool; only required fields (here: none) should be checked. |
| 19 | shrink | `export const collectorRequestArgsSchema = Type.Object({ legId: nonEmptyString, snapshotId: nonEmptyString }, { additionalProperties: false });` | Drop additionalProperties:false; keep legId + snapshotId non-empty — those are the reference targets that select which leg is posted and which snapshot binds the evidence (K3/K5). |
| 19 | shrink | `export const collectorRequestArgsSchema = Type.Object({ legId: nonEmptyString, snapshotId: nonEmptyString }, { additionalProperties: false });` | Keep the two required non-empty fields, drop additionalProperties:false — unknown fields must not participate in this layer's validation. |
| 29 | shrink | `export const collectorWaitArgsSchema = Type.Object({ durationMs: Type.Integer({ minimum: 1, maximum: COLLECTOR_ELIGIBILITY_MS }) }, { additionalProper` | Same closed-object rejection; only the required durationMs matters. |
| 39 | shrink | `const collectorValidLegSchema = Type.Object({ legId, status: Type.Literal("valid"), rationale: nonBlankString, evidenceRefs: Type.Array(nonEmptyString` | Same additionalProperties:false repeated across all three leg variants (lines 39, 53, 63) — delete the closed flag on each; the fields themselves stay. |
| 39 | shrink | `const collectorValidLegSchema = Type.Object({ legId, status: Type.Literal("valid"), rationale: nonBlankString, evidenceRefs: Type.Array(nonEmptyString` | additionalProperties:false on all three leg variants (lines 39, 53, 63) rejects unknown members; the required fields (legId, status, rationale, evidenceRefs) already carry the contract. |
| 77 | shrink | `export const collectorOutputArgsSchema = Type.Object({ legs: Type.Array(collectorOutputLegSchema, { minItems: 1 }) }, { additionalProperties: false })` | Closed-object rejection on the terminal receipt args; `legs` minItems:1 is the real required condition and stays. |

### `src/doctor-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 47 | delete | `const count = Type.Object({ count: Type.Integer({ minimum: 0 }), sources: Type.Array(nonblank) }, { additionalProperties: false });` | 全文件 22 处 additionalProperties:false（L47,49,51,52,57,58,61,62(×3),64,65,67,68,69,71,72,74,75,81,85,86,89,92）把每层都做成闭合键集合；未知字段不应参与本层校验，只留真正必需字段。 |

### `src/judge-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 38 | delete | `Type.Object({ summary: Type.String({ minLength: 1 }) }, { additionalProperties: false })  // also L45, L54, L58` | Four closed objects on the Judge tool schema (fix, classes[], decisionGate, root verdict); ADR 0025 removes rejection on extra fields. |
| 90 | delete | `function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(value); return keys.length === ` | Dead closed-object helper in this file (single grep occurrence = the definition); isRecord at L86 is likewise unreferenced. |

### `src/merger-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 8 | delete | `const materialSchema = Type.Object({ bytesBase64: Type.String(), sha256: Type.String({ pattern: digestPattern }) }, { additionalProperties: false });` | 闭合对象 + hex 拼写；且该 schema 全仓无消费方（只被 role-runtime.ts:113 再导出），ADR 0025/0028 下整体删除。 |
| 9 | delete | `const checkSchema = Type.Object({ name: ..., argv: Type.Array(..., { minItems: 1 }) }, { additionalProperties: false });` | additionalProperties:false 拒绝未知字段，且属于无 consumer 的平行 schema，argv 非空的真实约束已在 L61 的执行前提里。 |
| 31 | delete | `const exact = (v, keys) => Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));` | 精确键集合 helper，6 处调用（L43/52/53/61/69/70）全部因额外字段拒绝数据，ADR 0025 直接判删。 |
| 52 | shrink | `if (!record(value) \|\| !exact(value, ["version", "attemptId", "targetObjectId", ... ]) \|\| value.version !== 1 \|\| blank(value.attemptId) \|\| ...)` | exact(8 键) 与 version 判等删除；attemptId 非空保留（它是回执与本次派工的绑定键）。 |
| 53 | shrink | `if (!record(value.materials) \|\| !exact(value.materials, ["task", "authority", "targetIntent", "sourceIntent"])) fail();` | 四份材料都被 merger-role.ts:62 真实消费，保留「存在」；删掉未知字段拒绝（exact），且此处 fail() 走无参默认文案，删后应给具体缺失字段原因。 |
| 61 | shrink | `if (!record(check) \|\| !exact(check, ["name", "argv"]) \|\| blank(check.name) \|\| !Array.isArray(check.argv) \|\| check.argv.length === 0 \|\| check` | exact 闭合键删；argv 非空且元素非空保留（空 argv 的 check 无法执行，属命令可执行最小条件）。 |
| 69 | shrink | `if (value.status === "completed" && exact(value, ["status", "attemptId", "report", "mergeCommitId"]) && isFullGitObjectId(value.mergeCommitId)) return` | exact 四键删（ADR 0025 明示以其覆盖 ADR 0023 中超出必需内容的 shape 限制）；isFullGitObjectId(mergeCommitId) 按 ADR 0027 保留。 |

### `src/navigator-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 25 | keep | `function record(v:unknown,keys:readonly string[],where:string){if(typeof v!=="object"\|\|v===null\|\|Array.isArray(v)\|\|Object.keys(v).length!==keys.` | [#58 不改 Navigator，ADR 0045 defer→#28] 全文约 20 处调用的精确键集合闭合 helper（keys.length===N），是本区域最大的 D1 面；#28 处置应改为只检查必需字段、未知字段不拒绝。 |
| 37 | keep | `if(kind==="package_role"){keys=["kind","role","phase","evidenceIds","conditions","hazards"];const p=record(v,keys,"primary");…}else if(kind==="caller_` | [#58 不改，defer→#28] 六个 primary 变体各自的精确键闭合，与 published schema 的 additionalProperties:false 完全同形，属 D1＋D5 叠加。 |
| 38 | keep | `const reads=record(r.evidenceRead,Object.keys(r.evidenceRead as object),"evidence read record")` | [#58 不改，defer→#28] 用值自身的键去做闭合校验，恒为真，是纯仪式性 record() 调用，没有任何拒绝能力。 |

### `src/package-contracts/collector-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 137 | shrink | `/** Reject unknown keys; allow only required ∪ present optional fields. */ function assertClosedKeys(value, required, optional, label) { const allowed` | Central closed-object machine — delete the unknown-key loop; the required-key presence loop is already implied by the per-field requireNonEmptyString/requireStringArray calls that follow every call site. |
| 412 | delete | `assertClosedKeys(value, ["evidenceId", "kind", "versionId", "contentDigest", "firstObservedAt", "raw"], [], `evidenceRecords[${index}]`);` | LIVE DEFECT from closed keys: real records built in collector-evidence.ts (e.g. line 205 stableGitHubId, 208 authorLogin, 232 state, 233 commitOid, 234 htmlUrl, 235 authoritativeTime) are passed through unprojected at collector-receipt.ts:726, so a genuine receipt fails with 'unknown key stableGitHubId'; no test covers this path. |
| 458 | shrink | `assertClosedKeys(value, ["host","repository","prNumber","manifestVersion","manifestDigest","activationTime","deadlineTime","finalObservationTime","fin` | Top-level exact-key set on the receipt; only the K3 binding fields need to be required, unknown keys must not participate in this layer's rejection. |

### `src/package-contracts/fixer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 47 | delete | `if (Object.hasOwn(value, "prerequisiteId")) fail(`${path} authority_violation prerequisiteId semantic-field constraint`);` | authority_violation only needs cause+evidence; rejecting a present-but-unneeded field is exactly the extra-field rejection ADR 0025 deletes. |
| 60 | delete | `if (Object.hasOwn(value, "commitSha") \|\| Object.hasOwn(value, "classesRepaired")) fail("removed top-level commit semantic-field constraint");` | A rule whose only job is to police two already-removed field names; unknown top-level fields must not be rejected at this layer (ADR 0025). |
| 63 | delete | `if (Object.hasOwn(value, "classResults") \|\| Object.hasOwn(value, "remainingScope") \|\| Object.hasOwn(value, "blocker") \|\| Object.hasOwn(value, "c` | planned requires only status+report (ADR 0033 pattern); extra content present on a planned receipt is not a reason to reject it. |
| 67 | delete | `if (Object.hasOwn(value, "classResults")) fail("status refused plan/apply semantic-field combination constraint");` | Mutual-exclusion law between the two refused shapes; phase already selects the branch at the real call site, so the presence-based rejection adds nothing required. |
| 84 | delete | `if (Object.hasOwn(item, "remainingScope") \|\| Object.hasOwn(item, "blocker")) fail(`${path} completed/refused semantic-field combination constraint`)` | disposition:completed needs searchScope/exceptions/commitSha; presence of refusal fields is extra content, not a missing requirement. |
| 100 | delete | `if (Object.hasOwn(item, "searchScope") \|\| Object.hasOwn(item, "exceptions") \|\| Object.hasOwn(item, "commitSha")) fail(`${path} refused/completed s` | Mirror of L84 on the refused leaf; same extra-field rejection ADR 0025 removes. |

### `src/package-contracts/navigator-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 9 | keep | `function rec(v:unknown,keys:readonly string[]){if(!v\|\|typeof v!=="object"\|\|Array.isArray(v)\|\|Object.keys(v).length!==keys.length\|\|!keys.every(` | [#58 不改，defer→#28] 与 navigator-contracts.ts:25 的 record() 同形第二份精确键闭合 helper，本文件约 15 处调用（D1＋D5 叠加）。 |

### `src/package-contracts/reviewer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 45 | delete | `function exactKeys(value, required, optional = []): boolean { const keys = Object.keys(value); return required.every(...) && keys.every((key) => requi` | 这是整个文件闭合对象法的机械来源，ADR 0025 判定因额外字段而拒绝的校验一律删除；只保留 required 存在性即可。 |
| 50 | shrink | `return value === "deleted" \|\| value === "not-created" \|\| (isRecord(value) && exactKeys(value, ["retained"]) && typeof value.retained === "string" ` | workspaceDisposition 由 runtime 自己产出（reviewer-agent.ts），闭合键集合无收益；全仓无 consumer 读取 retained 值，连保留形态都缺举证。 |
| 56 | shrink | `if (output.status === "completed" && exactKeys(output, ["status"])) return { status: "completed" };` | completed 意图带任何额外键就被拒绝；保留 status 判别值（K1/K2），删除精确键集合。 |
| 57 | shrink | `if (output.status === "refused" && exactKeys(output, ["status", "diagnostic"]) && typeof output.diagnostic === "string" && output.diagnostic.trim().le` | refused 必需非空 diagnostic 属必需字段保留；exactKeys 的额外字段拒绝删除（trim 仅用于空白判定、未写回归一化值，不算 D2）。 |
| 65 | delete | `!exactKeys(output, ["version", "status", "reports", "outcomes", "identities"], ["diagnostic", "acceptedBatch"])` | 回执顶层精确键集合，ADR 0025 判删；唯一存活 consumer（doctor-evidence.ts:25 → acceptedFacts）只读 status。 |
| 68 | delete | `if (!exactKeys(output.reports, [], ["standards", "spec"]) \|\| !exactKeys(output.outcomes, [], ["standards", "spec"]) \|\| !exactKeys(output.identitie` | 三个投影对象的闭合键集合；未知轴名对 consumer 无意义但也不需要在本层拒绝（ADR 0025）。 |
| 82 | delete | `if (!exactKeys(acceptedBatch, ["identity", "legs"]) \|\| typeof acceptedBatch.identity !== "string" \|\| ... (acceptedBatch.legs.length !== 1 && accep` | 精确键集合加 legs 基数运营法（1 或 2 条腿）；腿数由 runtime 按 spec.state 分支决定，回执层再判基数是 K7 类运营批次法。 |
| 101 | shrink | `!exactKeys(outcome, ["status", "prompt", "workspaceDisposition"], ["failure", "runtimeConstructionEvidence"]) \|\| ... !exactKeys(outcome.prompt, ["te` | outcome 的精确键集合（D1）加 prompt 身份壳重算（D3）；只保留 status 是 successful\|failed 这一判别值。 |
| 118 | shrink | `} else if (!failures.has(outcome.failure as string) \|\| report !== undefined) throw new Error("Failed Reviewer outcome requires a classification and ` | 保留 failed ⇒ 有失败原因；删除闭合枚举成员校验与「failed 不得带 report」的额外内容拒绝。 |
| 128 | delete | `if (!hasBatch && (Object.keys(output.outcomes).length !== 0 \|\| Object.keys(output.reports).length !== 0)) throw new Error("Pre-acceptance Reviewer r` | 以「不得有额外内容」为由拒绝，ADR 0025 判删。 |

### `src/reviewer-dispatch.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 27 | delete | `const exact=(v,keys)=>typeof v==="object"&&v!==null&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));` | keys.length===N 的闭合对象 helper，ADR 0025 判删；只保留必需键的存在性。 |
| 29 | delete | `if(!exact(value,["version","taskSha256","tools","prerequisiteOperations"]))throw new Error("Invalid Reviewer capabilities keys");...if(v.version!==1\|` | 能力文件的精确键集合拒绝额外字段（D1），version:1 无第二读取分支（ADR 0044）；能力文件是外部输入，按 K6 只提取 consumer 必需字段、忽略其余。 |

### `src/reviewer-execution-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 103 | delete | `function hasExactEventShape(event: object, keys: readonly string[]): boolean { const actual = Object.keys(event); return actual.length === keys.length` | 典型闭合对象 helper（四个调用点 line 129/136/143/151），拒绝未知字段；本层只该检查真正必需的字段。 |

### `src/reviewer-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 44 | shrink | `Type.Object({ status: Type.Literal("completed") }, { additionalProperties: false }), Type.Object({ status: Type.Literal("refused"), diagnostic: Type.S` | additionalProperties:false 是闭合对象（ADR 0025），且这份 schema 与 validateReviewerIntent 是同一契约的两份 shape validator（D5）；保留 status 判别值与 refused 的非空 diagnostic。 |

### `src/worker-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 57 | delete | `const coderOutputSchema = Type.Object(workerOutputFields, { additionalProperties: false });` | additionalProperties:false closes the Coder submission object; unknown fields must not be rejected at this layer (ADR 0025). |
| 122 | delete | `function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean { const keys = Object.keys(value); return keys.length === ` | Closed-object helper that is dead code here (grep shows exactly one occurrence in this file, the definition); isRecord at L112 is equally unreferenced. |

### `test/class-contracts.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 26 | delete | `{ judgeStatus: "converged", classes: [judgeClass] },` | converged 携带 classes 被拒绝＝闭合键集，随 D1 删除。 |
| 39 | delete | `assert.throws(() => validateAcceptedWorkerDetails(fixer, "Coder"), /Coder output/);` | Fixer 形状被 Coder 拒绝，本质是未知字段（classResults）拒绝；随闭合对象删除。 |
| 40 | delete | `assert.throws(() => validateAcceptedWorkerDetails({ status: "completed", report: "old", classesRepaired: [] }, "Fixer"), /Fixer output/);` | 拒绝历史遗留字段 classesRepaired 属未知字段拒绝，随 D1 删除。 |

### `test/collector-config.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 241 | delete | `["unknown-top",{...,extra:true},/unknown\|additional\|only version and legs/i],["unknown-leg",...],["unknown-request",{request:{body:"ok",extra:1}}]` | 三条都是未知字段拒绝，ADR 0025「只验证必须有的」直接判删。 |

### `test/collector-receipt.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1462 | delete | `["unknown leg field",{legs:[{...,extra:true}]}],["unknown top-level",{legs:[...],extra:1}],["scope on valid",{status:"valid",unavailableScope:"global"` | 四条都是「额外内容即拒绝」：ADR 0025 判删，ADR 0040 明确判别字段不得据此禁止额外字段。同矩阵中 unavailable 缺 scope、blank rationale、empty refs 属必需字段应保留。 |
| 1543 | delete | `assert.equal(collectorToolArgumentsValid(COLLECTOR_OBSERVE_TOOL,{x:1}),false); // observe rejects non-empty object (additionalProperties: false)` | observe 无必需参数，拒绝多余键不保护任何行为不变式。此外 collectorToolArgumentsValid 的 grep 消费方只有 collector-ledger.ts 与本测试，属需一并复核的自证面。 |

### `test/collector-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1376 | shrink | `{name:"unknown leg field",args:{legs:[{legId:"codex",status:"missing",rationale:"x",evidenceRefs:["s"],extra:true}]}}` | real-Pi 拒绝行矩阵里的 unknown-field / unknown-top-level 行随 D1 删；unavailable 缺 scope、blank rationale、empty refs 等必需字段行保留。 |

### `test/doctor-auditor.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 21 | shrink | `assert.deepEqual(Object.keys(payload).sort(), ["frozenEvidenceIndex", "proposedTestimony", "readRecord", "soul"]);` | 对审计载荷做精确键集断言。真正要守的是 L24-26：不携带 content、不泄漏 session 字节；把键集等值换成"必需键存在 + content 不存在"。 |

### `test/doctor-case.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 203 | delete | `assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, disposition: "delete" }] }, patient, store), /closed contract/);` | 观察型 finding 多带 disposition 被拒＝分支闭合字段集；ADR 0040 不得据判别字段禁止额外字段。 |

### `test/fixer-auditor.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 26 | delete | `assert.equal((decisionTool?.parameters as any).additionalProperties, false);` | 断言合规决策工具 schema 闭合；ADR 0033/0025 后 pass/revise 只要求各自必需字段，额外内容不管。 |

### `test/fixer-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 63 | delete | `["apply", { status: "completed", report: "old", commitSha: shaA }],` | 顶层 commitSha 是已移除的历史字段，拒绝它属于未知字段拒绝（ADR 0025）。 |
| 64 | delete | `["apply", { status: "completed", report: "old", classesRepaired: [] }],` | 同上，legacy 字段的未知字段拒绝。 |
| 65 | delete | `["plan", { status: "planned", report: "x", classResults: [completed()] }],` | ADR 0040 明言判别字段不得据此禁止额外字段；plan 分支多带 classResults 应被忽略而非拒绝。 |
| 84 | delete | `test("Fixer rejects branch-incompatible semantic fields while ignoring presentation decoration", ... 5 rows: classResults on plan / top-level commitSh` | 五行全部是"某分支出现了别的分支字段就拒绝"，即分支级闭合字段集；ADR 0040 明令不得据判别字段禁止额外字段。仅末行（L93 装饰被忽略并剥离）保留。 |

### `test/fixer-prerequisite-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 82 | delete | `[JSON.stringify([{ id: "x", requirement: "x", extra: true }]), /entry.*fields/],` | prerequisite entry 精确两字段（keys.length !== 2）＝闭合对象，随 D1 删除。 |

### `test/judge-output-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 6 | delete | `test("converged rejection names exactly the submitted extra keys", () => { ... assert.equal(error.message, `${prefix}${testCase.extraKeys.join(", ")}`` | 整条测试只断言 converged 的闭合键集拒绝（extra key）以及拒绝文案的逐字拼写，规则删除后无被测行为；同时是对自由文本错误消息的机械依赖。 |
| 74 | shrink | `test("converged exact keys remain accepted and returned unchanged", ... assert.equal(accepted.evidence, evidence)` | "exact keys" 前提随 D1 删除；仅 evidence 原样透传（引用相等）这一断言仍有价值，应并入 L90 的 evidence 不透明测试。 |

### `test/judge-posture-recordings.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 699 | delete | `for (const key of Object.keys(sole.details)) assert.ok(["judgeStatus", "fix", "note", "decisionGate"].includes(key), `unexpected verdict key ${key}`);` | 录制回执的闭合键集断言（注释就写着 "packaging: only existing verdict keys"），随 D1 删除；注意它连 evidence 都没列，与现行 judge-output 已不一致。 |

### `test/judge-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 464 | delete | `assert.equal(tool.parameters.additionalProperties, false); assert.deepEqual(Object.keys(tool.parameters.properties), fixture.role === "judge" ? ["judg` | 断言工具 schema 闭合并逐字锁定属性名单；ADR 0025 删除闭合对象，ADR 0024 删除 Coder 的 commitSha 属性。 |
| 1358 | delete | `{ status: "completed", report: "report", commitSha: " \n" }, { status: "completed", report: "report", unknown: true },` | unknown 字段拒绝随 D1 删除；commitSha 空白拒绝随 ADR 0024 删除（该数组其余项——null/数组/未知 status/空白 report/缺 report——保留）。 |
| 1459 | delete | `["converged with fix", ...], ["converged with gate", ...], ["converged with unknown field", { judgeStatus: "converged", memo: "extra" }], ["continue w` | 六个分支闭合键集用例（某 status 出现别的 status 字段 / 未知字段就拒）随 D1+ADR 0040 删除；同表中 continue 缺 fix、escalate 缺 gate、空白 summary/question/options 属 K2 必需字段，保留。 |

### `test/merger-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 24 | delete | `assert.throws(() => validateMergerInput({ ...valid(), extra: true }), /Merger input/);` | 输入闭合键集（merger-contracts.ts:52 的 exact(...)），随 D1 删除。 |
| 44 | delete | `assert.throws(() => validateMergerOutput({ status: "completed", ..., nextRole: "reviewer" }, ...), /Merger output/); ... published: true ...` | 两行都是输出的未知字段拒绝（exact()），随 D1 删除。 |

### `test/merger-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 134 | needs-adjudication | `{ status: "escalate", attemptId: "attempt", diagnosis: "decision", report: "blocked", unknown: true },` | 未知字段候选被期望拒绝（L144 的分支条件 `Object.hasOwn(candidate,"unknown")` 与缺 diagnosis 合并处理）。规则删除后该候选必须被接受，测试控制流整体反转，且它同时是这条 in-process Pi 传输测试的唯一 fatal 路径之一。 |

### `test/navigator-contracts.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 11 | keep | `assert.throws(()=>validateCurrentPositionSnapshotV1({...value, children:[]})); assert.throws(()=>validateCurrentPositionSnapshotV1({...value, surprise` | 典型闭合对象/精确子集拒绝，本属删除类；但 ADR 0020/0045 把 Navigator 同类实例明确 defer 给 #28，#58 不得改 Navigator。记录为有理由的范围例外。 |
| 14 | keep | `for(const bad of [{...receipt,invocationId:"bad"},{...receipt,subject:{...receipt.subject,extra:true}},...])assert.throws(()=>validateRecordedNavigato` | extra 字段拒绝 + UUID 格式拒绝同属删除类，Navigator 范围例外（ADR 0026/0045）。注意 validateRecordedNavigatorReceiptV1 有真实 consumer（package-contracts/terminating-tools.ts），不是自证循环。 |

### `test/package-entrypoint.integration.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 214 | delete | `fauxToolCall(JUDGE_OUTPUT_TOOL_NAME,{judgeStatus:"converged",unexpected:true},{id:"schema-invalid"}) ... assert.match(textOf(...),/unexpected\|additio` | ADR 0025 明确覆盖 ADR 0023 中「超出必需内容的 shape 限制」：judge 输出不再因额外字段被拒；该负向案随之删除（judgeStatus 三叶判别的正向覆盖保留）。 |

### `test/schema-contract-parity.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 19 | delete | `test("actual schema consumer and runtime reject phase, variant, and extra-property violations",...) [{...config,extra:true},{...receipt("ordinary"),ex` | 专门断言「额外字段被拒」，随 ADR 0025 的闭合对象法条一起删；其中 role/phase 判别项覆盖由 ADR 0040 保留面另行承担。 |

### `test/soul-auditor.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 128 | delete | `["unknown key", { status: "pass", violations: [], explanation: "extra" }],` | compliance-transport.ts:113-120 的 keys.length !== 2 精确键集，随 D1 删除。 |

## D2 表现形式法条（94）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 80 | shrink | `IDs are case-sensitive, attachment-unique, and match `^[A-Za-z0-9][A-Za-z0-9._-]*$`` | ID 拼写正则是表现形式法条（ADR 0036 默认删）；attachment-unique 因 blocker 真实按 ID 引用而按 K5/ADR 0039 保留。 |
| 114 | shrink | `prerequisite blockers require `cause: "prerequisite_unmet"`, a pattern-valid `prerequisiteId`, and nonblank `evidence`` | "pattern-valid" 是 ID 拼写法条须删；cause 判别值与非空 evidence 按 K1/K2 留，declared-ID 引用存在性按 K5 留。 |
| 192 | delete | `Owner/repo uses a conservative ASCII grammar (owner 1–39, repo 1–100).` | 包内自造 GitHub 标识符语法与长度上限；ADR 0043/0035 只允许 consumer 必需字段的最小解析，真实合法性由 GitHub 决定。 |
| 249 | shrink | `the byte-sorted complete conflict set` | "完整冲突集"按 ADR 0037 保留，但"byte-sorted"把排序变成输入拒绝条件属 D2；内部为稳定输出排序可以，不得据此拒收。 |
| 277 | delete | `A `continue` receipt requires non-empty `classes` with unique comma-free nonblank names` | "comma-free" 是名称拼写法条（ADR 0036 默认删）。注意耦合：line 291 的 `--ak-review-scope-keys <comma-separated keys>` 是逗号禁令的真实来源，删除时须同时给该 CLI 传输换掉逗号分隔，否则含逗号类名会静默拆成两个 scope key。 |

### `schemas/collector-legs-v1.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 19 | delete | `"pattern": "^[a-z][a-z0-9._-]{0,63}$"` | legId 的小写拼写与 64 字符长度是表现形式法条；legId 的真实需求是非空且跨 leg 唯一（K5/ADR 0039），与拼写无关。 |

### `schemas/navigator-receipt-v1.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 33 | keep | `"pattern": "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"` | [#58 不改，ADR 0026 明示 Navigator 归 #28] UUIDv7 小写拼写正则 3 处（L33 runId、L103 invocationId、L122 latestAttempt.invocationId），与 src/uuidv7.ts 的 isUuidV7 重复。 |
| 82 | keep | `"number":{"type":"integer","minimum":1,"maximum":9007199254740991} … (L99) "positionCursor":{"type":"integer","minimum":0,"maximum":9007199254740991}` | [#58 不改，defer→#28] 数字词法/范围面，是 runtime 里 Number.isSafeInteger 检查的第二份拷贝（D2+D5）。 |
| 94 | keep | `"snapshotDigest":{"type":"string","pattern":"^[0-9a-f]{64}$"} … (L173) "sha256":{"type":"string","pattern":"^[0-9a-f]{64}$"}` | [#58 不改，ADR 0028 归 #28] 十六进制拼写面 2 处；snapshotDigest 的真实作用是与 live snapshot.digest 相等（K3，在 runtime），拼写正则不产生该保证。 |
| 143 | keep | `"beforeTarget":{"type":"string","pattern":"^[0-9a-f]{40}([0-9a-f]{24})?$"} … (L147) "afterTarget": 同` | [#58 不改，ADR 0027 归 #28] Git OID 拼写正则；这两个字段只是历史尝试的转述，Navigator 不据以执行任何 Git 操作。 |

### `src/canonical-json.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `export const CANONICAL_JSON_VALIDATION_ERROR_CODE = "canonical-json-invalid" as const; export class CanonicalJsonValidationError extends Error { reado` | ADR 0030 removes canonical JSON as an I/O contract; the exported error code/class is a rejection contract whose only consumer is test/canonical-json.test.ts (production callers never branch on `code`). |
| 19 | delete | `if (keys.some((key) => typeof key === "symbol")) { throw new CanonicalJsonValidationError(childPath(path, "<symbol>"), "symbol-keyed member is not a J` | Serialization-domain rejection layered on already shape-validated values; ADR 0030 forbids serialization from being an extra input/output rejection condition. |
| 35 | delete | `if (!Number.isFinite(item)) throw new CanonicalJsonValidationError(path, "number must be finite");` | Numeric-lexical rejection (D2 数字词法) with no consumer branch — doctor only needs deep equality of two already-validated structures. |
| 41 | delete | `case "undefined": case "function": case "symbol": case "bigint": throw new CanonicalJsonValidationError(path, `${typeof item} is not a JSON value`);` | Closed JSON value-domain law; the surviving equality consumer (doctor) can compare content directly instead of rejecting on value type during serialization. |
| 43 | delete | `if (ancestors.has(item)) throw new CanonicalJsonValidationError(path, "cycle is not a JSON value");` | Cycle detection exists only to make the canonical serializer total; deleting the serializer as a contract deletes the need. |
| 47 | delete | `if (Object.getPrototypeOf(item) !== Array.prototype) throw new CanonicalJsonValidationError(path, "array must not be a custom object");` | Prototype-shape rejection is a representation law, not a required field check; no consumer distinguishes a subclassed array. |
| 53 | delete | `if (!Object.hasOwn(item, index)) throw new CanonicalJsonValidationError(childPath(path, index), "sparse array slot is not a JSON value");` | Sparse-slot rejection is a serialization-domain law with no downstream reader. |
| 59 | delete | `if (prototype !== Object.prototype && prototype !== null) throw new CanonicalJsonValidationError(path, "object must be a plain record");` | Plain-record prototype law rejects data on representation grounds; ADR 0030 removes canonical JSON's rejection authority. |
| 60 | delete | `return `{${ownStringKeys(item, path).sort().map((key) => `${JSON.stringify(key)}:${serialize(...)}`).join(",")}}`;` | Key sorting is the canonicalization itself; ADR 0030 lets a digest consumer keep its own serializer but the module must stop being a shared I/O contract — the only #58-scope consumer (src/doctor-contracts.ts:109,131) should compare content directly. |

### `src/collector-config.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 82 | delete | `function isAsciiControlOrNonAscii(input: string): boolean { ... if (code <= 0x1f \|\| code === 0x7f \|\| code > 0x7f) return true; } ... fail("Collect` | Character-class presentation law on the repo flag; the structural checks at lines 104-129 already stop path/URL escape, and any surviving oddity 404s loudly at GitHub. |
| 95 | delete | `const display = raw.trim(); if (display !== raw) { fail("Collector repository must not include surrounding whitespace"); }` | Rejecting a value purely because it was not already trimmed is trim-normalization law, not a target-binding requirement. |
| 130 | delete | `if (!COLLECTOR_OWNER_PATTERN.test(ownerDisplay)) fail("...owner must match the v1 conservative grammar (1-39 alphanumeric/hyphen)"); if (!COLLECTOR_RE` | Re-implements GitHub's owner/repo name grammar including its length limits (patterns declared at lines 8-11); a wrong name is answered by a real 404, and the grammar adds no binding the API call does not already give. |
| 150 | delete | `const text = String(raw).trim(); if (text !== String(raw).trim() \|\| text !== String(raw)) { // allow only exact digit strings when provided as strin` | Dead no-op branch left over from a trim-identity check; it evaluates a comparison and does nothing. |
| 176 | delete | `export function assertCollectorManifestJsonIdentity(text: string): void { ... fail(`Collector manifest contains duplicate JSON key \"${key}\" at ${pat` | A hand-written second JSON lexer that rejects duplicate keys and the number spellings 1.0/1e0 is pure JSON-spelling law with no behavior invariant behind it; ADR 0021 already accepted its deletion (only call site is line 499). |
| 396 | delete | `if (trimmed !== raw.trim()) { // already trimmed }` | Dead tautological no-op inside canonicalizeAuthor. |
| 415 | shrink | `if (typeof id !== "string" \|\| !COLLECTOR_LEG_ID_PATTERN.test(id)) { fail(`Collector leg id at legs[${index}] must match ^[a-z][a-z0-9._-]{0,63}$`); ` | legId is a real map key (keep non-empty string plus the uniqueness check at 525), but the lowercase-charset-plus-64-char grammar is pure spelling law with no consumer that depends on the shape. |

### `src/collector-github.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 209 | shrink | `const state = requireString(raw["state"], "state").toUpperCase(); ... state: state === "OPEN" \|\| state === "open" ? "OPEN" : state,` | The single toUpperCase feeds a real consumer branch (snapshot.prState !== "OPEN"), but the `\|\| state === "open"` arm is unreachable after toUpperCase — dead case-spelling belt. |

### `src/collector-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 517 | needs-adjudication | `const ambientCommands = commands.filter((command) => { const name = command.name.toLowerCase(); return (name.includes("skill") \|\| name.includes("pro` | The barrier here is anchored to free-text command names (a command called 'skillet' is rejected, a real skill called 'foo' passes), which the anchoring constitution treats as a defect — but it is part of the ADR 0019 barrier, so replacing it with a typed command property versus deleting it needs owner adjudication. |
| 554 | shrink | `if (dependencies.packageExtensionPath !== undefined && tool.sourceInfo?.path !== undefined && tool.sourceInfo.path !== dependencies.packageExtensionPa` | The override check depends on the substring 'role-runtime' appearing in a path string, a presentation-level escape hatch inside an otherwise typed identity comparison. |

### `src/doctor-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 12 | shrink | `const soul = (await dependencies.loadSoul()).trim(); if (!soul) throw new Error("Doctor soul is empty");` | 「soul 非空」的 fail-closed barrier 保留（ADR 0019）；但 .trim() 改写了随后进 prompt 的 soul 字节，是 trim 归一类呈现法条，判空不需要重写内容。 |

### `src/exact-utf8.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 9 | delete | `const encoded = new TextEncoder().encode(text); if (encoded.byteLength !== bytes.byteLength \|\| !encoded.every((byte, index) => byte === bytes[index]` | ADR 0029 deletes the exact round-trip: after a successful strict decode nothing may re-encode and byte-compare, and no caller distinguishes this failure from the decode failure. |

### `src/git-object-id.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 9 | delete | `export type GitObjectFormat = "sha1" \| "sha256"; export function gitObjectIdWidth(format: GitObjectFormat): 40 \| 64 { return format === "sha1" ? 40 ` | Format-width law with zero consumers anywhere in src/test/bin/scripts (Merger compares `.length` equality directly), so it is dead spelling machinery. |

### `src/merger-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 6 | delete | `const digestPattern = "^[0-9a-f]{64}$";` | 小写 64 位十六进制外观正则，ADR 0028 明令删除呈现校验，字节绑定由 L47 现场重算承担。 |
| 38 | delete | `const sorted = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))); ... paths.some((path, i) => path !== sorted[i])` | 要求调用方按字节序排好才受理，是典型的呈现形式法条；下游只需集合相等（merger-role.ts:38 应改集合比较）。 |
| 43 | delete | `if (!record(value) \|\| !exact(value, ["bytesBase64", "sha256"]) \|\| ... \|\| !/^[0-9a-f]{64}$/.test(value.sha256)) fail(...)` | exact 闭合键集合 + 本地第三份 hex 正则（与 L6 digestPattern、git-object-id 同形），ADR 0025/0028 下两者都删，只留「必须能拿到 bytes 和（若保留）digest」。 |
| 45 | delete | `if (bytes.toString("base64") !== value.bytesBase64) fail(`Merger ${label} bytes are not canonical base64`);` | canonical base64 拼写往返，纯呈现形式法条；能解码即可，ADR 0036 默认删除。 |
| 46 | shrink | `exactUtf8(bytes, `Merger ${label} material`);` | ADR 0029：只留一次严格 UTF-8 解码，删掉 exact-utf8.ts:8-11 的重新编码逐字节比较（且此处解码结果被丢弃，merger-role.ts:25 又解码一次，实为重复）。 |
| 52 | delete | `value.targetObjectId.length !== value.sourceObjectId.length` | sha1/sha256 位宽一致性是格式自洽法条，不选择任何执行分支；宽度不一致自然会在实时 Git 比对处失败。 |

### `src/merger-git-state.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 19 | shrink | `function line(bytes, label) { const value = exactUtf8(bytes, label).trim(); if (!value) throw new Error(`${label} is empty`); return value; }` | ADR 0029：exactUtf8 收成一次严格解码；trim + 空值拒绝属外部输出的最小可用性解析（K6），保留。 |
| 25 | delete | `if (raw.length > 0 && !raw.endsWith("\0")) throw new Error(`${label} is not NUL terminated`);` | 对 git -z 输出帧格式的拼写法条，下一行 split("\0").filter(Boolean) 本就兼容有无尾 NUL；真正的截断风险由 execFile maxBuffer 报错兜住。 |
| 26 | shrink | `return raw.split("\0").filter(Boolean).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));` | 排序本身不拒绝数据，但它只为支撑 merger-role.ts:38 的有序 same() 比较而存在；比较改集合后此排序（含 L37 同款）可一并去掉。 |

### `src/merger-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 25 | shrink | `function materialText(input, key) { return exactUtf8(Buffer.from(input.materials[key].bytesBase64, "base64"), `Merger ${key}`); }` | 同一批字节的第二次解码（merger-contracts.ts:46 已解码并丢弃），且用的是 round-trip 版；ADR 0029 下收成一次严格解码。 |
| 38 | shrink | `!same(state.unmergedPaths, input.expectedConflictPaths)` | 完整冲突集绑定（K3）保留，但 same() 是逐位有序比较，依赖两侧都按字节序排好；随 merger-contracts.ts:38 排序法删除应改为集合相等。 |
| 68 | shrink | `const active = pi.getActiveTools?.() ?? [...MERGER_ACTIVE_TOOLS]; if (!same(active, MERGER_ACTIVE_TOOLS)) throw new Error("Merger active tool narrowin` | 回读自家 setter 后做有序逐位比较；同仓其它角色（collector-role.ts:567、doctor-role.ts:16）用集合/includes，此处对顺序的机械依赖是呈现级要求，至少收成集合相等。 |

### `src/navigator-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 24 | keep | `const SHA256=/^[0-9a-f]{64}$/;` | [#58 不改，ADR 0028 明示 Navigator 归 #28] 小写十六进制拼写正则，用于 latestAttempt.reference.sha256、evidence.sha256、snapshot.digest；真实字节绑定另有现场重算（navigator-evidence.ts:8），拼写检查本身应删。 |
| 24 | keep | `const OID=/^(?:[0-9a-f]{40}\|[0-9a-f]{64})$/;` | [#58 不改，ADR 0027 明示 Navigator 归 #28] Git OID 十六进制拼写正则，用于 beforeTarget/afterTarget 与 workspace head/target；Navigator 从不用这些值做真实 Git 操作，无对象身份必需性。 |
| 26 | keep | `function iso(v:unknown,w:string){const s=text(v,w);if(new Date(s).toISOString()!==s)fail(w);return s}` | [#58 不改，defer→#28] 强制时间戳必须是 toISOString 的规范拼写（拒绝 '…00Z' 无毫秒、拒绝 +00:00 偏移），是纯表现形式归一；且 capturedAt 被 canonicalSnapshotDigestV1 显式替换成 '<capture-time>'，全仓无任何 consumer 读它。 |
| 27 | keep | `function issue(v,w){const r=record(v,["number","id"],w);if(!Number.isSafeInteger(r.number)\|\|(r.number as number)<=0)fail(w);…}` | [#58 不改，defer→#28] 数字词法/范围（安全整数且 >0）属表现形式法条；issue number 只是转述给模型的标识，非零/正性不是任何命令的可执行前提。 |
| 33 | keep | `export function canonicalSnapshotDigestV1(value){const stable={...value,capturedAt:"<capture-time>"};return sha256Hex(canonicalJson(stable))} …(L34) i` | [#58 不改，ADR 0030 明示 Navigator 归 #28] 把 canonical JSON 序列化抬成输入拒绝条件：snapshot 自摘要必须与本地 canonicalJson 重算一致，否则拒绝加载；这是自证自摘要，不是对外部对象的绑定（真绑定在 L39 receipt↔snapshot）。 |
| 34 | keep | `if(children.some((c,i)=>i>0&&c.number<=children[i-1]!.number)\|\|new Set(children.map(c=>c.id)).size!==children.length)fail("sorted exact child univer` | [#58 不改，defer→#28] 强制 children 按 number 升序否则拒绝加载 = 排序当输入拒绝权；内部要稳定输出可自己排序，不构成拒绝理由。 |

### `src/package-contracts/fixer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 51 | shrink | `if (typeof value.prerequisiteId !== "string" \|\| !new RegExp(FIXER_PREREQUISITE_ID_PATTERN).test(value.prerequisiteId)) fail(`${path}.prerequisiteId ` | The spelling regex ^[A-Za-z0-9][A-Za-z0-9._-]*$ decides nothing; the real consumer is the declared-id membership check at L122, so keep nonblank string + membership and drop the pattern. |

### `src/package-contracts/navigator-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 5 | keep | `const SHA256=/^[0-9a-f]{64}$/; const OID=/^(?:[0-9a-f]{40}\|[0-9a-f]{64})$/; const ROLES=["judge","fixer","coder","reviewer","collector","doctor"];` | [#58 不改，ADR 0027/0028 归 #28] 十六进制拼写正则的第三份拷贝（contracts、published schema、本文件各一份）。 |

### `src/package-contracts/reviewer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 86 | delete | `if (expectedAxes[0] !== "standards" \|\| (expectedAxes.length === 2 && expectedAxes[1] !== "spec") \|\| expectedLegs.some(...))` | canonical 顺序法：轴顺序不对即拒绝。内部为稳定输出排序不构成输入拒绝权（ADR 0025/0031）。 |
| 89 | delete | `const objectId = (value) => typeof value === "string" && new RegExp(target.objectFormat === "sha1" ? "^[0-9a-f]{40}$" : "^[0-9a-f]{64}$").test(value);` | Git OID 的十六进制拼写正则；ADR 0027 只在 Merger 的真实 merge 对象身份上保留 OID 校验，ADR 0028 判删独立的小写十六进制外观校验。objectFormat 随之失去唯一分支用途。 |
| 122 | delete | `if (hasBatch && (outcomeAxes.length !== expectedAxes.length \|\| outcomeAxes.some((axis, index) => axis !== expectedAxes[index]))) throw new Error("Re` | 顺序敏感的覆盖法；同一规则已在 reviewer-execution-ledger.ts:219-225 与 projectReviewerDispatchOutcome L78-80 由拥有事实的 runtime 执行，此处是第三份副本且额外强加了顺序。 |

### `src/reviewer-admission.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 50 | shrink | `for(const hs of [hints.standards,hints.spec])if(hs!==undefined&&(!Array.isArray(hs)\|\|!hs.every(x=>typeof x==="string")\|\|!unique(hs)))fail("materia` | 提示列表不是键也不是引用目标，唯一性按 ADR 0039 删；只保留能被拼进 prompt 的最小类型条件。 |

### `src/reviewer-bundle-materializer.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 24 | shrink | `if (!confined(root, destination) \|\| destinations.has(destination.normalize("NFC"))) throw new Error("Mechanical bundle path collision or escape");` | confined() 与碰撞检测保留（K4+K5：真实覆盖风险在此发生）；normalize("NFC") 是表现形式归一，删除后按解析后的真实路径比较即可。 |

### `src/reviewer-construction.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 71 | shrink | `const paths = entries.map((item) => item.relativeClonePath.normalize("NFC")); if (new Set(paths).size !== paths.length) throw new Error("Mechanical bu` | NFC 归一是表现形式法条（D2）；碰撞检测本身属 K5（真实写盘目标会互相覆盖），但已在真正的 I/O 接缝 reviewer-bundle-materializer.ts:24 做过一遍，这层是同构副本，应只留 I/O 侧那份。 |

### `src/reviewer-dispatch.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 29 | shrink | `if(!/^[0-9a-f]{64}$/.test(v.taskSha256)\|\|v.taskSha256!==sha256Hex(task))throw new Error("Reviewer capabilities task digest mismatch");` | 保留右半的真实字节绑定（能力授权必须绑定这次的 task 字节，K3）；删除左半的小写 64 位十六进制外观正则（ADR 0028）。 |
| 29 | shrink | `try{text=exactUtf8(raw,"Reviewer capabilities");value=JSON.parse(text)}catch{throw new Error("Invalid Reviewer capabilities UTF-8 JSON")}` | 外部文件需要一次严格 UTF-8 解码（保留），但 exact-utf8.ts 的重新编码逐字节比对按 ADR 0029 删除。 |
| 35 | shrink | `try{taskText=exactUtf8(task,"Reviewer task")}catch{throw new ReviewerPreflightError("prompt-identity-invalid", "Reviewer task must be valid UTF-8 befo` | 同上：保留一次严格解码，删除 round-trip 身份（ADR 0029）。注意 task 在 reviewer-role.ts:120 已解码过一次，这里是第二次解码同一批字节。 |

### `src/reviewer-execution-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 159 | shrink | `const axes = event.legs.map(l => l.axis); if (axes[0] !== "standards" \|\| (axes.length !== 1 && (axes.length !== 2 \|\| axes[1] !== "spec"))) throw n` | 「必须有 standards、spec 可选」是真实基数，保留；但要求它们按固定下标顺序出现是排序法条，且同一条法在 reviewer-agent.ts:27 与 package-contracts/reviewer-output.ts 各写一遍（D5 平行 validator）。 |

### `src/reviewer-pinned-git.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 52 | delete | `!/^[0-9a-f]{64}$/.test(readRange!.diffSha256)` | ADR 0028：删除独立的「小写 64 位十六进制」外观校验；此处摘要由同进程 sha256Hex 现算（line 152），拼写不可能不合法。 |
| 55 | shrink | `try{text=exactUtf8(bytes!,"Reviewer material");}catch{evidenceViolation("material-invalid");}` | ADR 0029：材料确实要当文本读，保留一次严格 UTF-8 解码即可；exactUtf8 内部的「再编码逐字节比对」round-trip 删除（helper 本体在 src/exact-utf8.ts，属跨区共用真源）。 |
| 102 | shrink | `if (!/^[A-Za-z0-9._/~^+-]+$/.test(base) \|\| base.startsWith("-") \|\| base.includes("..") \|\| base.includes("@{")) invalid("base-invalid", ...)` | 只有 startsWith("-") 是真实 exec 接缝必需（防 git 参数注入）；字符白名单/`..`/`@{` 是词法法条——base 随后必须 rev-parse --verify 成功且是 targetHead 的祖先（line 124-132），钉子已由那两道咬住。 |
| 118 | shrink | `else if (new RegExp(`^[0-9a-f]{4,${oidWidth - 1}}$`).test(base) && !(objectFormat === "sha256" && base.length === 40))` | 「sha256 仓库下长度恰为 40 的十六进制不算缩写」是纯词法特例，只改变报错措辞：真去解析也只会因 matches.length!==1 被拒；缩写分支本身（选择解析策略）保留。 |
| 157 | delete | `if (path.includes("\\")) invalid(..."must not contain backslashes"); if (/[ -]/u.test(path)) invalid(..."must not contain control characters");` | 反斜杠与控制字符在 git 树里是合法文件名字符，这两条不构成越界风险，只是路径字符串的拼写制度；真正的圈界由上一条保住。 |

### `src/reviewer-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 110 | delete | `if (parsed.some((key) => key.trim().length === 0) \|\| new Set(parsed).size !== parsed.length) throw new Error("Reviewer scope keys contain a blank or` | scope keys 只被拼进 prompt 作范围提示（reviewer-construction.ts:84 reviewerScopePrompt），不是映射键；重复与空白元素不造成歧义，ADR 0039 不予保留。 |
| 120 | shrink | `task = exactUtf8(taskBytes, "Reviewer task");` | exact-utf8.ts:8-11 在严格解码后又重新编码逐字节比对；ADR 0029 判删 round-trip，只留一次严格 UTF-8 解码。 |

### `src/role-runtime.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 153 | delete | `for (const stage of entry.stages) { if (!/^[a-z][a-z0-9-]*$/.test(stage.id) \|\| seen.has(stage.id)) throw new Error(`Invalid activation stage id for ` | Module-load spelling regex plus duplicate scan over hardcoded literals defined ten lines above; nothing external supplies these ids, and ADR 0019 deletes the stage machinery entirely. |

### `src/uuidv7.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | keep | `const UUIDV7=/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;export function isUuidV7(value:unknown):value is string{return ty` | Lowercase-hex UUID spelling is a D2 law, but ADR 0026 rules it is not a factory-wide contract: the assisted consumers die with D6 and the only survivors are src/navigator-contracts.ts and src/package-contracts/navigator-output.ts, which are #28's territory and untouched by #58. |

### `test/assisted-runner.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 5 | delete | `for(const invalid of [valid.toUpperCase(),"018f22a0-7b4c-6abc-8def-0123456789ab","malformed"]){assert.equal(isUuidV7(invalid),false);await assert.reje` | UUIDv7 小写表示拒绝是纯呈现法条，ADR 0026 明示随 Assisted 整体删除，不作为全车间契约。 |

### `test/canonical-json.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 6 | delete | `test("Doctor consumers share recursive canonical JSON semantics", ... assert.equal(canonicalJson(left), expected)` | ADR 0030：canonical JSON 不再是输入输出契约。Doctor 只需内容相等，应直接比对；此测试锁定的是键排序序列化本身。 |
| 15 | delete | `test("canonical JSON rejects the closed domain counterexamples with typed structural paths", ... 12 cases: NaN/Date/sparse/cyclic/symbol/BigInt ... er` | 包内自设的封闭 JSON 值域格式法条，逐例锁定拒绝路径字符串；ADR 0030 明令序列化不得成为输入拒绝条件。 |

### `test/collector-config.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 75 | delete | `const rejected=["https://github.com/a/b","a/b?x=1","user:pass@a/b","a//b","ä/b","-a/b","a/_b",...]; for(const input of rejected) assert.throws(()=>par` | 整张 owner/repo 拼写文法表是表现形式法条；命令真正可执行只需要「能切出 owner 与 repo」，其余由 GitHub API 自己响亮失败。 |
| 112 | shrink | `for (const bad of ["0","-1","1.5","01","1e2","NaN","9007199254740992",""]) assert.throws(()=>parseCollectorPrNumber(bad),/pull request\|PR/i,bad)` | PR number 是 ADR 0040 明列的必需执行判别项，正整数要求保留（0/-1/NaN/空）；"01"/"1e2" 这类数字词法拼写拒绝属 D2 删除。 |
| 200 | shrink | `const topDup=await writeManifest(dir,'{"version":1,"version":2,...}'); await assert.rejects(()=>loadCollectorManifest(topDup),/duplicate/i);` | ADR 0021：unreadable/非 UTF-8/非法 JSON 三案保留（标准 parser 的响亮失败），三条重复 key 词法扫描案（top-dup/nested-dup/escaped-dup）随 assertCollectorManifestJsonIdentity 删除。 |
| 239 | delete | `["float-version",{version:1.1,...},/version/i],["string-version",{version:"1",...},/version/i]` | manifest 只有一个 reader 分支，version 不选择任何真实读取路径，ADR 0044 判删；此两案随之删除。 |
| 244 | delete | `["bad-id-case",{legs:[{id:"Codex"...}]},/id/i],["bad-id-start",{legs:[{id:"1codex"...}]},/id/i]` | legId 的大小写/首字符文法是拼写法条；真实需要的是 legId 唯一且能作 key，与拼写无关。 |

### `test/collector-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1231 | shrink | `const legs = await writeLegs(home, { version: 2, legs: [] });` | 该 fail-closed 测试的 fixture 同时踩 version!==1（删）与 legs 为空（留）；删掉 version 校验后 fixture 必须改成只靠空 legs，否则测试意图漂移。 |

### `test/fixer-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 96 | delete | `test("every surviving Fixer rejection names its violated field or constraint", ... /report.*nonblank/i, /classResults.*name.*unique/i, /classResults.*` | 这条测试的被测对象是错误消息的措辞本身（对自由文本建机械依赖，违反锚定宪法），且其中两行绑定的唯一性法条本身处于删除/待裁决状态。 |

### `test/fixer-prerequisite-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 80 | delete | `[JSON.stringify([{ id: "bad/id", requirement: "x" }]), /id.*pattern/],` | FIXER_PREREQUISITE_ID_PATTERN 是字符集拼写法条；真正需要的是"输出引用的 prerequisiteId 必须已声明"（K5，另有覆盖），不是 ID 长什么样。 |
| 121 | delete | `{ cause: "prerequisite_unmet", prerequisiteId: "bad/id", evidence: "malformed" },` | ID 拼写模式拒绝，随 pattern 删除；配套的 `Value.Check(...) === (index === 2)` parity 断言（L129-130）同删。 |

### `test/judge-posture-recordings.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 299 | shrink | `if (!text.includes("Judge verdict accepted")) return; ... assert.match(sole.contentText, /Judge verdict accepted/);` | 把 JUDGE_ACCEPTED_TEXT 的措辞硬编码成字面量而不是 import 包常量，对自由文本建机械依赖；应改为消费 typed 常量。 |

### `test/judge-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 175 | shrink | `assert.deepEqual([...harness.flags], [["ak-role", { description: "Activate a packaged workflow role: judge, fixer, ...", type: "string" }], ...]) // 全` | 把 14 个 CLI flag 的帮助文案逐字钉死（含 Collector 那两段长描述）。按 CLAUDE.md 内容分层，CLI 参数说明的真源是 README/CLI help，不该由测试建立措辞契约；保留 flag 名单与顺序即可。 |
| 426 | shrink | `description: "Submit a plan, completion, or evidence-bearing refusal for the active coder phase. commitSha is advisory evidence for the caller." ... p` | 对工具 label/description/promptSnippet/promptGuidelines 做逐字 deepEqual，是对呈现文案的机械依赖；且 commitSha 那句随 ADR 0024 删除。 |

### `test/merger-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 34 | delete | `assert.throws(() => validateMergerInput({ ...valid(), expectedConflictPaths: ["dir/b.txt", "a.txt"] }), /canonical/);` | 要求路径集按字节排序＝纯表现形式法条（merger-contracts.ts:38-39），与"scope 必须覆盖冲突集"这一真实语义无关。 |

### `test/merger-git-state.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 31 | delete | `assert.match(active.automaticMergeTreeId, /^[0-9a-f]{40,64}$/);` | 对 git 自己产出的对象 ID 做十六进制拼写正则；ADR 0028/0036 删除外观校验，真实绑定由后续 completedMerge(tree) 比对承担。 |

### `test/merger-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 92 | delete | `assert.deepEqual(parameters.examples, [{ status: "completed", attemptId: "<assignment attemptId>", ... }, ...]);` | 对占位样例文案做逐字等值断言，属呈现层锚定；schema 直接表达两个叶后不再需要用 examples 补形状。 |

### `test/navigator-contracts.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 12 | keep | `assert.equal(canonicalSnapshotDigestV1({...input,capturedAt:"2025-01-02T00:00:00.000Z"}),digest)` | canonical JSON 摘要作为输入拒绝条件属 ADR 0030 删除类，但 Navigator 用途归 #28，#58 范围例外。 |

### `test/navigator-evidence.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 6 | keep | `assert.throws(()=>store.read("e",1,16_384),/UTF-8/);assert.equal(decodes,1)` | 「只做一次严格 UTF-8 解码」正是 ADR 0029 想要的形态；且属 Navigator，#58 范围例外。 |

### `test/reviewer-agent.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 248 | shrink | `assert.match(result.target.targetHead, /^[0-9a-f]{64}$/);` | 对 Git 输出做十六进制外观断言属 D2；应改断与实际 rev-parse 值相等（同 reviewer-pinned-reader.test.ts:66）。 |

### `test/reviewer-pinned-reader.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 66 | shrink | `assert.match(reader.pin.targetHead, /^[0-9a-f]{64}$/);` | 对 Git 输出做十六进制外观断言属 D2；应改成断言与 `git rev-parse HEAD` 的实际值相等。 |

### `test/reviewer-runtime-receipt.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 29 | needs-adjudication | `test("Reviewer target IDs are bound to the accepted object format") value.identities.target.objectFormat="sha256"; assert.throws(()=>validateRuntimeRe` | 目标身份与实时 pinned target 一致属 K3 保留，但本断言压的是「40 位 vs 64 位十六进制长度」这一呈现校验（ADR 0028 判删）。需裁决保留哪一半，且 :47 的真实 target 绑定覆盖是否够。 |

## D3 重复身份外壳与无 reader branch 的 version（79）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 150 | shrink | `{"status":"planned\|completed\|refused","report":"Markdown report","commitSha":"optional self-report"}` | ADR 0024 从 Coder Schema/details/README 示例中删除自报 commitSha；示例须收成 status+report。 |
| 155 | delete | ``commitSha` remains advisory evidence rather than a hard package gate.` | ADR 0024 删除该字段后此句失去对象，属于文档承诺与裁决相矛盾。 |
| 173 | shrink | `{"version":1,"taskSha256":"<SHA-256 of exact task bytes>","tools":["read","bash"],"prerequisiteOperations":[...]}` | 固定 `version:1` 不选择任何真实 reader 分支，按 ADR 0044 删除；同段 line 159 的 "narrow V1 capability file" 措辞同步收敛。 |
| 235 | shrink | `Commits are only `commitSha` values in typed details of accepted terminating results; abbreviated SHAs retain their stated precision.` | ADR 0024 删除 Doctor 的 Coder commit 投影；此句须收成只覆盖仍存在的来源（Fixer per-class），"abbreviated SHA" 说明随自报字段消失。 |
| 249 | needs-adjudication | `It binds `attemptId`, exact target/source full object IDs, digest-bound UTF-8 task/authority/target-intent/source-intent bytes, the byte-sorted comple` | "digest-bound UTF-8 bytes" 若摘要与文本同在一个输入对象里即自指身份壳（ADR 0028/0031 删）；若确与现场文件字节重算比对则属 K3。需 src 区确认摘要比对对象。 |

### `schemas/collector-legs-v1.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 8 | delete | `"version": { "const": 1 },` | 固定 version 不选择任何真实 reader 分支，按 ADR 0044 删除（ADR 0021 已声明 0044 在此优先）。 |

### `schemas/navigator-receipt-v1.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 21 | keep | `"version":{"const":1}` | [#58 不改，ADR 0044 同类；Navigator 归 #28] 没有任何 consumer 同时读第二版本，version 选不出真实 reader 分支。 |

### `src/canonical-skill-binding.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 15 | delete | `snapshotIdentity: ReviewerPromptIdentity;   // ... snapshotIdentity: reviewerPromptIdentity(raw),` | This is the {text, utf8Length, sha256} envelope ADR 0031 deletes and ADR 0032 explicitly strips from the kept binding; it flows into the receipt via src/reviewer-settlement.ts:33,42 as canonicalSkill.{sha256,utf8Length,snapshotIdentity} — length/digest recomputed over text the process already holds. |

### `src/collector-config.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 5 | delete | `export const COLLECTOR_MANIFEST_VERSION = 1 as const;` | Exported version constant has no reader anywhere in src/, bin/ or scripts/ — dead version surface, deletes with the version field. |
| 73 | shrink | `canonicalJson: string;  ...  sourcePath: string;  ...  const canonicalJson = stableCanonicalJson({ version: 1, legs }); return { version: 1, legs, can` | canonicalJson and sourcePath have no consumer outside this file (only test fixtures set them), leaving a canonical-text/digest identity envelope where only `digest` is really consumed (marker prefix and receipt manifestDigest). |
| 512 | delete | `if (parsed["version"] !== 1) { fail("Collector manifest version must be the exact integer 1"); }` | No reader branches on manifest version and there is no persisted multi-version data, so ADR 0044 removes it (note: ADR 0021 listed version===1 as retained — that sentence predates 0044 and I read 0044 as the later, on-point ruling). |

### `src/collector-receipt.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 790 | delete | `manifestVersion: 1,` | 固定 version 字段且无任何多版本读取分支（唯一消费点是 package-contracts/collector-output.ts:487 的 `!== 1` 拒绝，自我循环）；ADR 0044 判删。 |

### `src/doctor-auditor.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 11 | shrink | `const frozenIndex = { version: input.patient.version, identity: ..., cost: ..., evidence: input.patient.evidence.map(({ id, kind, byteLength, contentL` | frozenIndex 的真实目的是「不把 50MB 证据正文重放给 auditor」（test/doctor-auditor.test.ts:25-26），该目的由排除 content 达成；随行的 version 与 sha256 身份壳无消费方，随 DoctorEvidenceEntry 一起删。 |

### `src/doctor-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 43 | shrink | `export type DoctorEvidenceEntry = { id: string; kind: "session" \| "stderr"; byteLength: number; contentLength: number; sha256: string; content: strin` | sha256 全仓无任何 consumer 分支（只被塞进 catalog/frozenIndex/read 响应展示），是纯身份外壳，删；byteLength 有真实消费方（cost.outputBytes 求和）、contentLength 被分页与 hasRead 使用，保留。 |
| 44 | delete | `export type DoctorCase = { version: 1; identity: DoctorCaseIdentity; evidence: DoctorEvidenceEntry[]; cost: DoctorCaseCost };` | version:1 没有任何多版本读取分支（只被原样打进 prompt catalog 与 auditor frozenIndex），是选不出 reader branch 的版本字段。 |
| 67 | shrink | `retries: Type.Object({ count: ..., sources: ..., evidence: Type.Literal("literal run-dir naming") }, { additionalProperties: false }), ... outputBytes` | 三个常量字符串（L67 evidence、L74 payload/providerWireBytes）是给人看的出处注解，没有任何 reader 分支，却被冻成 Type.Literal 拒绝条件；注解可留在 runtime 产物文本里，不该成为输出格式法条。 |
| 117 | shrink | `if (finding.assetEvidence.targetKey !== finding.targetKey \|\| finding.assetEvidence.targetKind !== finding.targetKind) throw new Error("Typed asset e` | assetEvidence 里重复了 finding 自己的 targetKey/targetKind，然后再花一条法条校验两份副本一致；删掉副本只留 evidenceId，这条一致性校验随之消失（同一定义只应有一个真源）。 |
| 123 | shrink | `if (finding.lastRealBite.targetKey !== finding.targetKey) throw new Error("lastRealBite target mismatch");` | lastRealBite 又存了一份 targetKey，再校验它等于 finding.targetKey；删掉这份副本即可，不需要副本一致性法条。 |
| 129 | shrink | `const eligible = patient.evidence.map((entry) => entry.id).sort(); const claimed = [...finding.lastRealBite.eligibleEvidenceIds].sort(); if (canonical` | eligibleEvidenceIds 是模型对 runtime 已持有的完整证据人口的回抄，再用 sort+canonicalJson 做精确集合相等（ADR 0030 反对）；实质要求是 L132 的「全部证据必须已完整读取」，runtime 直接用 patient.evidence 判定即可，字段与集合等值校验可删。 |

### `src/doctor-evidence.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 42 | shrink | `evidence.push({ id, kind, byteLength: bytes.byteLength, contentLength: content.length, sha256: sha256Hex(bytes), content });` | sha256Hex 每份证据算一次摘要，但没有任何验证/绑定消费方，只在 prompt 与 auditor index 里当身份展示；真需要字节身份的消费方应现场重算。 |

### `src/doctor-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 15 | shrink | `const catalog = { version: activation.patient.version, identity: ..., evidence: activation.patient.evidence.map(({ id, kind, sha256, byteLength, conte` | prompt catalog 把 version + sha256 身份壳一并喂给模型；version 无 reader 分支、sha256 无消费方，随 DoctorEvidenceEntry 一起收缩（byteLength/contentLength 表示规模，仍有用）。 |

### `src/merger-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 11 | delete | `version: Type.Literal(1), ... （配合 L52 value.version !== 1）` | 固定 version 字段没有任何 consumer 分支读取第二版本，ADR 0044 明令删除。 |
| 47 | needs-adjudication | `if (sha256Hex(bytes) !== value.sha256) fail(`Merger ${label} material digest mismatch`);` | 两难：ADR 0028 允许保留「现场重算相等」，但此处 bytesBase64 与 sha256 同在一个调用方自写的 JSON 里、全仓无外部 producer（grep bytesBase64 只命中 src/merger-* 与测试），digest 不绑定任何外部对象，实为自指身份信封（D3）——保留还是随 bytesBase64 一起收成纯文本字段需 owner 拍。 |

### `src/merger-git-state.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 53 | shrink | `if (identity.length !== 2 \|\| identity[0] !== mergeCommitId) throw new Error("Git merge completion identity drifted");` | identity.length !== 2 是解析可用性（K6 保留）；identity[0] !== mergeCommitId 在已要求完整 OID 的前提下是自反断言，真正的身份绑定在 L61 currentHead 与 merger-role.ts:57。 |

### `src/navigator-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 31 | keep | `!SHA256.test(String(ref.sha256))…reference:{id:text(ref.id,"reference id"),sha256:String(ref.sha256)}` | [#58 不改，defer→#28] latestAttempt.reference.sha256 是被引用回执的摘要，Navigator 全程不取该回执字节、不重算，只校验十六进制拼写 = 无真实绑定的身份外壳（ADR 0028 的反面）。 |
| 34 | keep | `if(r.version!==1\|\|!isUuidV7(r.runId)\|\|!Number.isSafeInteger(r.positionCursor)\|\|(r.positionCursor as number)<0)fail("snapshot identity")` | [#58 不改，ADR 0026/0044 均把 Navigator 归 #28] version:1 无第二版本读取分支（D3 version 面）；isUuidV7 是小写 UUID 拼写正则（D2）；数字词法/范围检查同属删除类。 |
| 38 | keep | `if(canonicalJson(reads)!==canonicalJson(canonicalActual))fail("evidence read record")` | [#58 不改，defer→#28] evidenceRead 是模型自报的、runtime 已经权威拥有的事实（store.readRecord()），要求模型逐字复述再用 canonical JSON 比对相等 = 重复身份外壳；真消费方直接用 readRecord 即可。 |
| 38 | keep | `if(!navigatorBindingMatchesV1(snapshot,receipt)\|\|canonicalJson(subject(r.subject))!==canonicalJson(snapshot.subject)\|\|canonicalJson(receipt.latest` | [#58 不改，defer→#28] subject 与 latestAttempt 已整体落在 snapshotDigest 里，snapshotDigest 相等即已绑定；再要求回执原样回抄这两块并做 canonicalJson 相等 = 重复身份外壳（navigatorBindingMatchesV1 那半是 K3，保留）。 |

### `src/package-contracts/collector-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 382 | delete | `if (typeof value.normalizedByteLength !== "number") { fail(`snapshots[${index}].normalizedByteLength is invalid`); }` | Byte-length identity/display field carried in the receipt; the real cap check uses a local variable (collector-ledger.ts:764-767), so nothing reads the receipt-carried length. |
| 407 | shrink | `function validateEvidence(value, index): CollectorEvidenceRecord { ... contentDigest: requireNonEmptyString(value.contentDigest, ...), versionId: requ` | versionId + contentDigest is a self-reported identity envelope re-checked at read time; a consumer needing byte identity recomputes it, and here no consumer needs it at all. |
| 487 | delete | `if (value.manifestVersion !== 1) fail("Collector receipt manifestVersion is invalid");` | Version field with no multi-version reader branch anywhere — grep shows only construction (collector-receipt.ts:790) and this check plus the literal type; nothing selects behavior on it. |

### `src/package-contracts/reviewer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 15 | delete | `export type VerbatimChildReport = Readonly<{ text: string; utf8Length: number; sha256: string }>;` | ADR 0031 点名删除 Reviewer 的 {text,utf8Length,sha256} 文本身份壳；报告正文就是唯一必需内容，长度与摘要由 settlement 现算又在 L99 现算校验，纯自证同义反复。 |
| 36 | shrink | `canonicalSkill: Readonly<{ sha256: string; utf8Length: number; snapshotIdentity: ReviewerPromptIdentity }>;` | 外层 sha256/utf8Length 是 settlement L42 从 snapshotIdentity 原样复制的重复身份壳；K8 需要的展开绑定由 reviewer-role.ts:231 captureExpansion 承担，回执只需保留 Skill 文本本身。 |
| 65 | delete | `output.version !== 2` | 全仓只有 RuntimeReviewerReceiptV2 一个读取分支，无 v1 迁移数据，ADR 0044 判删不参与真实分支选择的固定 version。 |
| 71 | delete | `!exactKeys(skill, ["sha256", "utf8Length", "snapshotIdentity"]) ... !isReviewerPromptIdentity(skill.snapshotIdentity) \|\| skill.sha256 !== skill.snap` | settlement L42 刚刚把 snapshotIdentity.sha256/utf8Length 复制成外层字段，这里再比一次是纯同义反复；isReviewerPromptIdentity 又对同一文本重算长度与摘要（ADR 0031）。 |
| 87 | delete | `!exactKeys(leg, ["axis", "prompt"]) \|\| !isRecord(leg.prompt) \|\| !exactKeys(leg.prompt, ["text", "utf8Length", "sha256"]) \|\| !isReviewerPromptIde` | 每条腿的 prompt 又是一层 {text,utf8Length,sha256} 身份壳并现场重算，ADR 0031 判删；axis 作为真实 key 保留即可。 |
| 98 | shrink | `if (report !== undefined && (!isRecord(report) \|\| !exactKeys(report, ["text", "utf8Length", "sha256"]) \|\| typeof report.text !== "string" \|\| rep` | ADR 0031 点名的 Reviewer 文本身份壳：长度与摘要都由同一段 text 现算再比自己。只保留报告文本本身（typeof string）。 |
| 108 | delete | `!exactKeys(materialized, ["leg", "workspaceIdentity", "manifestSha256", "entries"]) ... entry.utf8Length !== expected.utf8Length \|\| entry.sha256 !==` | 真正的字节回读绑定已在真实 I/O 接缝完成（reviewer-bundle-materializer.ts:45 用实际文件字节比对长度与摘要）；此处是对该 evidence 的第二份同构复核，且 utf8Length 与 sha256 重复表达同一身份。 |
| 125 | shrink | `if (!sameReviewerPromptIdentity(outcome.prompt, expectedLegs[index]!.prompt)) throw new Error("Reviewer outcome prompt disagrees with accepted leg");` | sameReviewerPromptIdentity 除比文本外还比 utf8Length 与 sha256——文本相等时后两者必然相等。要比就直接比文本（ADR 0031）。 |

### `src/package-contracts/terminating-tools.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 186 | delete | `case FIXER_OUTPUT_TOOL_NAME: { const output = details as WorkerOutput; return { status: output.status, ...("commitSha" in output && output.commitSha ?` | Model-self-reported commit projection: ADR 0024 removes Coder commitSha and Fixer's commit lives per class, so this branch becomes permanently dead while still shaping doctor-evidence's commit column. |

### `src/reviewer-admission.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 36 | delete | `if(!record(proposal)\|\|proposal.version!==1) fail("proposal-invalid", "proposal.version must equal 1");` | 无第二版本 reader，也无历史持久数据需迁移，ADR 0044 判删。 |

### `src/reviewer-agent.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 29 | delete | `for (const leg of dispatch.legs) if (!isReviewerPromptIdentity(leg.prompt)) throw new Error("Accepted Reviewer prompt evidence mismatch");` | 第三次对同一批 prompt 身份壳重算摘要自证（construction 89、ledger 171 已各一次）。 |

### `src/reviewer-bundle-materializer.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 16 | delete | `if (!verifyBundleIdentity(bundle)) throw new Error("Mechanical bundle digest or manifest mismatch");` | 对同进程刚构造的 bundle 复核自制 manifest 摘要（ADR 0042 不保留 runtime 对自生成对象的二次精确校验）。 |
| 45 | delete | `if (bytes.byteLength !== item.utf8Length \|\| sha256Hex(bytes) !== item.sha256) throw new Error("Mechanical bundle readback mismatch");` | 把自己上一步刚写下的字节回读再核对长度与摘要，是对自生成对象的二次精确校验（ADR 0042），失败也无第二种处置。 |
| 47 | delete | `return Object.freeze({ leg, workspaceIdentity: sha256Hex(root), manifestSha256: bundle.manifestSha256, entries: ...({ id, relativeClonePath, utf8Lengt` | MaterializedBundleEvidence 整体是身份壳：workspaceIdentity 只是临时目录路径的摘要（唯一消费方 reviewer-output.ts 仅检查它是非空字符串），verified:true 是恒真常量，entries 的长度/摘要与 bundle 完全重复。 |

### `src/reviewer-construction.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 8 | shrink | `export const REVIEWER_CONSTRUCTION_RECIPE = Object.freeze({ recipeId, version: 1, runtimeVersion: "1", implementationSha256: sha256Hex("reviewer-commo` | version/runtimeVersion 选不出任何 reader 分支（ADR 0044），implementationSha256 是对硬编码常量字符串取摘要、全仓无任何比较方消费；只有 recipeId 进了 prompt 与 recipe 判别。 |
| 49 | shrink | `export type CanonicalSkillIdentity = Readonly<{ sha256: string; utf8Length: number; snapshotIdentity: ReviewerPromptIdentity }>;` | 同一段 canonical Skill 文本的身份被表达三层（外层 sha256+utf8Length、内层 snapshotIdentity 再一份）；ADR 0032 要保的是「Pi 真的展开了该 Skill 且原样保留 task」，不是这个壳。 |
| 52 | delete | `return Object.freeze({ id, relativeClonePath: path, origin, sourceIdentity, bytes, utf8Length: Buffer.byteLength(bytes), sha256: sha256Hex(bytes) });` | bundle entry 的 utf8Length/sha256 是包内自己刚拼出的字符串的摘要，唯一消费方是同一进程的 verifyBundleIdentity 与 materializer 回读自比（ADR 0042 明令不保留 runtime 对自生成对象的二次精确校验）。 |
| 54 | delete | `function manifestBytes(entries){ return JSON.stringify({ recipeIdentity: REVIEWER_CONSTRUCTION_RECIPE, entries: entries.map(({ bytes: _bytes, ...ident` | manifest 序列化 + manifestSha256 是包对自己内存对象的自制清单摘要（ADR 0030：序列化不得成为额外拒绝条件），下游 reviewer-output.ts 再 verifyBundleIdentity 一次形成第二座契约工厂（ADR 0042）。 |
| 89 | delete | `if(!isReviewerPromptIdentity(first[i]!)\|\|!isReviewerPromptIdentity(second[i]!))throw new ReviewerConstructionError("prompt-identity-invalid");if(!sa` | 对本函数上一行刚用 reviewerPromptIdentity 造出的对象再验一次长度与摘要，纯自证；随身份壳与两遍编译一起删。 |
| 104 | delete | `return bundle.entries.every((item) => exactUtf8(Buffer.from(item.bytes), item.id) === item.bytes && Buffer.byteLength(item.bytes) === item.utf8Length ` | 把内存中的 JS 字符串编码成 Buffer 再严格解码回来自比（ADR 0029 删除 round-trip），再核对自己刚写的长度与摘要；被 materializer 与 package-contracts/reviewer-output.ts 两处消费，属同一自证契约的平行副本。 |

### `src/reviewer-dispatch.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 29 | delete | `return Object.freeze({version:1,taskSha256:v.taskSha256,document:reviewerPromptIdentity(text),tools:...})` | document 把能力文件文本再包成 {text,utf8Length,sha256} 身份壳，下游唯一动作是 reviewer-execution-ledger.ts:164 用 isReviewerPromptIdentity 对它自身重算一次（同义反复）；ADR 0031 判删。 |

### `src/reviewer-execution-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 129 | delete | `\|\| event.violation !== "schema" \|\| event.started !== false) throw new Error("Transport rejection must contain only immutable bounded non-start evi` | violation 只有 "schema" 一个取值、started 恒为字面量 false，二者都选不出任何 reader 分支，只是对包内自己刚构造的事件复述常量。 |
| 162 | delete | `if (!isReviewerPromptIdentity(event.input.task)) throw new Error("Accepted task bytes, length, or SHA disagree"); ... capabilityDocument / materials /` | 对同进程 construction 刚算出的四类身份壳逐个重算摘要自比，ADR 0031/0042 双重命中，且这些对象没有跨进程边界。 |
| 188 | delete | `if (event.cardinality !== accepted.legs.length) throw new Error("Dispatch start cardinality disagrees with acceptance");` | cardinality 是 runtime 对 accepted.legs.length 的自报副本（1\|2），删掉字段本身即可，不需要一条法来核对自己抄得对不对。 |

### `src/reviewer-pinned-git.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 55 | shrink | `materials.push(Object.freeze({...item,text:text!,utf8Length:bytes!.byteLength,sha256:sha256Hex(bytes!)}));` | ADR 0031：材料只保留 text；utf8Length/sha256 是同一字节的身份壳，且 bundle entry 会对同一文本再算一遍（construction.ts:52）。 |

### `src/reviewer-prompt-identity.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 4 | delete | `export type ReviewerPromptIdentity = Readonly<{ text: string; utf8Length: number; sha256: string; }>` | ADR 0031 名点删除 Reviewer {text,utf8Length,sha256} 身份壳；需要确认两段文本一致时直接比较 text 即可，不必随文本携带并反复重算长度与摘要。 |
| 18 | delete | `export function isReviewerPromptIdentity(value){ const actual = reviewerPromptIdentity(value.text); return value.utf8Length === actual.utf8Length && v` | 对本进程刚生成的对象重算摘要再自比，是纯自证；删掉身份壳后该函数无剩余语义（全部 5 个调用点见 construction/ledger/agent/output）。 |
| 23 | shrink | `return first.text === second.text && first.utf8Length === second.utf8Length && first.sha256 === second.sha256;` | 真正需要的是 first.text === second.text（K3 交付 prompt 与编译 prompt 同一）；后两项是同一事实的长度/摘要复述，随 ADR 0031 删除。 |

### `src/reviewer-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 36 | delete | `version: Type.Literal(1),` | proposal 只有一个读取分支（admitReviewerProposal），ADR 0044 判删不选择真实 reader 分支的固定 version（admission L36 的同名检查同判）。 |

### `src/reviewer-settlement.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 27 | shrink | `reports[axis] = { text, utf8Length: Buffer.byteLength(text, "utf8"), sha256: sha256Hex(text) };` | 回执里子代报告只需 verbatim text；utf8Length/sha256 是 ADR 0031 明确删除的身份壳，且 package-contracts/reviewer-output.ts 还会再算一遍来校验它自己刚算的值。 |
| 35 | delete | `return freeze({ version: 2, status: input.intent.status, ...` | ADR 0044：没有第二个真实读取分支的固定 version 字段删除；唯一消费方 validateRuntimeReviewerReceipt 只做 output.version !== 2 的自证拒绝。 |

### `src/worker-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 55 | delete | `commitSha: Type.Optional(Type.String({ minLength: 1 })),` | ADR 0024 deletes the Coder self-reported commitSha from tool schema, accepted details, README and Doctor projection; a nonblank string proves no Git object. |

### `test/canonical-skill-binding.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 67 | shrink | `assert.deepEqual(binding.snapshot, { raw, path: canonicalPath, baseDir, body, snapshotIdentity: reviewerPromptIdentity(raw) });` | ADR 0031+0032 明令删除 {text, utf8Length, sha256} 身份壳；canonical Skill 展开绑定（captureExpansion 的逐字匹配）保留，快照里的 snapshotIdentity 删。 |

### `test/class-contracts.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 38 | delete | `assert.deepEqual(validateAcceptedWorkerDetails({ status: "completed", report: "done", commitSha: "advisory" }, "Coder"), ...)` | ADR 0024 删除 Coder 自报 commitSha；此断言是该字段唯一的正向锁定。 |

### `test/collector-config.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 157 | shrink | `assert.equal(first.digest,second.digest);assert.equal(first.digest.length,64); ... assert.equal(first.canonicalJson.includes("CodexBot"),false)` | 作者名小写归一保留（GitHub login 语义，K6）；digest 长度 64 的展示校验与 canonicalJson 稳定性断言属 D2/D3——ADR 0028/0030 只允许真实字节绑定，不允许摘要外观与序列化成为契约。 |

### `test/doctor-case.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 66 | shrink | `assert.equal(entry.contentLength, entry.content.length); assert.notEqual(entry.contentLength, entry.byteLength);` | DoctorEvidenceEntry 的 {byteLength, contentLength, sha256, content} 是重复身份外壳；真消费方需要字节身份时现场重算即可。contentLength 仅为分页服务，而分页上限本身是 D4。 |
| 82 | delete | `test("commit accounting admits only typed commit SHAs from accepted terminating results", ... details: { status: "completed", ..., commitSha: "abc1234` | 整条测试的被测行为是 Doctor 从 Coder 自报 commitSha 投影 commits；ADR 0024 明令删除 Coder commitSha 及 Doctor 的该投影。 |
| 117 | shrink | `assert.deepEqual(patient.cost.commits, [{ source: "coder/session/terminal.jsonl", commit: "abc1234" }]);` | 该测试的"中间 toolResult 不终结、不制造 status"部分是 K6 保留；仅 commits 断言随 ADR 0024 删除（L44、L93-95 同）。 |

### `test/judge-posture-recordings.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 682 | needs-adjudication | `const digest = soulDigest(bundle.soulText); assert.equal(bundle.meta.soulDigest, digest); assert.ok(sessionContainsSoul(bundle.sessionText, bundle.sou` | 用 souls/judge.md 的 sha256 把录制夹具钉死在当前 Soul 字节上，并要求 session 里逐字含 Soul 正文。这是 D3 摘要身份壳＋Soul 散文耦合：Soul 每次 owner 直改都会红灯，必须重录。是否保留"录制确实用了当时的 Soul"这一证据、以何种形式保留，需裁决。 |

### `test/merger-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 9 | delete | `const valid = () => ({ version: 1 as const, attemptId: "attempt-22-a", ... })` | ADR 0044：merger 输入的固定 version:1 不选择任何真实 reader 分支（validateMergerInput 只检查 !== 1 就拒），字段与校验同删，夹具随之更新。 |

### `test/package-entrypoint.integration.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 596 | shrink | `await writeFile(packetPath, JSON.stringify({ version: 1, instructions: "# Approved repair\n\nApply it.", prerequisites: [] }));` | fix packet 的固定 version:1 不参与任何 reader 分支（ADR 0044 判删），fixture 应随 packet 契约收缩；instructions 非空与 prerequisites 保留。 |

### `test/reviewer-dispatch.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 21 | shrink | `assert.throws(()=>parseReviewerCapabilities(Buffer.from(JSON.stringify({version:1,taskSha256:"0".repeat(64),tools:[],prerequisiteOperations:[]})),task` | taskSha256 与真实 task 字节重算相等保留（ADR 0028 的字节绑定）；但 src/reviewer-dispatch.ts:29 同时有 exact(value,[...]) 闭合键集合（D1）、version!==1（D44）与 /^[0-9a-f]{64}$/ 外观校验（D2）——这三项删除后本断言需相应收缩。 |

### `test/reviewer-execution-ledger.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 53 | delete | `assert.equal(record.accepted?.legs[0]?.prompt.utf8Length, 12);` | 对 utf8Length 的断言只服务于被删的身份壳。 |
| 62 | shrink | `assert.throws(()=>rejectingLedger.append(changed),/capability document bytes, length, or SHA disagree/)` | 三件套（text+utf8Length+sha256）互校属 ADR 0031 删除面；确实需要确认「同一份 capability 文档」时直接比较字节即可。 |

### `test/reviewer-package-lifecycle.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 153 | delete | `assert.equal(finalOutput.message.details.version, 2);` | Reviewer receipt 的 version:2 在 src 中只有写入点（reviewer-settlement.ts:35 与类型声明），没有任何 consumer 按它分支——ADR 0044 判删；:208 同型。 |

### `test/reviewer-pinned-reader.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 174 | delete | `test("shared prompt identity validates exact UTF-8 bytes, length, and SHA-256") assert.equal(isReviewerPromptIdentity({...identity,utf8Length:identity` | 这是 Reviewer 文本身份壳的核心谓词，ADR 0031 判删；isReviewerPromptIdentity 的 src 使用点随身份壳一起收缩。 |

### `test/reviewer-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 181 | shrink | `test("runtime receipt preserves exact report UTF-8 bytes, length, and SHA") assert.deepEqual(receipt.details.reports.standards,{text:exact,utf8Length:` | ADR 0031 判删身份壳；保留「报告原文逐字节不被改写」的断言，删掉 utf8Length/sha256 两列。 |

### `test/reviewer-runtime-receipt.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 16 | delete | `const reports=Object.fromEntries(axes.map(axis=>[axis,{text:`${axis} report`,utf8Length:Buffer.byteLength(...),sha256:sha256Hex(...)}]))` | ADR 0031 明令删除 Reviewer 的 {text,utf8Length,sha256} 文本身份壳；整个 fixture 与围绕它的断言随之删除或降为纯文本比较。 |

## D4 package 自设任意上限（36）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 213 | delete | `eligibility cutoff is 15 minutes from first model dispatch (request/wait gate; final observe/output may finish afterward);` | F040 的 15 分钟包内自设上限按 ADR 0035 删除。 |
| 214 | delete | `hard limits: 8 MiB UTF-8 normalized evidence per complete snapshot and 32 MiB per self-contained receipt/invocation materialization; overflow fails no` | 包内自设字节上限 + 自设 fatal，按 ADR 0035/0042 删除；"UTF-8 normalized" 归一化措辞按 ADR 0029 一并去掉。 |
| 233 | delete | ``ak_doctor_evidence` pages exact admitted session bytes in chunks of at most 4096 characters` | F043 的 4096 read limit 是包内自设分页上限，按 ADR 0035 删除。 |

### `schemas/collector-legs-v1.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 34 | delete | `"x-maxUtf8Bytes": 60000` | F039 的 60,000 UTF-8 bytes 包内自设上限，ADR 0035 明令删除（ADR 0021 同款声明优先）。 |

### `src/collector-config.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 6 | delete | `export const COLLECTOR_REQUEST_BODY_MAX_BYTES = 60_000;` | ADR 0035 names this 60,000 UTF-8 byte cap (F039) for deletion; it is a package-invented limit, GitHub's own comment limit is the only real external bound. |
| 447 | delete | `const bytes = Buffer.byteLength(body, "utf8"); if (bytes > COLLECTOR_REQUEST_BODY_MAX_BYTES) { fail(`Collector leg \"${id}\" request body must be at m` | Enforcement site of the invented 60k byte cap; an over-long body fails loudly at the GitHub POST, which is the real and only unavoidable bound. |

### `src/collector-evidence.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 12 | delete | `export const COLLECTOR_SNAPSHOT_MAX_BYTES = 8 * 1024 * 1024;` | Package-invented 8 MB snapshot ceiling; ADR 0035 deletes package-local arbitrary size limits and no external system imposes this number. |
| 13 | delete | `export const COLLECTOR_RECEIPT_MAX_BYTES = 32 * 1024 * 1024;` | ADR 0042 explicitly orders Collector's self-imposed size fatal deleted; consumers are collector-receipt.ts:805 and collector-ledger.ts:427. |
| 14 | shrink | `export const COLLECTOR_ELIGIBILITY_MS = 15 * 60 * 1000;` | As the eligibility window it is real domain policy, but as an input rejection (collector-tool-schemas.ts:26 `maximum` and collector-ledger.ts:1017 rejecting durationMs > eligibility) it is the F040 15-minute cap ADR 0035 deletes — the runtime already clamps each wait to remaining eligibility. |
| 451 | delete | `export function createSnapshotByteBudget(maxBytes: number = COLLECTOR_SNAPSHOT_MAX_BYTES) { ... if (bytes > maxBytes) { throw Object.assign(new Error(` | Incremental retain budget exists only to enforce the invented byte cap (with measureNormalizedBytes at 442 and the duplicate final gate at collector-ledger.ts:765); it re-serializes every page just to reject on size. |

### `src/collector-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 425 | delete | `const assertMaterializationWithinBound = (label: string): void => { const bytes = materializationByteLength(); if (bytes > COLLECTOR_RECEIPT_MAX_BYTES` | 包内自设 32MiB 上限（collector-evidence.ts:13），无外部硬约束依据；ADR 0035 判删同类任意大小上限。连带 materializationByteLength 每次 observe/request/wait 全量 JSON.stringify 的成本一起消失。 |
| 765 | delete | `if (normalizedByteLength > COLLECTOR_SNAPSHOT_MAX_BYTES) { throw latchFatal(`Collector snapshot exceeded ${COLLECTOR_SNAPSHOT_MAX_BYTES} UTF-8 bytes (` | 包内自设 8MiB 快照上限，同 ADR 0035 类别；GitHub 侧没有这个硬限制，超限只会把真实 PR 证据判死。 |
| 1017 | delete | `if (input.durationMs > COLLECTOR_ELIGIBILITY_MS) { throw new Error(`Collector wait durationMs must be at most ${COLLECTOR_ELIGIBILITY_MS}`); }` | ADR 0035 明确点名删除 15 分钟等待上限类；实际执行时长本来就被 L1030 的 min(remaining, 5min) 夹住，拒绝更大的请求值没有任何必要。schema 的 maximum 同删。 |

### `src/collector-receipt.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 804 | delete | `const bytes = Buffer.byteLength(JSON.stringify(receipt), "utf8"); if (bytes > COLLECTOR_RECEIPT_MAX_BYTES) { throw ledger.latchFatal(`Collector receip` | 包内自设 32MiB 输出上限，无外部硬约束；ADR 0035 判删同类。且与 ledger 的 assertMaterializationWithinBound 是同一上限的第二次执行。 |

### `src/collector-tool-schemas.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 24 | shrink | `durationMs: Type.Integer({ minimum: 1, maximum: COLLECTOR_ELIGIBILITY_MS })` | `maximum` is a package-invented 15-minute cap (COLLECTOR_ELIGIBILITY_MS, collector-evidence.ts:14) re-asserted a second time at collector-ledger.ts:1017-1021 — delete the schema maximum (D4 + duplicate); keep `minimum: 1` as the genuine minimum executable condition. |
| 26 | delete | `durationMs: Type.Integer({ minimum: 1, maximum: COLLECTOR_ELIGIBILITY_MS })` | Package-local arbitrary wait ceiling (COLLECTOR_ELIGIBILITY_MS = 15min) that ADR 0035 deletes by name, duplicated at src/collector-ledger.ts:1017 while the runtime already clamps effectiveMs = min(remaining, 300_000) — nothing needs the rejection; `minimum: 1` stays as the minimum condition for a wait to execute. |

### `src/doctor-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 92 | delete | `export const doctorEvidenceReadSchema = Type.Object({ evidenceId: nonblank, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(` | 4096 是 package 自设分页上限（ADR 0035 点名 F043 4096 read limit 删）；默认页大小可留作默认值，但不得作为拒绝条件。 |
| 100 | delete | `if (offset > entry.contentLength) throw new Error("Evidence offset exceeds content");` | 越界 offset 天然返回空页，没有下游损害，属过度防御；删除时把 offset clamp 到 contentLength 即可（否则会往 coverage 里塞反向区间）。 |

### `src/merger-git-state.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 15 | needs-adjudication | `execFileAsync("git", args, { cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })` | 16MB 是包内自设常量（ADR 0035 的删除对象），但删掉不是取消上限而是回落到 Node execFile 默认 1MB 更严——两难需 owner 拍：是留着这个「抬高外部硬上限」的数字，还是接受 Node 默认。 |

### `src/navigator-evidence.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 8 | keep | `constructor(evidence,handles:ReadonlyMap<string,Uint8Array>,readonly maxPageBytes=16_384){…} … Math.min(limit,this.maxPageBytes,item.bytes.length-offs` | [#58 不改，ADR 0035 明示 Navigator 的 F046 交给 #28] 16_384 是包内自设的任意分页上限，没有任何外部系统硬限制支撑。 |
| 8 | keep | `if(!Number.isSafeInteger(offset)\|\|offset<0\|\|!Number.isSafeInteger(limit)\|\|limit<1)throw new Error("invalid evidence page");if(offset>item.bytes.` | offset>=0 / limit>=1 / offset 不超出内容属「命令真正可执行的最小条件」，是 D4 的保留例外，留最小即可；不要连带扩成分页格式制度。 |
| 9 | keep | `export const navigatorEvidenceReadSchema={type:"object",additionalProperties:false,required:["evidenceId"],properties:{evidenceId:{type:"string"},offs` | [#58 不改，defer→#28] maximum:16384 是 maxPageBytes 的第二份拷贝（D4+D5），additionalProperties:false 是 D1；只需 evidenceId 必需。 |

### `src/reviewer-pinned-git.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 148 | needs-adjudication | `execFileAsync("git", [...], { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 })  /  line 163: maxBuffer: 16 * 1024 * 1024` | ADR 0035 删除包内自设上限，但这两处直接删常量会退回 Node 默认 1 MB（更严的拒绝），真正的处置是改成流式读取而非调参；需 owner 裁 delete-with-streaming 还是保留为「命令可执行的最小条件」。 |

### `src/role-runtime.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 202 | delete | `const TRACE_WRITE_RETRY_LIMIT = 100; export function writeActivationTraceRecord(record, write = writeSync) { ... if ((code === "EAGAIN" \|\| code === ` | Package-invented retry ceiling plus a hand-rolled partial-write loop serving a trace stream that ADR 0019 removes; the surviving failure evidence is one stderr line. |

### `test/assisted-evidence-input-closure.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 6 | delete | `["large",join(f.root,"large"),"AK_EVIDENCE_TOO_LARGE"] ... await fd.truncate(8*1024*1024+1)` | 8 MiB 证据上限是包内自设任意上限（ADR 0035），且随 Assisted acquisition 一并消失。 |

### `test/collector-config.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 281 | shrink | `test("request body enforces trim-non-empty content and exact 60_000 UTF-8 byte bound") await assert.rejects(()=>loadCollectorManifest(overPath),/60,?0` | ADR 0035 明列删除 F039 的 60,000 UTF-8 bytes 上限（含 COLLECTOR_REQUEST_BODY_MAX_BYTES，grep 显示仅 config+测试消费）；trim 后非空的必需性保留。 |

### `test/collector-github.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 640 | delete | `test("R10 multi-page pagination stops before retaining oversize normalized budget") const fat="x".repeat(Math.floor(COLLECTOR_SNAPSHOT_MAX_BYTES*0.3))` | 分页停止条件挂在被删的 8 MiB 自设预算上，随之删除；GitHub 自身的 per_page 等外部硬限制不受影响。 |

### `test/collector-ledger.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 366 | needs-adjudication | `assert.equal(capped.effectiveMs,300_000); ... const COLLECTOR_SINGLE_WAIT_MAX_MS = 300_000 (src/collector-ledger.ts:1029)` | src 里同时存在两种形态：wait 的 5 分钟「截断」（不拒绝）与 durationMs>COLLECTOR_ELIGIBILITY_MS 的「拒绝」（src/collector-ledger.ts:1017，属 ADR 0035 F040 判删）。测试只压截断，须裁决截断是否随输入上限一起删。 |
| 513 | delete | `test("snapshot and ledger size bounds fail loudly without truncation") await assert.rejects(()=>ledger.observe(transport,clock),/8\|snapshot\|bytes/i)` | COLLECTOR_SNAPSHOT_MAX_BYTES=8 MiB 是包内自设任意上限（ADR 0035/0042 明列 Collector 自设大小 fatal 不自动存活）。 |
| 537 | delete | `test("R10 cross-surface normalized budget rejects before later surfaces and terminal PR")` | 跨 surface 归一化字节预算是同一个 8 MiB 自设上限的派生行为，随之删除（另一实例在 :648）。 |
| 1114 | delete | `test("8 MiB snapshot boundary: measured MAX accept and MAX+1 fail")` | 精确边界测试只服务于被删的自设上限，随之删除。 |

### `test/collector-receipt.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1394 | delete | `test("receipt and ledger overflow latch fatal infrastructure failure") assert.ok(COLLECTOR_RECEIPT_MAX_BYTES === 32*1024*1024)` | 32 MiB receipt 上限是包内自设任意上限（ADR 0035/0042），随删。 |
| 2687 | delete | `test("F3 receipt exact 32 MiB valid-rationale MAX accept and MAX+1 fatal") assert.equal(ledgerMax1.fatal,true)` | 精确 MAX/MAX+1 边界测试只服务于被删的自设上限。 |

### `test/collector-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 2378 | delete | `test("F3-receipt-overflow-role-path exact MAX+1 through output execute")` | 角色路径上的 32 MiB 溢出测试随自设上限删除。 |

### `test/doctor-case.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 71 | shrink | `for (let offset = 0; offset < entry.contentLength; offset += 4096) { const page = store.read(evidenceId, offset, 4096); ... }` | ADR 0035 点名删除 F043 的 4096 read limit（doctor-contracts.ts:92 maximum:4096 与 store.read 的 limit>4096 拒绝）。测试的 4096 分页循环随之改写。 |

### `test/navigator-evidence-resource-budget.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 34 | needs-adjudication | `snapshot.evidence = evidence(handle, MAX_NAVIGATOR_EVIDENCE_ITEMS + 1); await assert.rejects(loadNavigatorEvidence(snapshot), /item count/i);` | MAX_NAVIGATOR_EVIDENCE_ITEMS/BYTES 定义在 extensions/role-runtime.ts（宿主层），形态上是 D4 包内自设上限；但语义归属 Navigator，ADR 0035 把 Navigator 的 F046 交给 #28。需裁决它算宿主还是 Navigator。 |

## D5 平行 schema / validator / parity（81）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 80 | needs-adjudication | `Prerequisite declarations are exported as `fixerPrerequisitesSchema`, `parseFixerPrerequisites`, and `validateFixerPrerequisites`` | 同一契约同时公开 schema + parse + validate 三个面，疑似平行 shape validator；真伪需 src 区确认后收成单一边界真源。 |
| 176 | shrink | `The authoritative `Agent` input contract is the exported runtime `reviewerProposalSchema` in [`src/reviewer-role.ts`], with its corresponding TypeScri` | README 同时把 reviewer-dispatch.ts（line 170 "authoritative capability contract and validation"）和 reviewer-role.ts 写成权威契约；ADR 0042 要求单一边界真源。 |
| 207 | delete | `Machine-readable manifest schema: [`schemas/collector-legs-v1.schema.json`](schemas/collector-legs-v1.schema.json).` | ADR 0022 删除该发布 Schema；README 只保留最小输入示例，不再把使用说明升级成第二法源。 |

### `schemas/collector-legs-v1.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `{"$id":"https://ak.local/schemas/collector-legs-v1.schema.json", ...}` | ADR 0022 明令删除该无人消费的发布 Schema 及代码中 COLLECTOR_LEGS_SCHEMA 镜像（src/collector-config.ts:15）与 parity/打包存在性测试；唯一真源是 loadCollectorManifest 的语义校验。 |

### `schemas/navigator-receipt-v1.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 560 | keep | `"allOf":[{"if":{"properties":{"status":{"const":"ordinary"}}…},"then":{"properties":{"primary":{"oneOf":[ …三个变体逐字重写… ]}}}}, …]` | [#58 不改，defer→#28] L560–897 把 L244–553 的 primary.oneOf 六个变体按 status 逐字重抄一遍（约 340 行），同一形状在同一文件里存在两份；status→kind 的必需性（K2）用最小 if/then 引用即可。 |

### `src/canonical-json.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 72 | delete | `export function canonicalJsonBytes(value: unknown): Uint8Array` | 自证循环证据：全仓唯一消费方是 test/canonical-json.test.ts:12，src/extensions/bin/scripts 无任何调用。 |

### `src/collector-config.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 13 | delete | `export const COLLECTOR_LEGS_SCHEMA = { $schema: "https://json-schema.org/draft/2020-12/schema", $id: ".../collector-legs-v1.schema.json", type: "objec` | In-code mirror of the published collector-legs-v1 schema has zero runtime consumer (only test/collector-config.test.ts parity asserts) and ADR 0022 already ruled it plus the published file deleted; loadCollectorManifest is the sole boundary truth. |

### `src/collector-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 191 | delete | `export function collectorToolArgumentsValid(name: string, args: unknown): boolean { if (args === undefined \|\| args === null) return false; switch (n` | 第二份 shape validator：同一批 collector*ArgsSchema 已由 registerTool 的 parameters 拥有（collector-role.ts:56-59 直接引用同一对象），output 分支还会在 parseCollectorOutputCandidate 里再 Check 一次；它唯一的调用点是被 ADR 0041 判删的 batch classifier。 |
| 614 | delete | `if (!isOperationalTool(toolName)) { throw latchFatal(`Unknown Collector tool ${toolName}`); }` | 未知工具名已由 collector-role.ts:286 的 COLLECTOR_REQUIRED_TOOLS 闸和 Pi 的工具注册表拥有，这里是第三份同形状判断。 |
| 1014 | shrink | `if (!Number.isSafeInteger(input.durationMs) \|\| input.durationMs < 1) { throw new Error("Collector wait durationMs must be a positive safe integer");` | 与 collector-tool-schemas.ts:24 的 Type.Integer({minimum:1}) 同形状两份；「正整数」是命令可执行的最小条件，留一份权威真源即可。 |

### `src/collector-receipt.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 26 | delete | `export { validateAcceptedCollectorReceipt };` | buildCollectorReceipt 刚由 runtime 构造出的 receipt，又被 package-contracts/collector-output.ts 一整套手写递归 validator（assertClosedKeys 逐层拒绝未知键，D1）复核一遍——ADR 0043 明令「不对解析后由 runtime 生成的内部对象再次做格式复核」。 |
| 462 | shrink | `if (clock !== undefined) { try { ledger.assertOutputObservationLaw(candidate, clock); } ... } else { // Backward-compatible path for pure unit tests w` | 同一条交卷前置法有两条并行执行路径，其中一条明确只为「没有 clock 的纯单测」存在——生产语义不该有为测试保留的第二实现，测试应注入 clock。 |
| 495 | shrink | `for (const id of candidateIds) { if (!configuredIds.includes(id)) { fail(`Collector output contains unconfigured leg \"${id}\"`); } }` | 与 L508 `const leg = ledger.legById(...); if (leg === undefined) fail(...)` 同形状两份；留 legById 那一份即可（引用解析真源）。 |
| 552 | shrink | `if (qualifying.length === 0) { fail(`Collector valid leg \"${legCandidate.legId}\" lacks a qualifying latest-snapshot review for target HEAD`); }` | 当前不可达：schema minItems:1 保证 evidenceRefs 非空，循环里任一不合格即 fail，故 qualifying.length 必 ≥1。「必须至少一条合格证据」只留一处权威落点（schema 非空 或 此处），不留两份。 |
| 574 | shrink | `const scope = legCandidate.unavailableScope; if (scope !== "target" && scope !== "global") { fail(`Collector unavailable leg ... requires unavailableS` | schema 的 status 判别 union 已拥有「unavailable 才需 unavailableScope」这条跨字段关系（本文件 L120 注释自己承认）；同形状两份，留 schema 一份。 |
| 614 | shrink | `if (qualifying.length === 0) { fail(`Collector unavailable leg \"${legCandidate.legId}\" lacks eligible before/within evidence with declared scope`); ` | 同 L552：schema minItems:1 + 循环内 fail 已使该分支不可达；「至少一条合格证据」只留一处。 |
| 671 | delete | `if (!merged.has(finalSnapshot.snapshotId)) { merged.add(finalSnapshot.snapshotId); } const citesFinal = [...merged].some((ref) => ref === finalSnapsho` | 死代码：紧邻上一行刚把 finalSnapshot.snapshotId 加进 merged（collectMissingProofRefs 也总是包含它），citesFinal 恒为 true，这条 fail 永不可达。 |
| 716 | shrink | `for (const report of reports) { if (report.report.trim().length === 0) fail("Collector receipt forbids blank reports"); if (report.evidenceRefs.length` | 复核的是 runtime 自己刚构造的对象：terminal report 的 report 来自 schema 已保证非空白的 rationale，review report 由 buildReviewReport/factualNonFindingReport 保证非空；ADR 0043 禁止对 runtime 生成物再做格式复核，留 schema 一份。 |
| 730 | delete | `const evidenceIds = evidenceRecords.map((r) => r.evidenceId); if (new Set(evidenceIds).size !== evidenceIds.length) { fail("Collector receipt evidence` | 对象来自 ledger 内部 Map（evidenceById 以 evidenceId 为键，结构上不可能重复）与 runtime 生成的 snapshots；这是对自产内部集合的格式复核，非输入校验。 |
| 745 | shrink | `for (const id of evidenceIds) { if (snapshotIndex.has(id)) fail(`Collector receipt id \"${id}\" is ambiguous across evidence and snapshot namespaces`)` | 全量交叉扫描与 resolveRef（L764）的歧义判定同形状两份；真实引用的歧义由 resolveRef 在使用点接住即可，无需对未被引用的全部 id 做笛卡尔复核。 |
| 779 | shrink | `for (const snapshot of snapshots) { for (const id of snapshot.evidenceIds) { resolveRef(id, `snapshot ${snapshot.snapshotId} evidenceIds`); } }` | evidenceRecords = ledger.allEvidence() 是所有 snapshot.evidenceIds 的超集，这层传递闭包检查是对 runtime 自产结构的复核，恒成立。 |

### `src/collector-tool-schemas.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 73 | shrink | `export const collectorOutputArgsSchema = Type.Object({ legs: Type.Array(collectorOutputLegSchema, { minItems: 1 }) }, ...)  // Value.Check at collecto` | The same output shape is enforced three ways — tool registration (collector-role.ts:59), pre-classification Value.Check (collector-ledger.ts:199-205), and parse-time Value.Check (collector-receipt.ts:99) — plus a hand-written parallel shape in src/package-contracts/collector-output.ts:105-113 and a schema-identity parity test (test/collector-role.test.ts:1329-1333); collapse to one boundary check  |

### `src/doctor-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 64 | delete | `const caseIdentity = Type.Object({ issueNumber: Type.Integer({ minimum: 1 }), runsPath: nonblank }, { additionalProperties: false });` | issueNumber 的 minimum:1 数值法条被 L109 的「必须等于 activated patient identity」完全覆盖：唯一合法值就是现场那一个，数值区间校验是同一事实的第二道校验。 |
| 65 | delete | `const cost = Type.Object({ invocations: count, legs: count, modelApiTurns: count, outputTokens: count, toolCalls: count, retries: ..., statuses: ..., ` | cost 100% 由 loadDoctorCase 现场派生、由 runtime 在回执上封入（doctor-role.ts:14），模型永远不能提交；再为它手写一份 shape schema 是对自家产物的第二份 validator。 |
| 95 | shrink | `export function validateRecordedDoctorOutput(value: unknown): DoctorOutput { if (!Value.Check(doctorOutputSchema, value)) throw new Error("Doctor outp` | doctorOutputSchema(L88-91)=submission schema+cost 的第二份平行 shape validator；唯一消费方链路是 terminating-tools.ts:147 → acceptedFacts 只取 status（doctor-evidence.ts:25 消费）。按 K6，读回执只需薄取 status，不必镜像整张 schema。 |
| 100 | delete | `if (!Number.isInteger(offset) \|\| offset < 0 \|\| !Number.isInteger(limit) \|\| limit < 1 \|\| limit > 4096) throw new Error("Invalid evidence pagina` | schema(L92) 已经声明同样的整数/范围条件，runtime 再手写一份同构 shape 校验；上限部分同时属 D4。 |

### `src/judge-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 99 | delete | `export function validateVerdict(verdict: JudgeVerdictParameters): JudgeVerdict { return validateAcceptedJudgeDetails(verdict); }` | ADR 0023 names the Judge tool schema as sole shape owner and deletes the separately hand-written field-set/type/presentation validator; judge-output.ts's hasExactKeys chain (L66/84/94/96/114/119) is that second validator, and the flat all-optional schema here should instead express converged\|continue\|escalate directly. |

### `src/merger-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 7 | delete | `const oidPattern = "^(?:[0-9a-f]{40}\|[0-9a-f]{64})$";` | 这是 FULL_GIT_OBJECT_ID_RE（src/git-object-id.ts:3）的本地第二份拷贝，只喂给下方无 consumer 的 typebox schema，违反 DRY。 |
| 10 | delete | `export const mergerInputSchema = Type.Object({ version: Type.Literal(1), attemptId: ... }, { additionalProperties: false });` | 输入侧不存在自动应用该 schema 的边界（输入来自 --ak-merger-input JSON 文件，由 validateMergerInput 把关），全仓无消费方，是纯粹的第二份 shape 契约（README:249 需同步改）。 |
| 10 | delete | `export const mergerInputSchema = Type.Object({ ... }); export const mergerOutputSchema = Type.Union([...]);` | 零消费方：validateMergerInput/Output 全手写、merger-role 注册的是 mergerCandidateTransportSchema（空 properties），连测试都不 import 这两个 TypeBox schema，只有 role-runtime.ts:113 转出。平行 schema 死码。 |
| 18 | shrink | `export const mergerOutputSchema = Type.Union([Type.Object({ status: Type.Literal("completed"), ... }, { additionalProperties: false }), ...]);` | ADR 0023 要求工具注册实际消费的 schema 成为唯一 shape owner——现在工具注册的是 merger-role.ts:14 的宽松 transport，这份 union 反而没人用；应把它（去掉 additionalProperties:false）提升为工具 parameters。 |

### `src/merger-git-state.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 45 | shrink | `if (mergeHeads.length !== 1 \|\| !isFullGitObjectId(targetObjectId) \|\| !isFullGitObjectId(mergeHeads[0]) \|\| targetObjectId.length !== mergeHeads[0` | mergeHeads.length !== 1 保留（两父普通 merge 才是本角色能执行的分支，后续父提交核验也依赖它）；对 git rev-parse --verify 自身输出再做 OID 格式与位宽复核属重复护栏，真绑定在 merger-role.ts:38 的相等比较。 |
| 47 | delete | `if (!isFullGitObjectId(automaticMergeTreeId) \|\| automaticMergeTreeId.length !== targetObjectId.length) throw new Error("Git automatic merge tree ide` | 同上：`rev-parse --verify AUTO_MERGE^{tree}` 成功即给出合法 OID，格式与位宽复核是第三层同构护栏（该值随后在 merger-role.ts:38 又被查一遍）。 |
| 51 | delete | `if (!isFullGitObjectId(mergeCommitId) \|\| !isFullGitObjectId(automaticMergeTreeId) \|\| mergeCommitId.length !== automaticMergeTreeId.length) throw n` | 两个入参都来自已校验来源（mergeCommitId 由 merger-contracts.ts:69 校验，automaticMergeTreeId 来自 activation 已查两遍），这是同一契约的第四份手写 validator。 |

### `src/merger-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 14 | shrink | `const mergerCandidateTransportSchema = Type.Object({}, { additionalProperties: true, description: "Arguments must have exactly one of the following co` | 违反 ADR 0023 与锚定宪法：工具真正注册的是空 schema，shape 靠自由文本 description + examples 传达，第二合同藏在 validateMergerOutput 里；应改为直接表达 completed\|escalate 两叶的 typed union（不带 additionalProperties:false，且删掉「with no extra keys」措辞）。 |
| 38 | delete | `!isFullGitObjectId(state.automaticMergeTreeId) \|\| state.automaticMergeTreeId.length !== input.targetObjectId.length` | 该值由 merger-git-state.ts:46-47 现场产出并已校验，这里是对内部对象的第二次格式复核（ADR 0043 明令不做），位宽相等更是纯格式自洽。 |

### `src/navigator-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 38 | keep | `validateRecordedNavigatorReceiptV1(value);const r=record(value,["version","status","runId","subject","snapshotDigest","positionCursor","invocationId",` | [#58 不改，defer→#28] 同一契约存在四份 shape 真源：published schema(navigator-receipt-v1.schema.json，作 tool parameters)＋手写 validateRecordedNavigatorReceiptV1＋本函数的 record()/validatePrimaryShape＋test/schema-contract-parity.test.ts 的 parity 测试；应收成一个边界真源，runtime 只留跨字段绑定。 |
| 38 | keep | `if(Object.keys(reads).some(id=>!id\|\|typeof reads[id]!=="boolean")\|\|actualById.size!==actualReads.length\|\|actualReads.some(x=>typeof x.evidenceId` | [#58 不改，defer→#28] actualReads 由本包 NavigatorEvidenceStore.readRecord() 现场产出，结构与去重按构造已成立；对自家产物再写一遍 validator 是第二份平行校验。 |
| 38 | keep | `if(receipt.primary.kind==="return_scope_or_authority_defect"&&(!cited.includes(receipt.primary.defect.evidenceId)\|\|!actualById.has(receipt.primary.d` | [#58 不改，defer→#28] 与 src/package-contracts/navigator-output.ts:14 的 `reads.get(String(d.evidenceId))!==true` 是同一条规则的第二份实现（同一次调用里已先跑过），重复。 |
| 41 | needs-adjudication | `export const currentPositionSnapshotV1Schema={type:"object",additionalProperties:false,required:["version","runId","subject","children","positionCurso` | 全仓零 consumer（src/test/bin/scripts/extensions/docs/souls 全域 grep 只命中定义行本身）的第四份平行 schema，且带 additionalProperties:false；死导出删除是否算「#58 修改 Navigator」需裁决。 |

### `src/package-contracts/collector-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 86 | shrink | `export type CollectorReceipt = { host: "github.com"; repository: string; prNumber: number; manifestVersion: 1; manifestDigest: string; ... }` | Full second definition of the receipt shape — CollectorReceipt/CollectorReport/ReviewDerivedReport/TerminalFactReport/CollectorLegStatus are also defined in src/collector-receipt.ts:28-90, CollectorSnapshot/CollectorEvidenceRecord in collector-evidence.ts:36-83; one owner must survive (DRY). |
| 104 | delete | `/** Generated tool-call args (legs only) — not a terminal accepted receipt. */ export type CollectorGeneratedOutput = { legs: Array<{ legId: string; s` | Dead export with zero consumers repo-wide, duplicating the typebox-derived CollectorOutputArgs from collector-tool-schemas.ts — a second hand-written definition of the same legs contract. |
| 153 | delete | `function validatePageDiagnostics(value, label): CollectorPageDiagnostics { ... assertClosedKeys(value, ["path","page","status","itemCount"], ["linkHea` | Whole function mirrors internal pagination telemetry (GitHubPageDiagnostics in collector-evidence.ts:81) that no receipt consumer reads; a shape validator for data whose only reader is the producer. |
| 280 | shrink | `function validateAttempt(value, index): CollectorRequestAttempt { assertClosedKeys(value, ["attemptId","legId","observedHead","snapshotId","marker","b` | Full mirror of CollectorRequestAttempt (owned by collector-ledger.ts) inside the receipt validator; requestAttempts is pure audit trail with no downstream reader — keep at most 'is an array', drop the per-field shape law. |
| 300 | delete | `const statuses = ["started","succeeded","rejected","ambiguous_loss","recovered"] as const; if (!statuses.includes(value.status as (typeof statuses)[nu` | Not K1 — no receipt consumer branches on attempt status; the started/succeeded/rejected/ambiguous_loss/recovered ladder is the ledger's internal state machine, re-asserted here as a second shape law. |
| 350 | shrink | `function validateSnapshot(value, index): CollectorSnapshot { assertClosedKeys(value, ["snapshotId","observedAt","completedAt","completedMono","host","` | Deep per-snapshot re-validation of our own emitted telemetry (completedMono monotonic clock, prState, complete, pageDiagnostics); shrink to the snapshotId/headOid binding the receipt actually references, drop the rest. |
| 449 | delete | `if (Object.hasOwn(value, "legs") && !Object.hasOwn(value, "host") && !Object.hasOwn(value, "reports")) { fail("Collector generated legs-only output is` | Strictly redundant — assertClosedKeys at line 458 already fails legs-only input on missing key `host`; and the only path that ever fed tool arguments here was validateAcceptedLifecycle, reached solely from src/assisted-invocation-transport.ts, which D6 deletes. |
| 525 | delete | `if (value.reports.some((item) => item === null \|\| typeof item !== "object" \|\| Array.isArray(item))) { fail("Collector receipt reports contain inva` | Second shape pass over all five child collections (lines 525-551) duplicating the `if (!isRecord(value)) fail(...)` guard that opens validateReport/validateLeg/validateSnapshot/validateEvidence/validateAttempt. |

### `src/package-contracts/fixer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 27 | shrink | `export const fixerOutputSchema = Type.Union([...]);  // + validateFixerOutput (L57) + validateAcceptedWorkerDetails->validateFixerOutput (worker-outpu` | One boundary carries a TypeBox tool schema and a full hand-written shape validator, and the accepted-details path re-runs the same validator on an already-accepted receipt; ADR 0023/0042/0043 want one shape owner plus runtime cross-field semantics only. |

### `src/package-contracts/navigator-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 15 | keep | `export function validateRecordedNavigatorReceiptV1(value){const r=rec(value,["version","status","runId","subject","snapshotDigest","positionCursor","i` | [#58 不改，defer→#28] 整份手写 shape validator 与 published schema 一一对应；其唯一真实外部 consumer 是 terminating-tools.ts:190 的 `{status: details.status}`（K6：只取消费方必需字段即可），不需要镜像完整 schema。 |

### `src/package-contracts/reviewer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 74 | delete | `if (hasBatch !== Object.hasOwn(output.identities, "construction") \|\| hasBatch !== Object.hasOwn(output.identities, "target") \|\| (hasBatch && (!isR` | 对 assembleRuntimeReviewerReceipt 刚组装的内部对象做第二次 shape 复核；ADR 0043 明令不对 runtime 生成的内部对象再做格式复核，真正的 target 绑定在 dispatch 的 target-drift 检查。 |
| 90 | delete | `!exactKeys(construction, ["recipe", "bundle"]) \|\| construction.recipe !== "reviewer-common-bundle-v1" \|\| !verifyBundleIdentity(construction.bundle` | verifyBundleIdentity 对 runtime 自己编译的 bundle 逐条重算 UTF-8 round-trip、长度、摘要与 manifest（D3），其余是 construction/target 的精确键集合；ADR 0037 要保留的冻结 target 绑定由 reviewer-dispatch.ts:35 的 target-drift 实时检查承担，不是这份回执格式回声。 |
| 100 | delete | `if (outcome === undefined) { if (report !== undefined) throw new Error("Reviewer report lacks outcome"); continue; }` | reports/outcomes 由 settlement 在同一循环里成对写入，此处是对自家产物的跨字段回声校验（ADR 0043）。 |
| 127 | delete | `if (output.status === "completed" && (!hasBatch \|\| Object.values(output.outcomes).some((item) => item.status !== "successful"))) throw new Error("Co` | 同一法条已由 reviewer-execution-ledger.ts:215-221 在交卷路径上执行（recordForAudit("completed") 要求每条腿 successful），这里是事后读取方的第二份实现，且并不能阻止回执被写出。 |
| 133 | delete | `export function projectReviewerIntentToReceipt(intentValue: unknown, receiptValue: unknown): RuntimeReviewerReceiptV2 { ... if (receipt.status !== int` | 生产侧无 consumer：唯一调用方是 test/reviewer-package-lifecycle.test.ts:213 与随 D6 整删的 assisted 传输层；平行的 intent↔receipt 一致性壳应随之删除。 |

### `src/package-contracts/terminating-tools.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 160 | delete | `export function validateAcceptedLifecycle(toolName, argumentsValue, detailsValue) { const details = validateAcceptedDetails(toolName, detailsValue); .` | Validates the same payload twice and then demands byte-for-byte parity between two views of one recorded call; its only production consumer is src/assisted-invocation-transport.ts, which ADR 0020 deletes, and ADR 0043 forbids re-checking runtime-internal objects. |
| 209 | delete | `export function deepEqual(a: unknown, b: unknown): boolean { ... if (aKeys.length !== bKeys.length) return false; ... }` | Exported exact-key structural comparator used only by validateAcceptedLifecycle (grep: no other src consumer); it dies with the parity check. |

### `src/reviewer-agent.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 27 | delete | `if (dispatch.recipe !== "reviewer-common-bundle-v1" \|\| dispatch.legs.length < 1 \|\| dispatch.legs.length > 2 \|\| dispatch.legs[0]?.axis !== "stand` | recipe 字符串与 axes 顺序/基数在 ledger(159)、这里、以及 package-contracts/reviewer-output.ts 三处各写一份同构 validator；边界真源应收成一处。 |

### `src/reviewer-construction.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 87 | delete | `const build=(x,pass)=>compile(`${common}\nGrant: ${JSON.stringify(x.grant)}\n...`); const first=axes.map(x=>build(x,1)),second=axes.map(x=>build(x,2))` | 同一 prompt 编译两遍再互比，是包内自造的 parity 检查；compilePrompt 注入点全仓只有测试传入（src 侧无生产调用方），即这套机制唯一服务的是它自己的负向测试。 |

### `src/reviewer-pinned-git.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 52 | delete | `readRange!.diffSha256===sha256Hex("")` | 用「空内容的摘要」旁敲侧击地复核 diff 非空，而生产该 range 的同一文件 line 151 已直接拒绝 diff.length === 0；同一条法在两层各写一遍。 |
| 52 | delete | `!Array.isArray(readRange!.commits)\|\|!readRange!.commits.every(x=>typeof x==="string")` | 对 TypeScript 已声明为 readonly string[] 的包内返回值做运行时形状复检，是第二份手写 shape validator，没有外部不可信来源。 |

### `src/reviewer-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 31 | delete | `tools: Type.Array(StringEnum(REVIEWER_CHILD_TOOLS), { uniqueItems: true }), prerequisiteOperations: Type.Array(StringEnum(REVIEWER_PREREQUISITES), { u` | 与 reviewer-admission.ts:31 的 request() 逐条同构（已知值、唯一性、天花板）；边界真源应收在 admission，schema 只做 transport 描述。uniqueItems 另按 ADR 0039 删（grant 集合重复无歧义）。 |
| 34 | shrink | `const materialSchema = Type.Object({ id: Type.String({ minLength: 1 }), repositoryPath: Type.String({ minLength: 1 }) }, { additionalProperties: true ` | 与 admission L43 的同一批必需性校验重复；repositoryPath 非空是 admission 拥有的必需字段。 |
| 39 | delete | `relevanceHints: Type.Optional(Type.Object({ standards: Type.Optional(Type.Array(Type.String(), { uniqueItems: true })), spec: ... }))` | relevanceHints 只是提示列表，不是映射键或引用目标；唯一性按 ADR 0039 删，且 admission L50 已有同构副本。 |
| 123 | delete | `if (!capabilities.prerequisiteOperations.includes("preflight.git.pin-target")) { throw new Error("Missing preflight prerequisite: preflight.git.pin-ta` | reviewer-admission.ts:51 已对全部 preflight.* 前置（含 pin-target）做同一天花板检查，此处是第二份同构护栏。 |

### `src/reviewer-workspace.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 43 | delete | `for (const entry of Object.values(snapshot.refs)) { await git(cwd, ["cat-file", "-e", `${entry.objectId}^{object}`], signal); if (entry.peeledCommitId` | 逐 ref 复核 git 自己刚 fetch 完成的对象是否存在，是对自生成克隆的二次精确校验（ADR 0042），且与 mirror 侧 line 62-64 是同一形状的第二份；git fetch 失败本就会响。 |
| 62 | shrink | `if (!sameReviewerRefs(await readRefs(mirrorPath, signal), refs)) throw new Error("Bare review mirror ref map changed while the snapshot was prepared")` | mirror 是本进程刚 clone --mirror 出来的产物；保留 targetHead 在 mirror 中可达这一条即可，全表 ref 比对与逐对象存在性循环是自生成物复检。 |

### `src/worker-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 136 | shrink | `if (roleLabel === "Fixer") return validateFixerOutput(output, phase); const accepted = validateAcceptedWorkerDetails(output, "Coder") as CoderOutput;` | The Coder boundary has coderOutputSchema (tool schema) plus validateAcceptedCoderDetails in worker-output.ts, whose `exact()` helper re-imposes an exact key set; collapse to one shape owner (ADR 0023 pattern). |

### `test/collector-config.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 120 | delete | `test("manifest schema file matches the packaged machine-readable contract") assert.equal(COLLECTOR_LEGS_SCHEMA.additionalProperties,false); assert.dee` | ADR 0022 明令删除 schemas/collector-legs-v1.schema.json、COLLECTOR_LEGS_SCHEMA 镜像与逐字段 parity 测试。grep 证实除本测试与 ADR 外无任何 consumer——测试是唯一消费方的自证循环。 |

### `test/collector-package-lifecycle.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 33 | delete | `assert.ok(paths.includes("schemas/collector-legs-v1.schema.json"));` | ADR 0022 删除该发布 schema 及其打包存在性测试。 |

### `test/collector-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1289 | shrink | `assert.equal(variant!.additionalProperties,false); assert.equal(variants!.length,3); assert.ok(variant!.required?.includes("unavailableScope"))` | 这条测试直接对 TypeBox schema 的内部结构（additionalProperties/required）做断言，是「schema 自证」而非行为；additionalProperties:false 部分随 D1 删，只应保留「注册的 schema 就是工具实际消费的那一份」这一句。 |

### `test/fixer-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 38 | shrink | `assert.equal(Value.Check(fixerOutputSchema, row.output), true, JSON.stringify(row.output)); assert.deepEqual(validateFixerOutput(row.output, row.phase` | 同一契约同时跑 TypeBox schema 与手写 validator＝parity 测试。收成一个边界真源后只留 validator（或只留 schema）一侧。 |

### `test/fixer-prerequisite-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 67 | shrink | `assert.equal(Value.Check(fixerPrerequisitesSchema, JSON.parse(prerequisitesText)), true);` | fixer-packet.ts 同时用 Value.Check 与 parseFailure() 手写复检同一形状；测试再断言二者并存＝平行 validator 的自证。 |
| 111 | shrink | `assert.equal(Value.Check(fixerOutputSchema, candidate), true); assert.deepEqual(validateFixerOutput(candidate, phase), candidate); assert.deepEqual(va` | 同一候选跑三个 validator＝三份形状真源的 parity 断言；只留 packet-aware 那一条语义验证。 |

### `test/judge-posture-recordings.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 261 | needs-adjudication | `function extractAcceptedJudgeOutputs(rows: unknown[]): AcceptedOutput[] { // ~170 行手写 JSONL 生命周期解析器 }` | 自证循环最强证据：该解析器是测试私有代码，却配了 9 条只测它自己的单元测试（L729-836 orphan/missing-isError/conflict/mismatch/out-of-order/replay）。按好测试第④尺（只测 helper/内部结构的测试直接删）应大幅收缩；但录制真伪判定确有价值，需裁决保留哪一条贯穿真实录制的 tracer。 |
| 845 | delete | `assert.equal(accepted.length, 2); // Bundle rule: exactly one distinct accepted id\n  assert.notEqual(accepted.length, 1);` | 紧跟 equal(2) 之后的 notEqual(1) 是恒真断言，零信息量的死断言。 |

### `test/merger-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 84 | delete | `test("Merger registration exposes both exact terminal leaf shapes without narrowing transport", ... assert.deepEqual(parameters.properties, {}); asser` | 这条测试把"工具 schema 故意留空、由第二份手写 validator 当门"钉成契约，正是 ADR 0023 要消灭的形态（非法 shape 应更早被标准工具参数校验拒绝）。整条随之反转/删除。 |

### `test/reviewer-materialization-outcome-contracts.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 25 | delete | `void assertContracts; test("materialization outcome type contracts compile", () => {});` | 空 body 的纯类型自证测试：唯一消费方是它自己，只证明 TS 类型形状，不覆盖任何外部可见行为（规则 13 尺④）。 |

### `test/reviewer-runtime-receipt.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 60 | shrink | `(r:any) => r.outcomes.extra = r.outcomes.spec, ... assert.throws(()=>validateRuntimeReviewerReceipt(value))` | validateRuntimeReviewerReceipt 是 runtime 对自己刚生成对象的二次精确校验（ADR 0042 判删精确 receipt 壳与重复 validator）；未知 key 拒绝一行随 D1 删，「已派工 axis 必须有 outcome/report」的对应性保留。 |

### `test/schema-contract-parity.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 20 | needs-adjudication | `test("Navigator schema and runtime both reject duplicate read identities and non-object-id target lengths",...) beforeTarget:"b".repeat(50)` | 这是 schema+手写 validator 的 parity 自证（D5 删除类），但断言对象是 Navigator（#28 deferral）。需裁决：parity 测试本身随 D5 删，还是因 Navigator 例外整体留。 |
| 21 | delete | `test("packed cold-installed schema exports retain behavioral parity for deep and cross-variant cases",...) execFileSync("npm",["pack",...]) ... Value.` | 整条 npm pack + 冷装消费者只为证明发布 schema 与包内 schema 逐字段一致，无任何真实包外消费者；ADR 0022/0042 的同型裁决即删除这种平行 schema 与 parity 测试。 |

## D6 已判删除机制的专属格式面（45）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 5 | shrink | `## Navigator and Assisted Runner` | ADR 0020 整删 Assisted Runner；本节标题须收成 Navigator 单角色标题。 |
| 9 | delete | `Assisted Runner is a separate package capability. It persistently wraps exactly one caller-selected packaged non-Navigator role, automatically consult` | 整段是已判整删机制的公开能力承诺（ADR 0020），文档与裁决直接相矛盾。 |
| 11 | delete | ````bash\nak-assisted-run enter --config assisted-call-v1.json -- pi --ak-role coder ...\nak-assisted-run status --repository-root "$PWD" --run-id <uui` | 整个 CLI 用法块随 ak-assisted-run 删除；其中 `--run-id <uuidv7>` 还把 UUIDv7 格式写成公开输入契约（ADR 0026）。 |
| 19 | delete | ``enter`/`resume` require canonical UUIDv7 `runId` and `callId`, an exact caller-declared child set, registered workspaces/evidence, and one typed role` | 整段以叙述句编码 Assisted 拒绝法（canonical UUIDv7=D2、exact child set=D1、hash chain 身份=D3），机制已判整删。 |
| 21 | shrink | `Authoritative runtime validation and public types are exported from `src/navigator-contracts.ts`, `src/assisted-contracts.ts`, and `src/assisted-runne` | 三个 assisted 导出面随机制删除，只留 navigator-contracts 引用。 |

### `bin/ak-assisted-run.js`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 2 | delete | `import { main } from "../dist/assisted-cli.js";` | 整文件是 Assisted CLI 的可执行入口，随机制删除（dist/assisted-*.js 六个已被 git 跟踪的产物同删）。 |

### `package.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 8 | delete | `"bin": { "ak-assisted-run": "./bin/ak-assisted-run.js" }` | ADR 0020 删除 ak-assisted-run CLI；bin 入口是它的公开发布面。 |
| 11 | delete | `"files": [ "bin", ...` | bin/ 目录只含 ak-assisted-run.js，机制删除后该 files 条目无对象。 |
| 14 | delete | `"scripts/generate-activation-trace-schema.ts",` | ADR 0019 删除健康 activation 生命周期 trace 及其发布 Schema，生成脚本不再需要发布。 |
| 15 | needs-adjudication | `"scripts/build-assisted.mjs",` | 脚本名与多数 entry 属 Assisted；但其 entries 仍含 navigator-*/uuidv7，删除前须确认 Navigator dist 由谁产出（#28 不改 Navigator 实现，但构建管线归 #58 的包发布面）。 |
| 19 | shrink | `"schemas",` | schemas/ 四份中三份（assisted-call、activation-trace、collector-legs）判删，仅 navigator-receipt（#28 范围例外）剩下；发布清单须相应收敛。 |
| 23 | delete | `"generate:activation-trace-schema": "tsx scripts/generate-activation-trace-schema.ts",` | ADR 0019 删除 activation trace 发布 Schema 后该 script 无产物对象。 |
| 24 | shrink | `"build": "npm run generate:activation-trace-schema && tsc -p tsconfig.build.json && node scripts/build-assisted.mjs",` | build 链前后两段分别绑 activation trace Schema 与 Assisted 构建；须随两处机制删除收敛（注意 tsconfig.build.json 只 include src/package-contracts，navigator dist 目前仅由 build-assisted 产出）。 |
| 44 | needs-adjudication | `"esbuild": "^0.28.1",` | 仓内唯一 esbuild 消费者是 scripts/build-assisted.mjs；若该脚本随 Assisted 删净则此依赖同删，若保留 navigator 构建则留。 |

### `schemas/activation-trace.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `{"anyOf":[{"required":["role","stageId","status","timestamp"],"properties":{"status":{"anyOf":[{"const":"started"},{"const":"completed"}]}...` | ADR 0019 删除健康路径 stage/started/completed trace、Schema 与 writer；只留 fail-closed barrier 与失败 cause 的 stderr 证据。文件同含 additionalProperties:false 与 stageId 拼写正则。 |

### `schemas/assisted-call-v1.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `{ "$id": "https://ak.local/schemas/assisted-call-v1.schema.json", "title": "AssistedCallConfigV1", "additionalProperties": false, "required": ["versio` | 整份发布 Schema 随 ADR 0020 删除；文件内另含 19 处 additionalProperties:false（D1）、`version const 1`（D3/0044）、uuidv7 pattern（D2/0026），均随之消失。 |

### `scripts/build-assisted.mjs`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 4 | shrink | `const entries = ["navigator-auditor","navigator-contracts","navigator-evidence","navigator-role","uuidv7","assisted-contracts","assisted-ledger","assi` | 六个 assisted-* entry 随 ADR 0020 删除；navigator-*/uuidv7 entry 仍是 Navigator dist 的唯一产出路径，脚本须改名/收窄而非整删（uuidv7 是否仍有非 Navigator 消费者需 src 区确认）。 |

### `scripts/generate-activation-trace-schema.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `import { activationTraceRecordSchema } from "../src/activation-trace.ts"; await writeFile(new URL("../schemas/activation-trace.schema.json", import.me` | 整文件只为生成已判删的 activation trace 发布 Schema（ADR 0019），随 src/activation-trace.ts 与 package.json script 一并删除。 |

### `src/activation-trace.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 9 | shrink | `export const activationTraceRecordSchema = Type.Union([Type.Object({ role, stageId: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }), status: Union(Liter` | ADR 0019 deletes the healthy-path lifecycle trace and its schema; the started/completed leaf, stageId pattern (D2), date-time format (D2) and additionalProperties:false (D1) all go, leaving only failure cause evidence. |
| 9 | shrink | `export const activationTraceRecordSchema = Type.Union([...]) // + schemas/activation-trace.schema.json + scripts/generate-activation-trace-schema.ts` | ADR 0019 删除发布 Schema 与健康轨迹格式校验；只剩 failed cause 记录时无需 union schema、生成脚本与 schemas/activation-trace.schema.json 三处平行真源。 |

### `src/package-contracts/terminating-tools.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 149 | delete | `// Snapshot freshness is additionally checked by Assisted Runner.` | Stale comment asserting a check performed by the Assisted Runner that ADR 0020 deletes; leaving it claims a guarantee nothing provides. |

### `src/role-runtime.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 107 | delete | `export * from "./assisted-contracts.ts"; export * from "./assisted-acquisition.ts"; export * from "./assisted-ledger.ts"; export * from "./assisted-ru` | Public re-export surface of the Assisted Runner, deleted wholesale by ADR 0020 including its contracts, ledger and published schema. |
| 161 | delete | `function validateActivationTraceRecord(record: unknown): ActivationTraceRecord { if (!Value.Check(activationTraceRecordSchema, record)) { throw new Ty` | Format re-check of an object the runtime just built one line earlier, against a closed schema; ADR 0019 deletes the healthy-path trace, its published schema and its format validation, and ADR 0043 forbids re-validating self-generated objects. |
| 175 | shrink | `await emitActivationTrace(infrastructure.writeTrace, { role, stageId: stage.id, status: "started", timestamp: infrastructure.clock() }); ... status: "` | ADR 0019 keeps only the fail-closed barrier and the cause-bearing failure evidence; started/completed emission (and the clock/writer dependency surface at L289-290) has no consumer beyond its own tests. |

### `test/activation-envelope-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 24 | delete | `test("registration enrolls every role in stable named activation stages", () => { assert.equal(ROLE_REGISTRY.length, 8); ... Value.Check(activationTra` | ADR 0019 删除健康路径 stage 与 started/completed 轨迹及其发布 Schema。每个角色实际只有一个 stage（role-runtime.ts:142-151），stage 抽象本身无消费者。 |
| 36 | needs-adjudication | `test("every registered healthy production ignition leaves structured start and completion traces", ... assert.deepEqual(traces.map(...), entry.stages.` | 轨迹断言随 ADR 0019 删除；但这条同时是唯一一处"全部 8 个角色在真实依赖装配下都能干净激活"的冒烟覆盖。删轨迹可以，需明确这份激活冒烟由谁接住，否则是覆盖净损失。 |
| 92 | delete | `test("the shared executor runs every declared stage in order", ... assert.deepEqual(calls, ["first:started", "first", "first:completed", ...])` | 只测 executeActivationStages 的 started/completed 生命周期编排，机制删除后无被测对象。 |
| 241 | delete | `for (const failure of ["clock", "writer"] as const) test(`${failure} failure terminates before activation instead of degrading silently`, ...)` | clock 与 trace writer 都是生命周期轨迹的基础设施；健康路径轨迹删除后这两个失败面不再存在。 |
| 256 | delete | `test("completed trace emission failure still terminates the invocation", ... writeTrace: () => { if (++writes === 2) throw traceError; }` | 被测对象是 completed 轨迹的写入失败，随健康路径轨迹整删。 |
| 285 | shrink | `test("default trace writer retries transient and short writes until one complete JSONL record", ... { role: "judge", stageId: "load", status: "started` | 失败 cause 仍要落 stderr，所以重试/短写逻辑可留；但夹具用的是 started 记录且断言 activationTraceRecordSchema，须改写为 failed 记录并去掉发布 Schema 依赖。 |
| 304 | delete | `await assert.rejects(() => executeActivationStages("judge", [...], { clock: () => "invalid", ... }), /closed contract/); assert.deepEqual(traces, []);` | 对 runtime 自己刚生成的轨迹对象再做 schema 复检（含 timestamp 格式），既是 D6 也是 ADR 0042 禁止的"runtime 二次精确校验"。 |

### `test/assisted-acquisition.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `import ... from"../src/assisted-acquisition.ts"; import ... from"../src/assisted-contracts.ts"` | acquisition wrapper 是 Assisted 专属实现，ADR 0020 明确列入删除面。 |

### `test/assisted-evidence-input-closure.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 7 | needs-adjudication | `test("Navigator owns immutable admitted bytes and exposes no unadmitted handle",...) assert.throws(()=>store.read(path),/not admitted/)` | 文件走 Assisted acquisition 入口（删），但同一条断言线覆盖的是 NavigatorEvidenceStore「只读已准入字节、拒绝未准入 handle」这一保留行为；随文件删会让该 Navigator 行为失去覆盖。 |

### `test/assisted-lifecycle.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `import{enterAssistedCallV1,readAssistedRunV1,type AssistedRunnerDependenciesV1}from"../src/assisted-runner.ts"` | Assisted Runner 旅程生命周期专属测试，随 ADR 0020 整删。 |

### `test/assisted-native-session-evidence.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `import{createAssistedInvocationTransportV1}from"../src/assisted-invocation-transport.ts";import{acquireCurrentPositionV1}from"../src/assisted-acquisit` | Assisted native-session transport 专属；它顺带调用 Navigator receipt 校验，但 Navigator 自身覆盖由 navigator-contracts.test.ts 承担。 |

### `test/assisted-native-session-lifecycle.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 9 | needs-adjudication | `import { validateAcceptedLifecycle } from "../src/package-contracts/terminating-tools.ts";` | 文件本体是 Assisted transport（删），但它是唯一从 native session 侧压 validateAcceptedLifecycle（sole-final，ADR 0041 保留）的场景；删前须确认 terminating-tools.test.ts 覆盖了同样的 orphan/reversed/duplicate 负向案，否则保留类失去覆盖。 |

### `test/assisted-native-session-recovery.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `import{...}from"../src/assisted-invocation-transport.ts";import{...}from"../src/assisted-ledger.ts";import{...}from"../src/assisted-runner.ts"` | Assisted 崩溃恢复专属测试，随机制整删。 |

### `test/assisted-residuals.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `import{endAssistedRunV1,enterAssistedCallV1,resumeAssistedCallV1,recoverAssistedInvocationV1,...}from"../src/assisted-runner.ts"` | 恢复协议/残留物专属测试，随机制整删。 |

### `test/assisted-runner.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `import{validateAssistedCallConfigV1,validateSelectedPiArgvV1}from"../src/assisted-contracts.ts"; import{appendAssistedGenerationV1,...}from"../src/ass` | 整文件只测 Assisted Runner 的 CLI/ledger/配置契约，ADR 0020 判整删该机制及其专属公开面与专属测试。 |

### `test/assisted-settlement-truth.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | delete | `import { acquireCurrentPositionV1 } from "../src/assisted-acquisition.ts"; import { createAssistedInvocationTransportV1 } ...` | Assisted 结算真相专属测试，随机制整删。 |

### `test/judge-posture-recordings.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 454 | shrink | `function assertNoPostureFlags(sessionText, meta) { assert.doesNotMatch(sessionText, /--ak-judge-posture\|ak-judge-posture/); ... }` | 对已删除的 posture/phase flag 做"不得复活"文本扫描；机制早已不存在，属残留守卫，按复杂度成本收掉。 |

### `test/navigator-evidence.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 4 | needs-adjudication | `import {nativeSessionEvidenceReads} from "../src/assisted-invocation-transport.ts"; ... assert.deepEqual(nativeSessionEvidenceReads(rows.join("\n")),e` | 分页一致性断言把 Navigator 的 live 读取记录钉在即将删除的 Assisted transport 重建函数上；Assisted 删除后必须决定是保留纯 live 分页断言，还是整条一起删（会丢 Navigator 分页覆盖）。 |

### `test/package-entrypoint.integration.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 78 | delete | `assert.equal(manifest.bin?.["ak-assisted-run"], "./bin/ak-assisted-run.js");` | Assisted CLI 随 ADR 0020 整删，打包断言随之删除；:112-114 的 src/assisted-runner.ts、schemas/assisted-call-v1.schema.json、bin/ak-assisted-run.js 三条同理。 |

### `test/pi-test-harness.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 170 | delete | `assert.ok(paths.includes("bin/ak-assisted-run.js"));` | 断言打包产物必须包含 Assisted Runner CLI；ADR 0020 整删该机制，此行会直接把删除挡回去。 |

### `test/schema-contract-parity.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 18 | delete | `parity(assistedCallConfigV1Schema,value,()=>validateAssistedCallConfigV1(value),true)` | assistedCallConfigV1Schema 只有本测试一个 consumer（grep：src/assisted-contracts.ts 定义 + 本测试），是典型自证循环；且随 Assisted 整删。 |

## K7 Collector 运营批次法 / sole-final（32）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 221 | keep | `Failure channels (non-zero, no receipt) include ... later-input/output-singleton violations.` | sole-final 交卷按 ADR 0041 保留；但同段/同机制里的 operational singleton batch、sibling poison 分级须由 src 区删除，README 措辞勿再暗示 batch 法。 |

### `src/collector-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 221 | delete | `export function classifyRawToolCall(part: CollectorRawToolCallPart): ClassifiedCall { if (part.type !== "toolCall") ... if (!nonEmptyString(part.id) \` | ADR 0041 明令删除整条 assistant 消息扫描与 malformed/illegal 分级；malformed toolCall 不该由 Collector 自建一套 raw part 解析法。 |
| 272 | delete | `if (calls.length === 0) { return { allow: false, reason: "Collector batch contains no toolCall parts" }; }` | 空 batch 拒绝属于 operational batch law；调用点 collector-role.ts:265 已经在 calls.length === 0 时直接 return，这条永远打不到真实分支。 |
| 280 | delete | `for (const item of classified) { if (item.kind === "malformed") { return { allow: false, reason: `Collector batch poisoned by malformed toolCall: ...`` | sibling poison：ADR 0041 明令不再因同 batch 出现 malformed / 非 Collector sibling / schema-invalid 兄弟而判死整次 invocation。 |
| 304 | delete | `if (operational.length === 1 && outputs.length === 0 && classified.length === 1) { const only = operational[0]!; return { allow: true, permitted: { ki` | operational singleton batch law，ADR 0041 已判删；observe/request/wait 的并发冲突由各执行点（activeOperationalCallId 之外的真实状态机）处理。 |
| 316 | shrink | `if (outputs.length === 1 && operational.length === 0 && classified.length === 1) { if (options.outputAccepted) { return { allow: false, reason: "Colle` | 只保留 sole-final：output 必须是该消息唯一 tool call。outputAccepted 重复项已由 markOutputAccepted (L638) 单点拥有，此处删除。 |
| 323 | delete | `if (!options.hasCompletedOperationalOrSnapshot) { return { allow: false, reason: "Collector output requires a prior completed operational result in th` | operational 排序法，且与 buildCollectorReceipt 的 latestCompleteSnapshotId 必需检查（collector-receipt.ts:444）重复——真正需要的是最终快照存在，不是「有过一次 operational」。 |
| 341 | delete | `return { allow: false, reason: "Collector permits exactly one schema-valid operational call (observe\|request\|wait) per assistant batch, or a sole la` | batch law 的兜底拒绝条文，随 ADR 0041 整删；sole-final 条文另行保留。 |
| 571 | delete | `const decision = classifyCollectorBatch(calls, { outputAccepted, hasCompletedOperationalOrSnapshot: ... }); if (!decision.allow) { latchFatal(decision` | ADR 0041 特别点名「由此锁死 invocation 的 fatal 状态」删除；evaluateBatch 只应剩 sole-final 判定，不再 latchFatal 整次工作。 |
| 587 | delete | `if (permittedBatch === undefined) { throw latchFatal("Collector rejected tool execution without a permitted assistant batch"); }` | batch 许可表的执行侧闸；batch law 删除后 operational 调用不再需要 message_end 预许可。 |
| 591 | keep | `if (outputAccepted && toolName !== COLLECTOR_OUTPUT_TOOL) { throw latchFatal("Collector output already accepted; no further operations"); }` | sole-final 的执行侧含义：交卷被接受后不得继续行动，正是 ADR 0041 保留的「已完成但仍在行动」歧义防线。 |
| 598 | delete | `if (activeOperationalCallId !== undefined && activeOperationalCallId !== toolCallId) { throw latchFatal("Collector operational call already active"); ` | operational 并发单例法，随 batch law 删除；真实并发冲突（同一 snapshot 重复 request 等）已由 attemptKeys / marker 去重在执行点接住。 |
| 602 | delete | `if (toolName === COLLECTOR_OUTPUT_TOOL) { if (permittedBatch.kind !== "output" \|\| permittedBatch.callId !== toolCallId) { throw latchFatal("Collecto` | permittedBatch 身份比对是 batch law 的记账壳；sole-final 保留后只需知道「output 已接受」，不需要 callId 对表。 |
| 617 | delete | `if (permittedBatch.kind !== "operational" \|\| permittedBatch.callId !== toolCallId \|\| permittedBatch.name !== toolName) { throw latchFatal("Collect` | 同上，operational batch 许可对表随 ADR 0041 整删。 |
| 638 | keep | `if (outputAccepted) throw latchFatal("Collector output is singleton");` | 每个角色只有一个被接受的最终回执（sole-final），ADR 0041 明确保留；这是该法的单一权威落点。 |

### `src/collector-receipt.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 440 | keep | `if (ledger.outputAccepted) fail("Collector output is singleton");` | sole-final 保留项（ADR 0041）；与 ledger.markOutputAccepted 同法，裁决时确认只留一处权威落点。 |

### `src/collector-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 87 | delete | `/** Pass every raw toolCall part, including malformed id/name/arguments. */ function rawToolCallPartsFromMessage(message: { role?: string; content?: u` | Whole-assistant-message tool-call scanning exists only to feed the operational batch law that ADR 0041 deletes. |
| 264 | delete | `const calls = rawToolCallPartsFromMessage(event.message); ... const decision = activation.ledger.evaluateBatch(calls); if (!decision.allow) { console.` | ADR 0041 removes the singleton-batch/sibling-poison law: a second or malformed sibling call in one message must no longer kill the invocation, while sole-final submission stays enforced at the output seam. |

### `src/doctor-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 9 | keep | `const calls = leaf.message.content.filter((part) => part.type === "toolCall"); if (calls.length !== 1 \|\| calls[0]?.id !== toolCallId \|\| calls[0]?.` | sole-final：每个角色只有一个被接受的最终回执，K7 明确保留（运营批次法才删）。 |

### `src/judge-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 127 | keep | `function requireSingletonSubmissionCall(toolCallId, ctx) { ... throw new Error("Judge output must be the sole final tool call"); }` | Sole-final submission retained by ADR 0041; duplicate of the worker-role copy, collapse to one helper. |

### `src/merger-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 24 | keep | `function singleton(id, ctx) { const leaf = ctx.sessionManager.getLeafEntry(); ... if (calls.length !== 1 \|\| calls[0]?.id !== id \|\| ...) throw new ` | ADR 0041：所有角色终止回执继续要求 sole final tool call；被删的是 Collector 的 operational batch law，不是这条。 |

### `src/navigator-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 30 | keep | `function singleton(toolCallId,ctx){const leaf=ctx.sessionManager.getLeafEntry();if(leaf?.type!=="message"\|\|leaf.message.role!=="assistant")throw new` | sole-final（每个角色只有一个被接受的最终回执）是 K7 明确保留项，不属被删的运营批次法。 |

### `src/reviewer-execution-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 158 | keep | `if (accepted !== undefined) throw new Error("Projection permits exactly one accepted dispatch");` | 每个角色只有一次被接受的最终派工（sole-final 保留项）；重复接受会让同一次工作出两份权威结论。 |
| 220 | keep | `if (expected.some(axis => results[axis]?.status !== "successful") \|\| Object.keys(results).length !== expected.length) throw new Error("Reviewer comp` | 每条被接受的 leg 必须有终态、completed 必须全部成功，是终止法（不是运营批次法），删了会让流程安静半途结束。 |

### `src/reviewer-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 62 | keep | `function requireSoleReviewerOutputCall(id, ctx) { ... if (calls.length !== 1 \|\| calls[0]?.id !== id \|\| calls[0]?.name !== REVIEWER_OUTPUT_TOOL_NAM` | ADR 0041 明确保留所有角色终止回执的 sole-final 交卷法；被删的是 Collector 的运营 batch 分级，不是这条。 |

### `src/worker-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 147 | keep | `function requireSingletonSubmissionCall(toolCallId, expectedToolName, roleLabel, ctx) { ... throw new Error(`${roleLabel} output must be the sole fina` | Sole-final submission survives ADR 0041; separately note six byte-similar copies exist (worker-role, judge-role, reviewer-role, doctor-role, navigator-role, merger-role) and should collapse to one shared helper per DRY. |

### `test/collector-ledger.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 117 | shrink | `test("batch gate permits one operational or sole output and latches mixed/multiple") ledger.evaluateBatch([observe, request]).allow === false; ledger.` | ADR 0041 删除 operational singleton batch law 与由此锁死的 fatal；只保留「终止回执必须是 sole final tool call」。本测试须收缩到 output+sibling 一条。 |
| 174 | delete | `test("classifier rejects unknown, malformed, and schema-invalid without role") classifyCollectorBatch([...observe, unknown_tool]).allow === false` | 整条 assistant 消息扫描 + sibling poison 分级正是 ADR 0041 判删的运营批次法。 |
| 213 | delete | `test("beginOperational requires exact permitted batch match") assert.throws(()=>ledger.beginOperational(COLLECTOR_OBSERVE_TOOL,"wrong-id"),/permitted\` | permitted-batch 精确匹配是运营批次法的执行侧，随 ADR 0041 删除；observe/request/wait 的真实参数与并发冲突由各执行点自处理。 |
| 731 | delete | `test("evaluateBatch two-valid and invalid permutations latch fatal before execute") assert.equal(ledger.fatal,true,names.join("+"))` | 整张双调用排列矩阵只测运营批次法与 fatal 锁死，随 ADR 0041 删除。 |

### `test/collector-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 736 | shrink | `test("collector rejects parallel operational siblings and mixed output batches") assert.equal(process.exitCode,1)` | parallel operational siblings 部分随 ADR 0041 删；mixed 批次里「output 必须是 sole final」的部分保留。同型另一实例见 :855 batch provenance matrix（整条属运营批次法，删）。 |

### `test/package-entrypoint.integration.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 747 | keep | `assert.equal(mixed.message.isError,true); assert.match(textOf(mixed.message),/sole final tool call/);` | sole-final 是 ADR 0041 明确保留的闸类契约，负向案不可删；仅错误文案的正则依赖属盯文，建议改断 typed 结果。 |

## K1 执行判别项（33）

### `src/activation-trace.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 28 | keep | `export function namedActivationCause(error: unknown): { identity: string; name: string; message: string } { ... return { identity: typeof code === "st` | ADR 0019 keeps the cause-bearing failure evidence; this names the real cause instead of laundering it, satisfying the failure-honesty constitution. |

### `src/collector-evidence.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 19 | keep | `export const VALID_REVIEW_STATES = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED"] as const; ... export function isValidReviewState(state: string): sta` | Selects a real branch: a PENDING or DISMISSED review must not qualify a leg as valid, so this enum drives execution, not presentation. |

### `src/collector-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 870 | keep | `if (leg.requestBody === undefined) { throw new Error(`Collector leg \"${input.legId}\" is observe-only and cannot request`); }` | observe-only 与 request-capable 是真实执行分支判别；没有 body 这条命令根本不可执行。 |

### `src/collector-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 183 | keep | `if (inputCount >= 1) { activation.ledger.latchFatal("Collector is one-shot and rejects later inputs"); ... return { action: "handled" as const }; }` | One-shot invocation is a mechanical runtime invariant the role's evidence window depends on, and it is enforced where CLAUDE.md says such invariants belong. |
| 206 | keep | `if (options.skills && options.skills.length > 0) { hostActions.failInfrastructure(activation.ledger.latchFatal("Collector detected ambient skills in s` | Typed fail-closed barrier on the prompt surface (kept by ADR 0019) that compares against constants the package itself owns, so it bites a contract rather than free text. |
| 286 | keep | `if (!(COLLECTOR_REQUIRED_TOOLS as readonly string[]).includes(event.toolName)) { return { block: true, reason: `Collector forbids tool ${event.toolNam` | Typed allowlist over the package's own tool constants that blocks a real execution path; unrelated to input format law. |
| 480 | keep | `if (ctx.mode !== "print" && ctx.mode !== "json") { throw new Error(`Collector supports only print or json mode (got ${ctx.mode})`); }` | Real execution precondition for a one-shot non-interactive role; ADR 0019 keeps the activation barrier that fails closed with a real cause. |
| 485 | keep | `if (event.reason === "resume" \|\| event.reason === "fork" \|\| event.reason === "reload") { throw new Error(`Collector does not support session_start` | Resume/fork would replay an invocation whose ledger and activation clock are already spent; genuine execution discriminator on the activation barrier. |

### `src/collector-tool-schemas.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 48 | keep | `unavailableScope: Type.Union([Type.Literal("target"), Type.Literal("global")])` | Real execution discriminator: src/collector-receipt.ts:321 branches on scope === "global" when qualifying unavailable evidence, so a wrong value would accept the wrong proof. |

### `src/merger-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 71 | keep | `throw new Error("Merger output violates the exact completed\|escalate contract");` | completed\|escalate 是 runtime 真实选择执行分支的判别值（L52 决定是否核验 Git 完成态），ADR 0040 保留；文案里的「exact」随 D1 删除一并改写。 |

### `src/merger-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 34 | keep | `if (typeof path !== "string" \|\| path.trim().length === 0) throw new Error("Merger requires --ak-merger-input");` | 没有输入文件命令无法执行，属参数真正可执行的最小条件。 |

### `src/navigator-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 29 | keep | `function query(v,w){const r=record(v,["transport","operation"],w);if(r.transport!=="github_graphql"&&r.transport!=="github_rest")fail(w);…}` | [#58 不改，defer→#28] transport 枚举不选择任何真实执行分支（全仓无 consumer 读它，只是 provenance 展示数据），不满足 K1；#28 处置应删枚举、留必需非空。 |
| 30 | keep | `function obsFields(r,w){if(r.state!=="open"&&r.state!=="closed")fail(w);…}` | [#58 不改，defer→#28] issue state 枚举没有 reader 分支（parentObservation/children 只作为 JSON 喂给模型），是 enum-for-enum，不满足 K1。 |
| 31 | keep | `…\|\|!(PACKAGED_ROLES as readonly unknown[]).includes(a.role)\|\|a.role==="navigator"\|\|((a.role==="coder"\|\|a.role==="fixer")?(a.phase!=="plan"&&a.` | [#58 不改，defer→#28] latestAttempt 是「已结算的历史尝试」的转述数据，其 role/phase 条件形状与 terminalClass 六值枚举都不选择 Navigator 的执行分支（grep 确认 terminalClass 在 assisted-* 之外无 consumer），不满足 K1。 |
| 37 | keep | `if(!(PACKAGED_ROLES as readonly string[]).includes(String(p.role))\|\|p.role==="navigator"\|\|((p.role==="coder"\|\|p.role==="fixer")?(p.phase!=="plan` | primary.package_role 的 role+phase 是调用方据以真正派工的判别项（coder/fixer 的 plan\|apply 选择真实执行分支），符合 K1 保留条件。 |
| 37 | keep | `if(!["obtain_evidence","design_authority","review_batch","repository_action"].includes(String(p.actionCategory)))fail("action category") … ["complete"` | [#58 不改，defer→#28] actionCategory / reasonCategory / defect.category 都是给人读的分类词表，没有任何代码分支消费，不因为是 enum 就满足 K1。 |

### `src/package-contracts/collector-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 182 | keep | `if (value.kind === "review") { ... } if (value.kind === "terminal-fact") { ... } fail(`reports[${index}].kind is invalid`);` | review vs terminal-fact selects a genuinely different report branch with different required evidence; a real execution discriminator. |

### `src/package-contracts/fixer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 62 | keep | `if (phase === "apply") fail("status phase constraint: apply forbids planned"); ... if (phase === "plan") fail("status phase constraint: plan permits p` | plan\|apply is the required execution discriminator kept by ADR 0034/0040; the gate is what makes an apply receipt prove work was attempted rather than replayed as a plan. |
| 107 | keep | `if (value.status === "completed" && (refused !== 0 \|\| completed === 0)) fail("status completed disposition combination constraint"); ... partially_c` | status is the discriminator the caller routes on; if it may contradict classResults dispositions the caller mis-routes a partially finished repair as done. Cheaper alternative worth noting: derive status from dispositions and delete the check entirely. |

### `src/reviewer-admission.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 45 | keep | `if(!record(p.spec)\|\|(p.spec.state!=="established"&&p.spec.state!=="not-established")) fail("spec-invalid", ...)` | spec.state 真实选择执行分支：established 才构造第二条 spec 腿（L52），未知值机器无从执行（ADR 0040）。 |

### `src/reviewer-agent.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 30 | delete | `for (const operation of RUNNER_PREREQUISITES) if (!dispatch.prerequisiteOperations.includes(operation)) throw new Error(`Missing accepted runner prere` | prerequisiteOperations 由能力文档/提案声明，runner 无论声明与否都固定做 mirror/workspace/verify 三步——它选不出任何执行分支，只是一份必须与实现同步维护的仪式清单（ADR 0040 只保留真正选分支的判别项）。 |

### `src/reviewer-dispatch.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 35 | keep | `if(accepted\|\|accepting)return close(id); ... accepting=true;accepted=Object.freeze({identity:id,recipe:"reviewer-dispatch-v1",cardinality:dispatch.l` | 单次接受闭合是不可逆子执行的状态机（第二次提议返回 closed 而非按格式拒绝），不属于输入输出格式契约；cardinality 只是记账值，不构成拒绝。 |

### `src/reviewer-pinned-git.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 71 | keep | `if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new Error("Unsupported Git object format");` | objectFormat 真正选择执行分支：oidWidth 40/64 与 workspace 的 git init --object-format 都按它走，未知值无可执行含义。 |

### `src/reviewer-preflight-error.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | keep | `export const REVIEWER_CORRECTABLE_PREFLIGHT_CODES = ["base-invalid", "range-invalid", "material-invalid"] as const;` | 这三个 code 真的选择执行分支（可纠正拒绝 → 让提案方改；其它 → 上抛致命），不是装饰性 enum。删掉上面各 D 类法条后取值集合会自然变窄。 |

### `src/role-runtime.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 225 | keep | `export class ActivationBarrierError extends Error { readonly code = "AK_ACTIVATION_NOT_ADMITTED"; ... }  // + admitted/selectedRole gate at L310-323` | The fail-closed activation barrier is exactly what ADR 0019 preserves: an unadmitted role must not reach the model. |
| 548 | keep | `const entry = ROLE_REGISTRY.find(({ role }) => role === rawRole); if (entry === undefined) { failInfrastructure(new Error(`Unsupported workflow role: ` | Role name selects a real execution branch; an unknown value has no executable meaning. |

### `src/worker-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 138 | keep | `if (phase === "plan" && accepted.status === "completed") { throw new Error("Coder plan phase permits only planned or refused"); }` | Required plan\|apply discriminator (ADR 0034/0040) bound to the receipt status so a plan invocation cannot report construction. |

### `test/collector-receipt.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 103 | keep | `assert.throws(()=>parseCollectorOutputCandidate({legs:[{legId:"codex",status:"refused",...}]}),/failed schema validation/i)` | status 是 consumer 真实分支的判别值（valid\|unavailable\|missing），未知值没有可执行含义（ADR 0040）。 |

### `test/fixer-auditor.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 28 | keep | `assert.deepEqual((decisionTool?.parameters as any).properties.status.enum, ["pass", "revise"]);` | status 是选择"接受 / 打回"真实分支的判别项。 |

### `test/fixer-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 66 | keep | `["plan", { status: "partially_completed", report: "x" }], ["apply", { status: "planned", report: "x" }],` | phase 是真实执行判别项（ADR 0034），planned 不是合法 apply 终态、partially_completed 不是合法 plan 终态。 |

### `test/judge-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 773 | keep | `await assert.rejects(tool.execute("coder-completed", { status: "completed", ... }), /Coder plan phase permits only planned or refused/); ... /Coder ap` | plan\|apply 是 ADR 0034 保留的必需执行判别项，phase 与终态的搭配决定真实分支。 |

### `test/navigator-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 41 | keep | `assert.deepEqual(definitions.map((definition) => definition.name), [NAVIGATOR_EVIDENCE_TOOL_NAME, NAVIGATOR_OUTPUT_TOOL_NAME]);` | 只断言角色工具面与证据读取真实行为，不含格式拒绝法条。 |

### `test/package-entrypoint.integration.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 92 | keep | `assert.deepEqual(FIXER_PHASES, ["plan", "apply"]);` | ADR 0034 保留 Coder/Fixer 的 plan\|apply 必需 phase 输入，是选择真实执行分支的判别值。 |

## K2 按 status 才需要的字段（43）

### `src/collector-config.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 419 | keep | `if (!Array.isArray(authorsRaw) \|\| authorsRaw.length < 1) { fail(`Collector leg \"${id}\" expectedAuthors must be a non-empty array`); }` | With no expected authors no review can ever qualify, so a non-empty author list is the minimal condition for the leg to be executable at all. |
| 443 | keep | `if (body.trim().length === 0) { fail(`Collector leg \"${id}\" request body must be trim-non-empty`); }` | A request-capable leg cannot post a blank comment, so non-blank body is a required-field check, not format law. |
| 516 | keep | `if (!Array.isArray(legsRaw) \|\| legsRaw.length < 1) { fail("Collector manifest legs must be a non-empty array"); }` | Zero legs means nothing to collect and nothing to classify; required-field minimum for the command to run. |

### `src/collector-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 666 | keep | `const hasMissing = candidate.legs.some((leg) => leg.status === "missing"); if (!atOrAfterCutoff && hasMissing) { throw new Error("Collector missing st` | 按 status 才成立的必需条件：missing 这个结论本身需要 cutoff 已到这一现场事实，属状态相关的语义必需项。 |

### `src/collector-receipt.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 713 | keep | `if (reports.length === 0) { fail("Collector receipt reports must be non-empty"); }` | 非空必需内容检查：回执没有任何 report 等于什么都没交。 |

### `src/collector-tool-schemas.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 6 | keep | `const nonBlankString = Type.String({ minLength: 1, pattern: "\\S" });  // rationale: nonBlankString` | Non-blank rationale is a required-field check (explicitly not D2), though minLength:1 is redundant with the \S pattern. |
| 67 | keep | `export const collectorOutputLegSchema = Type.Union([collectorValidLegSchema, collectorUnavailableLegSchema, collectorMissingLegSchema]);` | status valid\|unavailable\|missing selects a real branch (collector-receipt.ts:119 and :574 read unavailableScope only when status is unavailable), so the status-conditional requirement is K1/K2, not decoration — but the three-way object triplication exists only to express one conditional field and should collapse to one schema. |
| 67 | keep | `export const collectorOutputLegSchema = Type.Union([collectorValidLegSchema, collectorUnavailableLegSchema, collectorMissingLegSchema]);` | Status-conditioned requirement (unavailableScope required only on unavailable) is exactly the K2 shape; note the runtime re-checks it at src/collector-receipt.ts:575 whose own comment (line 120) admits schema acceptance already guarantees it — that duplicate belongs to the Collector area. |

### `src/doctor-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 46 | keep | `const nonblank = Type.String({ minLength: 1, pattern: "\\S" });` | 必需字段非空/非空白检查（reason、explanation、recommendation、observation 等），属于「必需字段」类保留项，不是 D2 呈现法条。 |
| 121 | shrink | `const needsNecessity = finding.prescription.kind === "patch" \|\| finding.prescription.kind === "addMechanism"; if (needsNecessity !== (finding.prescr` | 「patch/addMechanism 必须给 necessityExplanation」是按 status 才需要的必需字段，保留；但 !== 双向等价同时禁止其他 kind 携带该字段，多出的字段不应参与拒绝。 |

### `src/merger-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 70 | shrink | `if (value.status === "escalate" && exact(value, ["status", "attemptId", "diagnosis", "report"]) && !blank(value.diagnosis)) return ...` | escalate 分支确实需要非空 diagnosis（按 status 才需要的字段，保留）；exact 闭合键集合删除。 |

### `src/navigator-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 37 | keep | `if(!expectedPrimary(status).includes(kind))fail("status primary shape") / status==="ordinary"?["package_role","caller_action","stop"]:…` | status 与 primary.kind 的对应是「按 status 才需要的内容」，refused 必须带 defect、insufficient 必须带非空 missing，是真实必需性；保留最小形式即可（额外字段不该再拒绝）。 |
| 37 | keep | `if(!Array.isArray(p.missing)\|\|p.missing.length===0)p.missing=fail("missing evidence")` | insufficient 状态下 missing 必须非空属必需字段检查，保留；但写法 `p.missing=fail(...)` 是对 never 返回值的赋值，纯噪音，顺手清理。 |

### `src/package-contracts/collector-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 226 | keep | `if (value.terminalStatus !== "unavailable" && value.terminalStatus !== "missing") { fail(`reports[${index}].terminalStatus is invalid`); }` | Terminal fact semantics differ by status and the report is the certified statement; but the surrounding closed-key list (line 220) must still go. |
| 509 | keep | `if (!Array.isArray(value.reports) \|\| value.reports.length === 0) fail("Collector receipt reports are invalid"); if (!Array.isArray(value.legs) \|\| ` | Non-empty required-field check (a receipt with no reports/legs certifies nothing) — explicitly excluded from D2 by the brief. |

### `src/package-contracts/fixer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 86 | shrink | `if (!Array.isArray(item.exceptions)) fail(`${path}.exceptions array constraint`);` | Requiring an always-present `exceptions: []` repeats the meaningless empty-array requirement ADR 0033 removed from compliance `pass`; make it optional and treat absent as none. |

### `src/package-contracts/reviewer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 52 | shrink | `const failures = new Set(["cancelled", "provider", "snapshot", "workspace", "child", "unknown"]);` | failed 状态需要一个失败分类属于按 status 才需要的字段，但没有任何 consumer 按分类值选择执行分支，闭合枚举成员校验按 ADR 0040 不构成保留例外。 |
| 67 | shrink | `if (output.status === "completed" ? Object.hasOwn(output, "diagnostic") : typeof output.diagnostic !== "string" \|\| output.diagnostic.trim().length =` | 保留 refused ⇒ 非空 diagnostic；删除 completed 携带 diagnostic 即拒绝那半——那是额外字段拒绝（D1）。 |
| 117 | shrink | `if (Object.hasOwn(outcome, "failure") \|\| report === undefined \|\| materialized === undefined) throw new Error("Successful Reviewer outcome requires` | 若确有 consumer 读报告，可保留 successful ⇒ report 存在；删除 successful 不得携带 failure 键这类额外字段拒绝，以及 materialization evidence 的强制存在（其证据价值已在 I/O 接缝兑现）。 |

### `src/reviewer-admission.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 47 | keep | `if(!record(p.required)\|\|p.required.standards===undefined\|\|(spec.state==="established"&&p.required.spec===undefined)) fail("capability-invalid", ..` | 按分支才需要的必需字段：established 分支确实要跑 spec 腿，没有 grant 就无法执行。 |

### `src/reviewer-child-executor.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 204 | keep | `if (report.trim().length === 0) throw new Error("Reviewer Agent returned a blank child report");` | report 必须非空属必需字段检查，空报告下这条 leg 没有产物可结算。 |

### `src/reviewer-execution-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 144 | shrink | `event.violations.length === 0 \|\| event.violations.some((code) => !REVIEWER_PREFLIGHT_VIOLATIONS.includes(code))` | rejected 状态下 violations 非空属「按 status 才需要的必需字段」保留；闭合枚举成员检查删除——violation code 只被原样报告，不选择任何执行分支（ADR 0040）。 |
| 201 | shrink | `if (typeof event.report !== "string" \|\| event.report.length === 0 \|\| event.failure !== undefined \|\| event.runtimeConstructionEvidence === undefi` | successful 只需「report 非空」（必需字段非空保留）；event.failure !== undefined 是禁止额外字段的闭合法条，runtimeConstructionEvidence 必填随该身份壳一起删。 |

### `src/reviewer-pinned-git.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 151 | keep | `if (diff.length === 0) invalid("range-invalid", "review range must contain a non-empty diff between base and pinned target");` | 空 diff 下这份工作没有可评审对象，属「命令真正可执行的最小条件 / 必需非空」，不是格式法条。 |

### `src/reviewer-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 106 | keep | `if (typeof rawScopeKeys !== "string" \|\| rawScopeKeys.length === 0) throw new Error("Reviewer scope keys must be a nonempty comma-separated string");` | 给了 flag 就必须有内容才能执行，属命令真正可执行的最小条件。 |

### `test/class-contracts.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 25 | keep | `{ judgeStatus: "continue", fix: { summary: "repair" } },` | continue 缺 classes 属于该 status 的必需字段缺失，保留。 |

### `test/collector-config.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 253 | keep | `["no-legs",{version:1,legs:[]},/legs\|min/i],["empty-authors",...],["blank-author",...],["empty-body",{request:{body:"  "}}]` | 没有 leg / 没有 expectedAuthor / 空 body 时 Collector 无法执行收集，属必需字段非空，不算 D2。 |

### `test/doctor-case.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 214 | keep | `assert.throws(... lastRealBite: { kind: "noRealBite", ... } ...), /noRealBite permits only thin or delete/); ... /necessity explanation/` | 按 kind/prescription 分支要求各自必需材料（noRealBite 不得配 keep、patch 必须给必要性说明），属状态条件必需字段。 |

### `test/fixer-auditor.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 27 | delete | `assert.deepEqual((decisionTool?.parameters as any).required, ["status", "violations"]);` | ADR 0033 明令 pass 只要求 status，不再强制携带 violations: []；此断言把旧法条钉死。 |

### `test/fixer-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 43 | keep | `test("Fixer projects semantic settlements despite presentation trivia", ... decoration: true ... commitSha "REVISION-A"/"revision-B"` | 断言未知装饰字段被忽略而非拒绝，且 commitSha 不受十六进制拼写约束——正是删除后应有的接受面。 |
| 69 | keep | `["plan", { ... blocker: { cause: "prerequisite_unmet", evidence: "x" } }], ["plan", { ... blocker: { cause: "safety", evidence: "x" } }]` | prerequisite_unmet 缺 prerequisiteId＝该 cause 的必需字段缺失；未知 cause＝判别值非法（K1）。 |
| 73 | keep | `["apply", { status: "completed", report: "x", classResults: [completed("A", " ")] }],` | completed 分支的 commitSha 非空是必需字段检查（#59 保留语义）。 |
| 74 | keep | `["apply", { status: "partially_completed", ... classResults: [completed()] }], ... ["apply", { status: "refused", report: "mixed", classResults: [comp` | status 与 disposition 组合是结算诚实性（不能把混合结果标成全完成/全拒绝），属于该 status 自身必需的材料。 |

### `test/fixer-prerequisite-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 81 | keep | `[JSON.stringify([{ id: "x", requirement: " " }]), /requirement.*nonblank/],` | requirement 非空属必需字段检查。 |
| 135 | keep | `const decorated = { ...planRefusal, blocker: { ...planRefusal.blocker, presentation: true } }; assert.deepEqual(validateFixerOutputForPacket(decorated` | 装饰字段被忽略并剥离，是删除闭合对象后应保有的正向行为。 |

### `test/judge-output-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 90 | keep | `test("retained evidence is optional, opaque, and lawful on every judge status"` | 断言每个 judgeStatus 只要求自身必需字段、evidence 任意内容都不被拒绝，正是保留方向的正向覆盖。 |

### `test/judge-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1462 | keep | `["converged with blank note", { judgeStatus: "converged", note: " \n" }],` | note 存在时必须非空白，属"给了就必须有内容"的必需性检查，不是格式法条。 |

### `test/merger-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 43 | shrink | `assert.throws(() => validateMergerOutput({ status: "escalate", attemptId: "attempt-22-a", diagnosis: " ", report: "x", mergeCommitId: oid("c") }, ...)` | 这条同时压着必需字段（diagnosis 非空，保留）和多余字段（escalate 带 mergeCommitId，应删），断言分辨不出是哪条触发；须拆成只测空白 diagnosis。 |

### `test/reviewer-auditor.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 106 | shrink | `fauxToolCall(REVIEWER_AUDIT_TOOL_NAME,{status:"pass",violations:[]})` | ADR 0033：pass 只要求 status，不再要求携带 violations:[]；测试 fixture 应去掉该列（revise 要求非空 violations 的断言保留）。 |

### `test/soul-auditor.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 124 | delete | `["pass with violations", { status: "pass", violations: ["contradiction"] }],` | ADR 0033：pass 只要求 status，额外内容一概不管；"pass 不得携带 violations" 是被删的法条。 |
| 125 | keep | `["empty revise", ...], ["blank violation", ...], ["mixed violation values", ...], ["non-array violations", ...], ["unknown status", { status: "maybe" ` | revise 必须带非空且非空白的字符串 violations（该 status 的必需材料），未知 status 是非法判别值（K1）。 |
| 130 | delete | `["missing violations", { status: "pass" }],` | 按 ADR 0033，`{status:"pass"}` 应当被接受；此用例的断言方向必须反转，不能原样保留。 |

### `test/terminating-tools.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 8 | keep | `assert.throws(() => validateAcceptedDetails("ak_coder_output", {}), AcceptedDetailsContractError)` | 空对象缺 status/report 属必需字段缺失，且是典型的契约拒绝 vs 意外失败区分的正例。 |

## K3 live target / authority / evidence 绑定（90）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 159 | keep | `a mandatory narrow V1 capability file bound to the task's exact bytes` | capability 与 task 之间只能靠摘要绑定（capability 不携带 task 文本），属 ADR 0028 允许的"现场重算并相等"字节绑定；只删 hex 外观校验。 |
| 215 | keep | `successful receipts embed `snapshots[]` and `evidenceRecords[]` so every evidence ref resolves inside the tool-result details;` | evidence ref 解析属 ADR 0037/0039 的证据对象绑定保留例外（错绑会让下游读到别的证据）。 |
| 256 | keep | `{"status":"completed","attemptId":"opaque attempt","report":"nonblank report","mergeCommitId":"full lowercase 40- or 64-hex object ID"}` | ADR 0027 明确保留 Merger 的完整 Git OID 并与实时 Git 状态绑定；真正的校验是与 HEAD/parents 比对，独立 hex 拼写正则若与实时比对重复则由 src 区收成一处。 |

### `src/collector-config.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 104 | keep | `if (display.includes("://") \|\| display.includes("?") \|\| display.includes("#") \|\| ... ) fail("...rejects URL syntax, credentials, query, fragment` | This string is interpolated straight into `/repos/${owner}/${repo}/pulls/${n}` for gh api, so single-separator plus no query/fragment/dot-segment escape is what keeps observation, comment posting and the receipt bound to the intended repository. |
| 155 | keep | `if (!/^[1-9][0-9]*$/.test(raw)) { fail("Collector pull request number must be a positive safe integer string"); } ... if (!Number.isSafeInteger(value)` | Without the digit-only form Number() silently retargets ('1e3' becomes PR 1000), so this is live-target binding, not presentation; keep it as the minimal 'positive safe integer' condition. |

### `src/collector-evidence.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 116 | keep | `export function computeWindowRelation(authoritativeTime, activationTime, deadlineTime): WindowRelation { ... if (!Number.isFinite(ms)) return "uncerta` | Unparseable or missing GitHub timestamps degrade to 'uncertain' rather than being accepted as in-window, which is the window binding failing closed without adding a format law. |
| 145 | keep | `if (author === undefined \|\| !input.expectedAuthors.has(author)) return { ok: false, reason: "author" }; ... if (input.review.commitOid !== input.tar` | Author, exact-head and window binding are exactly the K3 case: a mis-bound review would certify the wrong reviewer or the wrong commit as reviewed. |

### `src/collector-github.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 199 | keep | `if (!isRecord(head) \|\| typeof head["sha"] !== "string" \|\| head["sha"].length === 0) { throw new Error("GitHub pull request payload missing head.sh` | head.sha is the live target HEAD every review is bound against; a missing one must fail rather than silently become an empty target. |
| 572 | keep | `export function buildCollectorRequestMarker(input): string { const prefix = input.manifestDigest.slice(0, 12); return `<!-- ak-collector:v1 manifest=$` | The marker is matched verbatim by collector-ledger.ts:800/915 (`record.body.includes(marker)`) to recognize Collector's own posted request for this leg at this HEAD — a real correlation reference, and the body is preserved byte-for-byte with no re-validation. |

### `src/collector-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 648 | keep | `if (activationTime === undefined \|\| deadlineTime === undefined \|\| deadlineMono === undefined) throw ... if (latestCompleteSnapshotId === undefined` | 证据新鲜度绑定：mutation 之后未重新观测就交卷，等于用过期证据对当前对象出具结论（ADR 0037）。 |
| 674 | keep | `if (snapshot.completedMono === undefined \|\| snapshot.completedMono < deadlineMono) { throw new Error("Collector output at/after cutoff requires a co` | cutoff 后的终局结论必须绑定 cutoff 之后完成的观测，否则会用 cutoff 前的证据宣布终局。 |
| 711 | keep | `if (prIdentity(surfaces.prInitial) !== prIdentity(surfaces.prTerminal)) { surfaces = await fetchObserveSurfaces(...); if (... !== ...) throw new Error` | 观测夹逼：不绑定就可能把跨越 HEAD 变更的半新半旧证据当成一次一致快照，后续 valid 判定会对错误 commit 出具证据（ADR 0037）。 |
| 874 | keep | `const snapshot = snapshots.find((item) => item.snapshotId === input.snapshotId); if (snapshot === undefined) ... if (snapshot.snapshotId !== latestCom` | 请求必须绑定当前 live target：引用旧快照会对已经变过的 HEAD 发出请求并据此结算（ADR 0037）。 |
| 881 | keep | `if (snapshot.prState !== "OPEN") { throw latchFatal("Collector cannot request on a non-OPEN pull request snapshot"); }` | live target 状态绑定：对已关闭 PR 发起 reviewer 请求是对错误对象执行动作。 |
| 887 | keep | `const hasQualifying = snapshot.evidenceIds.some((id) => { ... return reviewQualifiesForValid({ review: record, expectedAuthors: expected, targetHead: ` | 与回执 valid 同一条现场语义法（同一 reviewQualifiesForValid 真源），避免对已满足的腿重复扰动真实 PR。 |

### `src/collector-receipt.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 444 | keep | `if (ledger.latestCompleteSnapshotId === undefined) fail("Collector output requires a complete final snapshot"); ... if (finalSnapshot === undefined \|` | 交卷必须绑定一个完整、OPEN 的现场终局快照，否则回执会对错误 / 过期目标出具结论；但前两项与 assertOutputObservationLaw(L651/L659) 重复，裁决时收成一处。 |
| 528 | keep | `if (record === undefined \|\| record.kind !== "review") fail(...) ; if (!finalSnapshot.evidenceIds.includes(record.evidenceId)) fail(...) ; const qual` | valid 结论是授权性事实：错误绑定会让下游认为错误 commit 已通过评审（ADR 0037 明确保留 Collector snapshot/report evidence refs 绑定）。 |
| 560 | keep | `if (finalHasQualifyingValidReview({ ledger, leg, finalSnapshot, targetHead, activationTime, deadlineTime })) { fail(`Collector unavailable leg ... rej` | 终局状态不得覆盖现场已存在的 exact-head 合格评审，否则回执会对真实对象出具相反事实。missing 分支 L636 同理保留。 |
| 591 | keep | `const result = qualifiesUnavailableEvidence({ record, expected, activationTime, deadlineTime, scope, targetHead }); if (!result.ok) { ... fail(`Collec` | unavailable 也是对外出具的授权性事实；target scope 要求证据 commitOid 精确等于 targetHead 属真实对象同一性绑定，不是格式外观。 |

### `src/collector-tool-schemas.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 37 | keep | `evidenceRefs: Type.Array(nonEmptyString, { minItems: 1 })` | Every leg verdict must cite at least one evidence ref, and collector-receipt.ts:761-774 resolves each ref against the receipt's own evidence/snapshot index — real evidence binding. |
| 37 | keep | `evidenceRefs: Type.Array(nonEmptyString, { minItems: 1 })   // valid leg` | A valid leg's evidence cites are the binding between the classification and the ledger records that must independently qualify (collector-receipt.ts qualifying loop). |

### `src/doctor-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 107 | keep | `const assertTargets = (targetKeys: string[]) => { for (const targetKey of targetKeys) if (!lawfulTargets.has(targetKey)) throw new Error(`Target key i` | finding/missingEvidence 的 targetKey 必须指向本案真实存在的 invocation 或 case；指错对象会让证词给错误对象背书（ADR 0037）。 |
| 109 | shrink | `if (canonicalJson(output.case) !== canonicalJson(patient.identity)) throw new Error("Doctor submission case must equal the activated case identity");` | 绑定本身保留（design.md 明列「激活后 testimony 与 activated patient 绑定」）；但按 ADR 0030，两个 runtime 对象直接比字段相等即可，canonicalJson 序列化不应成为等值判定通道。 |
| 110 | keep | `const readCitations = (ids: string[], label: string) => { for (const id of ids) if (!store.entries.has(id) \|\| !store.hasRead(id)) throw new Error(`$` | 引用证据必须是已准入且已完整读取的本案证据，否则证词凭空成立；ADR 0037 明确「Doctor finding 的已读本案证据」属保留例外。 |
| 126 | keep | `if (!entry \|\| entry.kind !== "session" \|\| !store.hasRead(entry.id)) throw new Error("actual bite must cite an admitted/read retained session");` | 「实际咬人」只能由已读 session 里的 typed terminating 结果证明（ADR 0012 forward amendment: typed terminating results in those sessions remain the only bite），错绑会让 keep 处方拿到伪证。 |
| 128 | keep | `if (finding.disposition === "keep") throw new Error("noRealBite permits only thin or delete");` | ADR 0012 明文「keep 必须有实际 bite」；这是把已拍定的证据-处置绑定机械化，属可机械化的不变式而非格式法条。 |

### `src/doctor-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 16 | keep | `for (const name of required) if (names.filter((item) => item === name).length !== 1) throw new Error(`Doctor required tool collision or missing: ${nam` | Doctor 是纯举证席（ADR 0012），工具面被顶替/重名会让它以别人的权限行动；这是激活 barrier 的授权绑定，保留。 |

### `src/git-object-id.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 5 | keep | `export function isFullGitObjectId(value: unknown): value is string { return typeof value === "string" && FULL_GIT_OBJECT_ID_RE.test(value); }` | ADR 0027 keeps full-OID validation exactly where Merger binds targetObjectId/sourceObjectId/mergeCommitId to live Git state (src/merger-contracts.ts:52,69; src/merger-git-state.ts:45,47,51; src/merger-role.ts:38) — wrong object identity would merge or attest the wrong commit. |

### `src/merger-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 36 | shrink | `if (!Array.isArray(value) \|\| value.length === 0 \|\| !value.every(canonicalPath)) fail(`Merger ${label} must be a non-empty canonical path set`);` | 数组存在且非空是命令可执行的最小条件（无冲突就不存在 merger 任务），保留；canonicalPath 那半删。 |
| 52 | keep | `!isFullGitObjectId(value.targetObjectId) \|\| !isFullGitObjectId(value.sourceObjectId)` | ADR 0027 明确点名：Merger 的 target/source 是确认一次真实 merge 所必需的对象身份，且在 merger-role.ts:38 与实时 Git 绑定。 |
| 57 | keep | `if (!conflicts.every(path => scope.includes(path))) fail("Merger resolution scope must contain the complete conflict set");` | 授权范围必须覆盖完整冲突集，否则角色被要求解决它无权触碰的文件——ADR 0037 的授权绑定例外。 |
| 68 | keep | `if (!record(value) \|\| blank(value.attemptId) \|\| blank(value.report) \|\| (expectedAttemptId !== undefined && value.attemptId !== expectedAttemptId` | report 非空是必需字段；attemptId 与本次派工相等是回执对应正确 attempt 的绑定（ADR 0037）。注意 expectedAttemptId 可选，terminating-tools.ts:152 调用时不传，绑定只在 role 内成立。 |

### `src/merger-git-state.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 58 | shrink | `const frozenTree = line(await git(repositoryRoot, ["rev-parse", "--verify", `${automaticMergeTreeId}^{tree}`]), ...); if (frozenTree !== automaticMerg` | rev-parse 的存在性检查有价值（AUTO_MERGE tree 若已不可解析，L60 的 resolution 差集就是假证据）；但等值断言在该 OID 本就取自 `AUTO_MERGE^{tree}` 时恒真，可删等值只留解析成功。 |
| 61 | shrink | `worktreeClean: status.byteLength === 0 && currentHead === mergeCommitId` | currentHead === mergeCommitId 是真实的 HEAD 绑定，保留；status 用 `--untracked-files=all`（L56）把任何未跟踪文件也算脏，是与 L57 worktreeClean 同一个待裁决点。 |

### `src/merger-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 38 | keep | `if (state.targetObjectId !== input.targetObjectId \|\| state.sourceObjectId !== input.sourceObjectId \|\| ...) throw new Error("Merger activation reje` | 实时仓库 HEAD/MERGE_HEAD 与派工目标绑定，ADR 0037 明确点名保留（否则会对错误的 merge 施工）。 |
| 57 | keep | `if (state.mergeCommitId !== output.mergeCommitId \|\| !same(state.parentObjectIds, [activation.input.targetObjectId, activation.input.sourceObjectId])` | 完成态核验：HEAD 即所报 merge commit、父提交恰为派工的 target/source（父顺序是 Git 语义不是呈现）、无残留冲突——ADR 0023/0037 明示 runtime 保留这类行为验证。 |

### `src/navigator-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 39 | keep | `export function navigatorBindingMatchesV1(snapshot,receipt){return receipt.runId===snapshot.runId&&receipt.snapshotDigest===snapshot.digest&&receipt.p` | 把回执绑定到它实际看过的那一份 live snapshot/cursor，错误绑定会让调用方按过期位置派工，属 live target 绑定，保留。 |

### `src/navigator-evidence.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 8 | keep | `if(sha256Hex(bytes)!==item.sha256)throw new Error(`evidence digest mismatch: ${item.id}`)` | 这是 ADR 0028 保留形态本身：真消费方（证据读取）在现场对实际字节重算并绑定；#28 清 SHA256 拼写正则时必须保留这一条。 |

### `src/navigator-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 50 | keep | `const active=activeState();if(!active)throw new Error("Navigator not activated");` | 激活 fail-closed barrier（ADR 0019 保留关门），未激活时工具不得执行；L62 同形，属共享信封语义，保留。 |

### `src/package-contracts/collector-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 480 | keep | `if (value.host !== COLLECTOR_HOST) fail("Collector receipt host is invalid");` | host+repository+prNumber is the live target binding — a receipt bound to the wrong PR would certify the wrong object. |
| 491 | keep | `if (typeof value.activationTime !== "string" \|\| value.activationTime === "") { ... } if (typeof value.deadlineTime !== "string" ...) { ... } if (typ` | activation/deadline/finalObservation is the collection window binding named in K3; non-empty-string only, no ISO-8601 format regex — already at the minimum. |
| 503 | keep | `if (typeof value.finalSnapshotId !== "string" \|\| value.finalSnapshotId === "") { fail(...) } if (typeof value.targetHead !== "string" \|\| value.tar` | final HEAD and final snapshot id are the evidence anchor of the collection; required non-empty only, no format law imposed — already minimal. |

### `src/package-contracts/fixer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 17 | keep | `const completedClassResultSchema = Type.Object({ name, disposition: Type.Literal("completed"), searchScope, exceptions, commitSha: nonblankTransportSt` | Per-class commitSha is #59 owner-approved settlement semantics and is explicitly outside #58's delete scope (only Coder's self-reported commitSha dies under ADR 0024). |

### `src/reviewer-admission.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 31 | shrink | `...!unique(tools)\|\|!unique(prerequisiteOperations)\|\|tools.some(x=>!ceiling.tools.includes(x)\|\|!hostTools.includes(x))\|\|prerequisiteOperations.` | 保留天花板与 hostTools 包含性（授权范围＋工具真实可执行，ADR 0037）；删除 unique(tools)/unique(prerequisiteOperations)——grant 是集合语义，重复项不造成引用歧义（ADR 0039）。 |
| 51 | keep | `for(const op of REVIEWER_PREREQUISITES.filter(x=>x.startsWith("preflight."))) if(!ceiling.prerequisiteOperations.includes(op)) fail("prerequisite-miss` | 授权范围检查：没有这些前置授权就不能对 pin 住的目标取证，属 ADR 0037 保留的授权语义（L53 的 runner.* 同判）。 |

### `src/reviewer-child-executor.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 146 | keep | `if (typeof input.command !== "string" \|\| !leg.grant.bashCommands.includes(input.command)) throw new Error("Reviewer bash command denied: command is ` | 真实 exec 接缝上的授权范围执行：越界会让子代在评审克隆里跑票外命令，无下游兜底。 |
| 182 | shrink | `const visibleTools = session.agent.state.tools.map(t => t.name); if (JSON.stringify(visibleTools) !== JSON.stringify(leg.grant.tools)) throw new Error` | 工具隔离本身是授权绑定，保留；但用 JSON.stringify 逐字节比对意味着顺序变化即拒绝——比较工具名集合即可，序列化拼写不该成为拒绝条件（ADR 0030）。 |

### `src/reviewer-dispatch.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 29 | shrink | `...new Set(v.tools).size!==v.tools.length\|\|new Set(v.prerequisiteOperations).size!==v.prerequisiteOperations.length)throw new Error("Reviewer capabi` | 保留未知值拒绝（授权天花板必须可解释）；删除重复值拒绝——天花板是集合语义，重复不产生歧义（ADR 0039）。 |
| 35 | keep | `if(!sameReviewerPinnedTarget(await d.reader.snapshot(),target))throw new ReviewerPreflightError("target-drift", "pinned target snapshot changed before` | ADR 0037 点名保留 Reviewer 的冻结 target 绑定：漂移后仍放行会让格式完整的评审静默对应错误 commit。 |

### `src/reviewer-execution-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 197 | shrink | `if (!sameReviewerPromptIdentity(event.prompt, compiled.prompt) \|\| !isReviewerPromptIdentity(event.prompt)) throw new Error("Actual runner prompt doe` | 「实际投喂子代的 prompt 就是被接受那条」属授权绑定保留，但只需比较文本；随 ADR 0031 删除长度/摘要比较与 isReviewerPromptIdentity 自证。 |
| 199 | keep | `if (!sameReviewerPinnedTarget(event.target, accepted.target)) throw new Error("Runner target does not match shared pinned target");` | ADR 0037 保留例外：leg 结算必须与被接受的冻结 target 同一（宽度问题见 reviewer-git-snapshot.ts:47 那条）。 |

### `src/reviewer-git-snapshot.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 47 | needs-adjudication | `export function sameReviewerRefs(actual, expected) { ...actualEntries.length === expectedEntries.length && actualEntries.every(...) }` | 钉点比对目前绑定整仓 refs/heads+tags+remotes 全表（drift 判定、workspace 三处复用）：真正需要绑定的是 targetHead 与派生 range，任一无关 ref（如后台 fetch 更新 refs/remotes）变动都会拒整次运行；ADR 0037 说保「冻结 target」，但 target 的宽度需 owner 界定。 |

### `src/reviewer-pinned-git.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 52 | keep | `readRange!.base!==base!\|\|readRange!.target!==target.targetHead` | ADR 0037 保留例外：range 必须绑定到冻结 target 与已解析 base，否则格式完整的回执可能安静地对应另一个 commit。 |
| 52 | shrink | `readRange!.diffCommand!==`git diff ${base!}...${target.targetHead}`` | diffCommand 最终成为子代唯一被允许的 bash 命令（reviewer-construction.ts:85 → child-executor 白名单），授权绑定该留；但该由构造侧直接从 base/target 派生这条命令，而不是让 reader 报一份再拿模板字符串核对拼写。 |
| 106 | keep | `const headExpression = /^HEAD((?:~[0-9]+\|\^[0-9]+)*)$/.exec(base); ... `${targetHead}${headExpression[1]}^{commit}`` | 这不是格式法条而是钉点绑定：把用户写的 HEAD~N 改写到冻结的 targetHead 上，否则 HEAD 会漂到实时仓库状态。 |
| 120 | keep | `const matches = reachableCommitIds.filter(c => c.startsWith(base)); if (matches.length !== 1) invalid("base-invalid", "...exactly one reachable commit` | 缩写只在钉点可达集合内解析且必须唯一，属实时目标绑定（歧义缩写会安静指向另一个 commit）。 |
| 129 | keep | `await gitText(repositoryRoot, ["merge-base", "--is-ancestor", commit, targetHead]); ... invalid("base-invalid", "base revision must be an ancestor of ` | ADR 0037 保留例外：证据区间必须落在冻结 target 的历史内，否则回执会对应票外范围。 |
| 155 | keep | `if (revision !== targetHead) throw new Error("Material revision is not the pinned target");` | 材料必须取自冻结 target，否则证据与被评审对象脱钩。 |

### `src/reviewer-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 134 | keep | `if (dispatch === undefined \|\| dispatch.identity !== execution.identity) throw new Error("Reviewer execution lacks accepted construction evidence");` | 绑定实际执行与被接受的 dispatch，错绑会让子代理对错误构造对象执行（ADR 0037）。 |

### `src/reviewer-workspace.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 39 | keep | `if ((await git(cwd, ["rev-parse", "--show-object-format"])).stdout.trim() !== snapshot.objectFormat) throw ...; if (head !== snapshot.targetHead) thro` | 克隆出来的工作区必须确实停在冻结 target 上，否则子代会对错误对象评审并出具证据（ADR 0037）。 |
| 57 | keep | `if (!sameReviewerPinnedTarget({ repositoryRoot, objectFormat, targetHead, refs }, accepted)) throw new Error("Accepted Reviewer target/ref identity no` | 派工被接受后再确认实时仓库没漂，属 ADR 0037 保留的实时目标绑定（同样受 refs 全表宽度问题影响）。 |

### `src/role-runtime.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 490 | shrink | `const activeTools = pi.getActiveTools?.() ?? navigatorRequiredTools; if (activeTools.length !== 2 \|\| !navigatorRequiredTools.every((name) => activeT` | Fail-closed authority narrowing is worth keeping (a silently ignored setActiveTools would hand Navigator the full toolset), but the hardcoded arity 2 duplicates navigatorRequiredTools.length and will rot. |

### `src/sha256.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 4 | keep | `export function sha256Hex(bytes: string \| Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }` | Pure producer with no rejection branch; ADR 0028 keeps on-the-spot recomputation as the byte-binding mechanism, and the doc-comment framing it as a "reviewer identity" encoding should follow the D3 envelope deletion. |

### `test/activation-envelope-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 135 | shrink | `test("every registered whole-activation rejection terminates nonzero with a named cause before a model turn", ... error instanceof ActivationBarrierEr` | fail-closed 屏障 + 具名 cause + 未触达 provider 是 ADR 0019 明确保留的核心；只需去掉其中的 started/completed 轨迹断言，保留 failed.cause 断言。 |
| 193 | shrink | `test("incident 2026-08-02: malformed Fixer prerequisites fail the real Pi subprocess before provider dispatch", ... FIXER_AUDIT_FAILURE_PROVIDER_CALLS` | 真实子进程的"provider 零调用 + 具名 cause"必须保留（闸类负向案）；仅 L214-217 里 `{stageId:"load-and-install", status:"started"}` 那一行随 D6 删除。 |
| 268 | shrink | `test("failed trace emission cannot mask the activation cause or skip termination", ... error instanceof AggregateError && error.errors[0] === activati` | failed cause 的 stderr 证据是 ADR 0019 保留项，"轨迹写失败不得吞掉真因"属失败诚实宪法，保留；写入计数依赖 started 轨迹先写一次，需按新形态改写。 |
| 313 | keep | `for (const [mode, expected] of [["print", 1], ["json", 1], ["tui", undefined], ["rpc", undefined]] as const) test(`activation failure applies ${mode} ` | 激活失败的非零退出策略是屏障可观察后果，ADR 0019 保留。 |

### `test/collector-ledger.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 302 | keep | `await assert.rejects(()=>ledger.request({legId:"watch",...}),/observe-only/); await assert.rejects(...,/process-local\|already/); await assert.rejects` | request 绑定的是真实 leg/snapshot/HEAD 与资格窗口，属 K3 的 Collector window 保留面，不是格式拼写。 |

### `test/doctor-auditor.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 24 | keep | `assert.equal("content" in payload.frozenEvidenceIndex.evidence[0], false); assert.equal(JSON.stringify(payload).includes("LIVE_SECRET_SESSION_BYTES"),` | 证据索引与实际字节的边界，是真实的证据绑定与泄漏闸门。 |

### `test/doctor-case.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 216 | keep | `assert.throws(() => validateDoctorOutput({ ...output, findings: [{ ...finding, targetKey: "invented-run" }] }, ...), /lawful case target/); ... assert` | finding 目标与证据必须落在已激活本案内，正是 ADR 0037 保留的证据/目标绑定。 |

### `test/doctor-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 17 | keep | `assert.deepEqual(accepted.details, { ...testimony, cost: patient.cost }); assert.equal("cost" in audited.at(-1).testimony, false);` | runtime 现场事实封入回执、审计只看模型自己的证词，属 ADR 0042 保留的事实归属边界。 |

### `test/fixer-auditor.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 32 | keep | `for (const exactInput of [input.soul, JSON.stringify(input.packet), input.phase, input.transcript, JSON.stringify(input.candidate)]) assert.equal(audi` | 审计确实看到本次调用的真实材料，属于证据绑定；且 L40/L43-49 的 malformed decision 与基础设施失败保留（失败诚实）。 |

### `test/judge-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 579 | keep | `assert.doesNotMatch(firstAuditText, /evidence\|opaqueOnly/); assert.deepEqual(Buffer.from(firstAuditText), Buffer.from(secondAuditText));` | 审计只看裁决字段、不看不透明 evidence，且带/不带 evidence 的审计输入逐字节相同——真实的投影边界。 |
| 1492 | keep | `test("judge output must be the sole call in its assistant batch", ... [sibling, { id: "judge", arguments: verdict }] ... /sole final tool call/` | ADR 0041 明确保留 sole-final 交卷；judge-role.test.ts:1377（Fixer）与 merger-role.test.ts:119 是同一闸门的其他实例，同样保留。 |

### `test/merger-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 25 | keep | `const drifted = valid(); drifted.materials.authority.sha256 = "0".repeat(64); assert.throws(() => validateMergerInput(drifted), /digest/);` | ADR 0028 保留的字节绑定：摘要必须与现场 base64 字节重算结果相等，删了会让 Merger 对错误材料动手。 |
| 32 | keep | `assert.throws(() => validateMergerInput({ ...valid(), targetObjectId: "ABC" }), /object ID/);` | ADR 0027 明确保留 Merger 的 target/source/mergeCommit OID 校验并与实时 Git 绑定。 |

### `test/merger-git-state.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 36 | keep | `assert.deepEqual(await state.completedMerge(mergeCommitId, active.automaticMergeTreeId), { mergeCommitId, parentObjectIds: [...], unmergedPaths: [], w` | 真实 Git 现场事实（父对象、未合并路径、工作树干净度、被改动路径），是 ADR 0037 保留的实时目标绑定。 |

### `test/merger-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 98 | keep | `test("Merger activation rejects non-conflicts, incomplete conflict sets, and parent drift", ...) await assert.rejects(..., /Merger activation/)` | 激活期把票面 target/source/冲突集与实时 merge 状态对齐，错绑会让 Merger 对错误对象动手。 |
| 114 | keep | `{ args: valid, calls: 2, message: /sole final/ }, ... await assert.rejects(..., /already accepted/)` | sole-final 与"只接受一次"由 ADR 0041 明确保留（交卷同时还在行动＝无声歧义）。 |

### `test/navigator-contracts.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 15 | keep | `assert.throws(()=>validateNavigatorReceiptV1(refused,s,authorityRead),/defect evidence citation/)` | defect 必须引用本次快照内真实存在的证据对象，属证据绑定保留类（ADR 0037）；各 status 只要求自身 primary 材料也符合 ADR 0040。 |

### `test/navigator-shared-activation-envelope.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 102 | keep | `for (const failure of ["clear","flag","soul","snapshot","evidence","collision",...]) test(`Navigator ${failure} startup failure terminates through inf` | 这是激活 fail-closed 闸的负向案矩阵，ADR 0019 明确保留 barrier 与失败 cause；闸类契约负向案不可删。文件未断言健康路径 stage/started/completed trace，符合收窄后的形态。 |

### `test/package-entrypoint.integration.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 721 | keep | `classResults:[{name:"Contract",disposition:"completed",searchScope:"all",exceptions:[],commitSha:"a".repeat(40)}]` | Fixer 的 per-class commitSha 是 #59 owner 已批准的结算语义，保留（只有 Coder 自报 commitSha 按 ADR 0024 删）。 |

### `test/reviewer-agent.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 465 | keep | `test("Reviewer Agent reports deterministic setup failures with bounded retention evidence") assert.equal(accepted.legs.standards.runtimeConstructionEv` | 失败分类与保留工作区证据走的是真实物化接缝与摘要现场比对，不是格式外观；但其中 entries 携带的 utf8Length/sha256 三件套会随 ADR 0031 收缩，断言需同步。 |

### `test/reviewer-bundle-materializer.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 11 | keep | `test("materializer rejects digest and manifest mutation atomically")` | 落盘内容与 manifest 摘要的现场重算绑定，属 ADR 0028 允许保留的真实字节绑定（非外观校验）。 |

### `test/reviewer-execution-ledger.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 128 | keep | `assert.throws(()=>ledger.append(accepted()),/exactly one accepted/); assert.throws(()=>ledger.append(settled("standards","wrong bytes")),/compiled pro` | 把结算腿绑回被接受的那次派工与那条编译提示，是「不让回执安静对应错误对象」的真实绑定（ADR 0037）；生命周期唯一性属真实键唯一性。 |

### `test/reviewer-package-lifecycle.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 189 | keep | `assert.match(JSON.stringify(commandResults[0]),/exact accepted member/); // 含尾空格的近似命令也被拒` | 子代理 bash 授权集合的精确成员判定是执行授权范围，越界即执行未授权命令；保留（但对错误文案的正则依赖属盯文，应改断 typed 结果）。 |

### `test/reviewer-pinned-reader.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 19 | keep | `await assert.rejects(withAliases.resolve("same"),/base revision is ambiguous across pinned refs/); assert.deepEqual(reader.pin.refs["refs/tags/review-` | 冻结 target 与 base 解析歧义拒绝属 ADR 0037 明列的 Reviewer 保留面。 |
| 166 | keep | `assert.deepEqual(Object.keys(refs),["refs/heads/a","refs/tags/z"]); assert.equal(sameReviewerRefs(refs,{...}),true)` | 排序只用于内部稳定比较、不构成输入拒绝；ADR 0030 允许 consumer 直接验证内容相等。 |

### `test/reviewer-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 193 | keep | `test("runner result axes must exactly equal accepted one- and two-leg dispatch axes") legs:{...,surprise:successfulLeg(...,"EXTRA ARTIFACT")} → /resul` | 多出的 axis 意味着一份未经派工授权的报告被挂进回执，属授权范围绑定（ADR 0037），不是普通未知字段拒绝。 |
| 212 | keep | `{identity:"substituted-dispatch",...,message:/identity does not match/},{...target:{refs:{"refs/heads/main":{objectId:"other"}}},message:/target does ` | 实时 target 与派工身份绑定，错绑会让回执安静对应错误 commit（ADR 0037）。 |

## K4 路径约束（16）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 233 | keep | `Case identity is the issue number plus the repository-relative retained-runs path when a `.git` worktree root contains it; outside a repository the re` | Doctor 真实读取病例文件，路径圈界在真 I/O 接缝，按 ADR 0038 保留。 |
| 260 | keep | `rejects every resolution-changed path outside `resolutionScope`; clean source-side changes are not resolution edits` | 授权 resolution scope 的越界拒绝在真实写入接缝，按 ADR 0038 保留。 |

### `src/doctor-evidence.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 39 | keep | `const root = await realpath(runsPath); const match = root.split(sep).join("/").match(/\/\.ak\/work\/issues\/([1-9]\d*)\/runs$/); if (!match) throw new` | 这是真正即将递归读取整棵目录的 I/O 接缝，ADR 0038 点名「Doctor 病例读取」为保留例外；同一处还派生了必需的 issueNumber identity。 |

### `src/merger-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 34 | delete | `function canonicalPath(path) { return typeof path === "string" && path.length > 0 && !path.startsWith("/") && !path.includes("\0") && path.split("/").` | 这里不是真实读写接缝：真正的圈界发生在 merger-role.ts:57 用 git diff-tree 结果比对 scope，非规范路径只会匹配不上、无法授权越界，ADR 0038 下这层字符串格式法删除。 |

### `src/merger-git-state.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 60 | keep | `const resolutionChangedPaths = nulPaths(await git(repositoryRoot, ["diff-tree", ..., automaticMergeTreeId, mergeTree]), "Git resolution path delta");` | 这是 scope 圈界赖以成立的证据来源（与 merger-role.ts:57 配对），属真实读写接缝的授权核验。 |

### `src/merger-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 57 | keep | `state.resolutionChangedPaths.some(path => !scope.has(path))` | 这才是真实圈界接缝：用 git diff-tree 实际改动路径比对授权 scope，越界会静默改到票外文件（ADR 0038 点名保留 Merger resolution scope）。 |

### `src/reviewer-admission.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 34 | delete | `const SAFE_ID=/^[A-Za-z0-9][A-Za-z0-9._-]*$/;` | id 只是被拼进 .ak-reviewer/materials/selected/<id>.md，真正的路径圈界在真实写入接缝 reviewer-bundle-materializer.ts:22（绝对路径/反斜杠/./.. 检查）；ADR 0038 明令删除 proposal 层的重复路径格式护栏。 |

### `src/reviewer-bundle-materializer.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 22 | shrink | `if (isAbsolute(item.relativeClonePath) \|\| item.relativeClonePath.includes("\\") \|\| item.relativeClonePath.split("/").some(p => !p \|\| p === "." \` | 这是真正的写盘接缝，ADR 0038 保留绝对路径与 `..` 圈界；includes("\\") 是词法法条，且路径全部由包自己生成（construction.ts:66-69），可与 line 24 的 confined() 合并为一条。 |
| 29 | keep | `while (cursor !== root) { if ((await lstat(cursor)).isSymbolicLink()) throw new Error("Mechanical bundle parent is a symlink"); cursor = dirname(curso` | symlink 逃逸会把票外文件写坏且无下游兜底，属 ADR 0038 的真实 I/O 接缝圈界。 |

### `src/reviewer-pinned-git.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 156 | keep | `if (path.startsWith("/")) invalid("material-invalid", ...); if (path.split("/").some(s => !s \|\| s === "." \|\| s === "..")) invalid("material-invali` | ADR 0038 点名保留：Reviewer 仓库材料读取是真实读接缝，绝对路径与 `..` 段的圈界留在这里。 |

### `src/worker-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 211 | keep | `if (prerequisitesPath !== undefined && (typeof prerequisitesPath !== "string" \|\| prerequisitesPath.trim().length === 0)) { throw new Error("Fixer --` | Minimal condition for the file read to be executable at a real I/O seam; no path format regime is imposed. |

### `test/doctor-case.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 159 | keep | `await assert.rejects(loadDoctorCase(runs), /\.ak\/work\/issues\/<n>\/runs/);` | 真实读盘接缝的路径圈界，且 issueNumber 由该路径推导，属必需输入。 |

### `test/merger-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 35 | keep | `assert.throws(() => validateMergerInput({ ...valid(), resolutionScope: ["a.txt"] }), /scope/); assert.throws(... authorizedChecks: [{ name: "unit", ar` | resolutionScope 必须覆盖完整冲突集＝授权范围绑定（ADR 0038）；空 argv 是命令无法执行的最小条件（D4 允许的例外）。 |

### `test/merger-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 168 | keep | `test("Merger completion requires exact parents, clean worktree, and no unmerged paths", ... resolutionChangedPaths: ["same.txt", "unrelated.txt"] ... ` | 完成核验把 merge commit 的父对象、工作树状态与授权 resolution scope 绑定，属 ADR 0037/0038 保留例外。 |

### `test/reviewer-bundle-materializer.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 12 | keep | `for(const path of ["../escape","/absolute",".ak-reviewer/materials/../escape"]) await assert.rejects(materializeMechanicalBundle(...)); symlink parent` | 真实写入接缝上的路径圈界与目标碰撞保护（ADR 0038/0039），越界会覆盖票外文件。 |

### `test/reviewer-pinned-reader.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 145 | keep | `test("material path safety rejects unsafe Git object paths at the concrete read seam") /materials\.repositoryPath must be relative, not absolute/` | ADR 0038 保留例外：这是真实读取接缝上的路径圈界，越界会静默读取票外文件。 |

## K5 唯一性（40）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 114 | delete | `For apply, `classResults` is non-empty with unique nonblank `name` values.` | class name 是展示名，包内无 consumer 按它建表或查找；ADR 0039 只对真实映射键保留唯一性。非空 name 本身留。 |
| 114 | needs-adjudication | `completed commit identities are unique` | per-class commitSha 本身按 #59 owner 语义保留，但"跨 class 唯一"是额外规则且非查找键；是否属于 #59 结算语义需裁决。 |
| 277 | delete | `unique ... nonblank names and nonblank owner, boundary, and disposition fields` | Judge class name 的唯一性无包内 consumer 按它建表/查找/归属（包不路由），按 ADR 0039 删；非空 owner/boundary/disposition 属必需字段保留。 |

### `src/collector-config.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 426 | delete | `if (seenAuthors.has(author)) { fail(`Collector leg \"${id}\" has duplicate expected author \"${author}\"`); }` | Within one leg expectedAuthors is consumed as a Set (collector-evidence.ts:145, collector-receipt.ts:280), so a repeat is a harmless plain-array duplicate, which ADR 0039 no longer rejects. |
| 525 | keep | `if (seenIds.has(leg.id)) { fail(`Collector manifest has duplicate leg id \"${leg.id}\"`); }` | ADR 0039 names Collector legId explicitly: request/output lookups do `legs.find(l => l.id === legId)` (collector-ledger.ts:866,1087), so a duplicate id silently routes evidence to the wrong leg. |
| 530 | keep | `const owner = authorOwners.get(author); if (owner !== undefined) { fail(`Collector expected author \"${author}\" overlaps across legs \"${owner}\" and` | collector-receipt.ts:241 builds a real author -> legId map, so an author claimed by two legs makes the same review attributable to two legs — genuine reference ambiguity. |

### `src/collector-evidence.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 176 | keep | `function versionDigest(parts: Record<string, unknown>): string { return sha256Text(JSON.stringify(parts)); } ... export function evidenceIdFor(kind: s` | versionId is the real dedupe key for applyEvidenceVersionHistory and evidenceId is the reference target cited in output evidenceRefs; these are generated identities, not format checks, and nothing re-validates their hex shape here. |

### `src/collector-github.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 408 | keep | `if (seen.has(nextPath)) { throw new Error(`GitHub pagination repeated page: ${nextPath}`); } seen.add(nextPath);` | nextPath is a real reference target and a repeat means a Link cycle; without this the paginator loops forever with no downstream catch. |

### `src/collector-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 866 | keep | `const leg = config.manifest.legs.find((item) => item.id === input.legId); if (leg === undefined) { throw new Error(`Unknown Collector legId \"${input.` | legId 是 consumer 真正建表查找的引用目标；解析不到就无法确定往哪条腿发请求（ADR 0039）。 |
| 910 | keep | `const existingMarker = snapshot.evidenceIds.some((id) => { const record = evidenceById.get(id); return record?.kind === "issue_comment" && record.auth` | marker 是我们自己生成的真实关联键（非自由文本盯文），重复投递会在真实 PR 上留下歧义评论并让恢复逻辑串腿。 |
| 923 | keep | `const attemptKey = [config.repository.canonical, String(config.prNumber), snapshot.headOid, leg.id].join("\|"); if (attemptKeys.has(attemptKey)) { thr` | (repo,pr,head,leg) 是真实写操作幂等键，覆盖 ambiguous_loss 后尚未被观测到的投递；与 L910 marker 检查作用域不同（进程内 vs 已观测），二者不是同形状副本，但值得在裁决时确认只留必要一份。 |

### `src/collector-receipt.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 487 | keep | `if (new Set(candidateIds).size !== candidateIds.length) { fail("Collector output contains duplicate legId values"); }` | legId 是真实映射键，重复会覆盖 / 串腿并让某条腿的结论静默消失（ADR 0039 点名 Collector legId）。 |
| 490 | keep | `for (const id of configuredIds) { if (!candidateIds.includes(id)) { fail(`Collector output missing configured leg \"${id}\"`); } }` | 必需覆盖：配置腿缺结论就是静默漏判，不是「额外字段」问题。 |
| 513 | keep | `for (const ref of evidenceRefs) { const record = ledger.getEvidence(ref); const snapshotRef = ledger.getSnapshot(ref); if (record === undefined && sna` | 引用目标必须真实存在，否则回执会带着解析不到的证据 ID 出具结论。 |
| 761 | keep | `const resolveRef = (ref: string, label: string) => { ... if (inEvidence && inSnapshot) fail(`... is ambiguous`); if (!inEvidence && !inSnapshot) fail(` | 回执自足性：leg/report 引用必须能在回执内解析到唯一目标，否则下游拿到的是悬空证据引用（ADR 0039 保留引用存在性）。 |

### `src/collector-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 534 | shrink | `const preExisting = pi.getAllTools(); for (const required of COLLECTOR_REQUIRED_TOOLS) { const prior = preExisting.filter((tool) => tool.name === requ` | Tool-name collision is a real dispatch key worth keeping, but the same invariant is asserted three times (pre-register scan at 534, post-register scan at 544, active-surface scan at 566); one post-registration check on the active surface covers it. |

### `src/merger-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 39 | delete | `if (new Set(paths).size !== paths.length \|\| ...) fail(`Merger ${label} must be unique and canonical byte-sorted`);` | expectedConflictPaths/resolutionScope 只是普通数组，不是 consumer 建表的键，重复对集合语义无害，ADR 0039 判删。 |
| 62 | delete | `names.add(check.name as string);（配合 L59 const names = new Set<string>()）` | ADR 0039 逐字点名「check 名称等重复不再拒绝」——authorizedChecks 不是 consumer 建表的键，只是顺序执行清单。 |

### `src/merger-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 65 | keep | `for (const name of MERGER_ACTIVE_TOOLS) if (all.filter(item => item === name).length !== 1) throw new Error(`Merger required tool collision or missing` | 工具名是 Pi 注册表的真实查找键，重名会导致调用歧义、缺失会让角色无法交卷；属真实 key 唯一性（且这是宿主状态而非输入数据）。 |

### `src/navigator-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 34 | keep | `new Set(children.map(c=>c.id)).size!==children.length` | [#58 不改，defer→#28] child.id 全仓无 consumer 建表/查找/归属（grep 只在本校验里出现），不满足 ADR 0039 的真实键条件；#28 处置应删，evidence id 唯一性才是真键。 |
| 34 | keep | `if(new Set(evidence.map(x=>x.id)).size!==evidence.length)fail("duplicate evidence id")` | evidence id 是真实映射键（NavigatorEvidenceStore 的 Map 键、evidenceRead 记录键、primary.evidenceIds 引用目标），ADR 0039 点名保留；但与 navigator-evidence.ts:8 的同一条去重是重复实施，#28 应收成一处。 |
| 38 | keep | `if(cited.some(x=>!snapshot.evidence.some(e=>e.id===x)\|\|!actualById.has(x)))fail("evidence citation")` | 引用目标存在性（引用的 evidence 必须是被 admit 且真的读过的那条）是 ADR 0039 点名保留的真实引用绑定，也是「建议必须落在真实证据上」的 K3 面。 |

### `src/navigator-evidence.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 8 | keep | `if(this.#byId.has(item.id))throw new Error("duplicate evidence id"); … const source=handles.get(item.handle);if(!source)throw new Error(`missing evide` | evidence id 是本 Map 的真实键、handle 是真的要拿来读字节的引用目标，符合 K5/K6 保留；但与 navigator-contracts.ts:34 的同一条去重重复，#28 应留一处。 |

### `src/package-contracts/fixer-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 81 | needs-adjudication | `if (names.has(item.name)) fail("classResults name unique constraint");` | Two horns: class name is how a caller attributes each settlement back to a Judge finding class (real reference target), but no code consumer builds a table on it and the name is model-invented, not a typed input, which puts it near ADR 0039's excluded '展示名称'. |
| 95 | delete | `if (commits.has(item.commitSha)) fail("classResults completed commitSha distinct constraint");` | No consumer indexes or looks up by per-class commitSha (acceptedFacts only reads top-level); one-commit-per-class is a method law for the Fixer auditor, not a reference-integrity key, so ADR 0039's keep-exception does not apply. |

### `src/package-contracts/navigator-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 14 | keep | `if(!Array.isArray(p.evidenceIds)\|\|!p.evidenceIds.includes(d.evidenceId)\|\|reads.get(String(d.evidenceId))!==true)fail("defect evidence citation inv` | defect 必须引用一条真被读过的证据是真实引用绑定（K5/K3）；但同一规则在 navigator-contracts.ts:38 又实施一次，#28 应收成一处。 |

### `src/reviewer-admission.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 44 | shrink | `if(!unique(materials.map(x=>x.id))\|\|!unique(materials.map(x=>x.repositoryPath.normalize("NFC")))) fail("material-invalid", ...)` | 保留 id 唯一（bundle entry 与 prompt 引用按 id 建表，重复会串腿覆盖，ADR 0039）；删除 repositoryPath 的 NFC 归一唯一性——NFC 归一是 D2 表现形式法条，且同一路径出现两次不产生引用歧义。 |

### `src/reviewer-pinned-git.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 52 | delete | `new Set(readRange!.commits).size!==readRange!.commits.length` | ADR 0039：唯一性只留给真实映射键/引用目标。commits 只是 rev-list 的顺序数组，没有 consumer 按 commit 建表或查找，重复不会覆盖任何东西。 |

### `src/role-runtime.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 464 | shrink | `if (knownNames.includes(definition.name) && !navigatorRegisteredTools.has(definition.name)) { throw ... } ... if (installedNames.filter((installed) =>` | Tool name is the real dispatch key, so collision rejection is a legitimate uniqueness keep, but the pre-register check and the post-install recount are two layers of the same law; keep one. |

### `test/class-contracts.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 28 | keep | `classes: [judgeClass, { ...judgeClass }]` | class name 是 Fixer 逐类结算与 Reviewer scope key 的真实引用目标，重名会串腿归属。 |

### `test/collector-config.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 246 | keep | `["dup-id",{legs:[{id:"a",...},{id:"a",...}]},/id\|duplicate/i], ["overlap-authors",{legs:[{expectedAuthors:["shared"]},{expectedAuthors:["Shared"]}]}]` | legId 是 consumer 真实建表/归属的键，跨 leg author 重叠会把同一条证据串腿归错 leg——ADR 0039 保留例外。 |
| 255 | needs-adjudication | `["dup-author-case",{version:1,legs:[{id:"a",expectedAuthors:["Bot","bot"]}]},/author\|duplicate/i]` | 同一 leg 内作者重复不会造成引用歧义或覆盖（归一后是同一集合成员），按 ADR 0039 属「普通数组重复不再拒绝」；但它与保留的跨 leg overlap 检查共用同一段归一逻辑，需裁决是否一并放宽。 |

### `test/collector-ledger.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 996 | keep | `test("digest mutation flips versionId for enumerated stored fields") assert.notEqual(a.versionId,b.versionId)` | versionId 是证据版本的真实引用键，consumer 按它判断「同一版本」与历史归属；重复/错认会误归证据。 |

### `test/collector-receipt.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 2529 | keep | `assert.throws(()=>buildCollectorReceipt(facade,{legs:[...]},clock),/evidenceId collision/i)` | evidenceId 是回执引用的真实目标，碰撞会让 leg 引到错误证据；ADR 0039 保留例外。snapshotId（:2579）与跨命名空间歧义（:2631）同理。 |

### `test/fixer-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 71 | keep | `["apply", { status: "completed", report: "x", classResults: [completed("A"), completed("A", shaB)] }],` | classResults.name 是逐类结算的真实归属键，重名会让同一 class 有两份互相覆盖的结算。 |

### `test/fixer-prerequisite-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 83 | keep | `[JSON.stringify([{ id: "Same", ... }, { id: "Same", ... }]), /duplicate.*id/],` | prerequisiteId 是 Fixer 输出 blocker 的真实引用目标，重复会造成引用歧义。 |
| 85 | keep | `assert.doesNotThrow(() => parseFixerPrerequisites(JSON.stringify([{ id: "Same", ...}, { id: "same", ...}])));` | 正向断言"不做大小写归一"，与 D2 删除方向一致，是有价值的反归一化护线。 |
| 122 | keep | `{ cause: "prerequisite_unmet", prerequisiteId: "undeclared", evidence: "not declared" },` | 引用不存在的 prerequisite 是真实引用目标缺失，必须拒；L139-141 的零声明用例同样保留。 |

### `test/reviewer-construction-seams.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 14 | keep | `test("mechanical admission accepts presentation extras and advisory dangling hints while preserving identity constraints")` | 这是 D1 放宽后的正向案（额外呈现字段被接受）+ 真实键重复被拒的负向案，正是清扫后应有的形态。 |

### `test/reviewer-dispatch.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 19 | keep | `assert.equal((await duplicate.dispatcher.propose({...proposal,materials:[proposal.materials[0]!,proposal.materials[0]!]})).status,"rejected"); drift →` | material id 是 bundle 里的真实映射键（重复会覆盖 clone 目标），target drift 属实时目标绑定；两者都是保留例外。 |

## K6 外部数据最小解析（29）

### `src/collector-config.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 136 | keep | `const owner = ownerDisplay.toLowerCase(); const repo = repoDisplay.toLowerCase(); return { display, canonical: `${owner}/${repo}`, owner, repo };` | GitHub owner/repo are case-insensitive external identity, so a single canonicalization keeps one target identity across path building and receipt — and it rejects nothing. |
| 400 | keep | `// GitHub login comparison is ASCII-lowercase; reject empty after trim already done\n  return trimmed.toLowerCase();` | GitHub logins are case-insensitive external semantics; dropping this canonicalization would split one reviewer into two identities (known-pitfall carve-out). |
| 489 | keep | `text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("Collector leg manifest must be UTF-8 JSON"); }` | Exactly one strict UTF-8 decode of externally supplied bytes, which is the retained shape under ADR 0029 (no re-encode identity check is performed here). |

### `src/collector-github.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 140 | keep | `function requireString(value: unknown, label: string): string { if (typeof value !== "string") throw new Error(`GitHub payload missing string ${label}` | Consumer-driven minimal extraction of untrusted GitHub payloads that ignores unknown fields and preserves the real tombstoned-author case — the retained shape under ADR 0043. |
| 204 | shrink | `const htmlUrl = typeof raw["html_url"] === "string" ? raw["html_url"] : `https://github.com/unknown/unknown/pull/${number}`;` | When GitHub supplies no html_url the parser invents a fake URL that then travels into evidence as if observed; either require it (it is always present on real PRs) or leave it absent, never fabricate. |
| 340 | keep | `const match = stdout.match(/^HTTP\/[\d.]+\s+(\d+)[^\n]*\r?\n([\s\S]*?)\r?\n\r?\n([\s\S]*)$/); ... const name = line.slice(0, idx).trim().toLowerCase()` | Minimal extraction of status/headers/body from `gh api --include` output, and HTTP header names are genuinely case-insensitive so the lowercase key is external semantics, not presentation law. |
| 422 | keep | `if (response.status === 429) { throw Object.assign(new Error(`GitHub API rate limited on ${nextPath} (HTTP 429)`), { githubStatus: 429, page: diagnost` | Real transport failure must not be laundered into 'no reviews found'; the status branch is the honest-failure seam, not format law. |
| 435 | keep | `const parsed = parseJson(response.bodyText, nextPath); if (!Array.isArray(parsed)) { throw new Error(`GitHub API ${nextPath} did not return a JSON arr` | The consumer maps over a list; a non-array body would silently become zero evidence and misclassify legs as missing. |
| 451 | delete | `if (url.hostname !== "api.github.com" && url.hostname !== "github.com") { throw new Error(`unexpected pagination host ${url.hostname}`); } nextPath = ` | The host is discarded anyway (only pathname+search is used, and gh api pins --hostname github.com), so the allowlist rejects data it never consumes; the /api/v3 GHES rewrite below it is likewise an unreachable branch on a github.com-pinned transport. |

### `src/collector-ledger.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 736 | keep | `requesterLogin = user.login.toLowerCase();` | GitHub 用户名大小写不敏感是外部真实语义，删了会把同一作者判成两个人；属外部数据的最小 consumer 驱动解析。 |

### `src/doctor-evidence.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 18 | keep | `try { const row: unknown = JSON.parse(line); if (!record(row)) { degradationReasons.push(...); break; } rows.push(row); } catch (error) { if (error in` | 外部 JSONL 的容错解析：坏尾巴记 degradationReason 并停止消费、不整案 fail-closed，未识别异常照抛，符合 K6 与失败诚实宪法。 |
| 25 | shrink | `let details; try { details = validateAcceptedDetails(message.toolName, message.details); } catch (error) { if (error instanceof AcceptedDetailsContrac` | 消费外部 Pi JSONL 时对别人角色的整张回执做全 shape 校验，实际只用 acceptedFacts 的 status/commit（design.md 已把 acceptedFacts 定为「Doctor session consumer 的薄投影」）；应薄取必需字段，未知/多余字段忽略。catch 只吞契约错误、其余照抛的诚实降级保留。 |

### `src/exact-utf8.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 6 | keep | `try { text = decoder.decode(bytes); } catch { throw new Error(`${label} is not valid UTF-8`); }` | One strict UTF-8 decode is the minimum required to read external bytes as text (ADR 0029 keeps exactly this); the function should shrink to this and be renamed off "exact". |

### `src/merger-git-state.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 34 | keep | `if (tab < 0 \|\| tab === row.length - 1) throw new Error("Git returned a malformed unmerged index row");` | ADR 0043 的外部数据最小解析：拿不到 tab 后的路径就是没读懂 git ls-files -u 输出，不拒绝会把「没读懂」伪装成「无冲突」。 |

### `src/navigator-evidence.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 8 | keep | `try{content=new TextDecoder("utf-8",{fatal:true}).decode(slice)}catch{throw new Error("evidence page is not valid UTF-8")}` | ADR 0029 保留形态：外部字节确实要当文本读时，只做一次严格 UTF-8 解码、不回编码比对；现状已是最小形式。 |

### `src/package-contracts/collector-output.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 446 | shrink | `export function validateAcceptedCollectorReceipt(value: unknown): CollectorReceipt {` | Sole call site is validateAcceptedDetails (terminating-tools.ts:145), whose only surviving consumer doctor-evidence.ts calls acceptedFacts, and acceptedFacts returns `{}` for COLLECTOR_OUTPUT_TOOL — zero fields consumed, so this 400-line recursive validator should shrink to the minimal 'is this a Collector receipt' gate plus the K3 target/window binding. |

### `src/package-contracts/terminating-tools.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 130 | shrink | `export function validateAcceptedDetails(toolName, details) { ... case CODER_OUTPUT_TOOL_NAME: return validateAcceptedWorkerDetails(details, "Coder"); ` | src/doctor-evidence.ts runs this full per-role shape validator over Pi session JSONL only to obtain {status, commit}; ADR 0043 wants minimal consumer-driven extraction of the fields actually used, not a full external mirror. |

### `src/reviewer-git-snapshot.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 15 | shrink | `if (fields.length !== 5 \|\| !fields[0] \|\| !fields[1] \|\| !fields[3]) throw new Error(`Malformed Git ref snapshot line: ${line}`);` | 解析外部 git 输出应只提取当前 consumer 必需的字段（refname/objectname/objecttype 及 peel 两列），`fields.length !== 5` 的精确列数是闭合形状法条，去掉即可。 |

### `test/audit-failure-subprocess.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 219 | keep | `test("fatal Judge audit infrastructure failure aborts print and JSON CLI actions", ... assert.doesNotMatch(result.stdout, /Judge verdict accepted/); .` | 真实子进程里"基础设施失败必须响亮中止、绝不留下 accepted 回执"，是失败诚实宪法的贯穿覆盖，闸类负向不可删。 |
| 279 | keep | `assert.equal(outputResults.some((event) => event.message.details?.status !== undefined), false, `${fixture}/${mode} does not encode infrastructure as ` | "不把基础设施失败洗成业务 status"正是失败诚实宪法的核心断言。 |

### `test/collector-config.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 45 | shrink | `const owner39="a".repeat(39); assert.throws(()=>parseCollectorRepository(`${"a".repeat(40)}/b`),/owner/); assert.equal(mixed.canonical,"octocat/hello-` | canonical 小写保留（GitHub owner/repo 大小写不敏感是外部真实语义，且 canonical 被 collector-role/receipt/ledger 真实消费）；39/100 字符长度上限是包内复刻的展示格式限制，属 D4/D2 删除。 |

### `test/collector-github.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 122 | keep | `assert.throws(()=>normalizePullRequest({number:1,state:"open",head:{}}),/head\.sha/)` | 外部 payload 缺 head.sha 时 consumer 无法确定 target HEAD，属最小 consumer 驱动解析的必需字段（ADR 0043）。 |
| 563 | keep | `test("R6 non-null user shapes fail closed on review/issue comment/review comment") missingLogin=/GitHub payload missing user\.login/` | author 归属是 Collector 的必需事实；不解析会把「没读懂外部数据」伪装成业务事实（ADR 0043）。 |
| 618 | keep | `assert.deepEqual(record.raw,{login:"collector-bot",id:42}); assert.equal(JSON.stringify(record.raw).includes("secret@example.com"),false)` | 只提取 consumer 必需字段、忽略其余，正是 ADR 0043 要求的形态；login 小写归一属 GitHub 外部语义保留。 |

### `test/fixer-prerequisite-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 78 | keep | `["{", /JSON/], [JSON.stringify({ prerequisites: [] }), /array/],` | prerequisites 文件是外部输入，最小解析（能否 JSON 解出、是不是数组）必须保留，否则"没读懂"会伪装成业务事实。 |
| 88 | shrink | `test("malformed prerequisite attachments keep their true causes behind one stable typed identity", ... assert.match(named.message, /prerequisites or i` | typed identity + cause 保留（失败诚实宪法与 activation barrier 消费 AK_INVALID_FIX_PACKET）；对错误消息措辞的 match 断言是锚定，删。 |

### `test/judge-posture-recordings.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 33 | keep | `const NEUTRAL_INPUT_DENYLIST = [/expected\s*[:=]\s*["']?(converged\|continue\|escalate)/i, ... /\br-block\b/i, ...]` | 这是对录制输入"未被喂答案"的中立性证明，被测对象是测试自己拥有的夹具输入，不是产品自由文本；配套的 L859/L900/L946 三条反例保留。 |

### `test/judge-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1039 | keep | `test("Fixer activation rejects malformed typed prerequisite attachments before any agent work", ... assert.equal(audits, 0)` | 外部 packet 解析失败必须在任何模型工作前 fail-closed；`audits === 0` 是可观察的"没有脱笼"证据。 |

### `test/pi-test-harness.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 21 | keep | `test("subprocess timeouts are explicit instead of looking like natural no-code closes", ... assert.equal(result.timedOut, true)` | 子进程超时不得伪装成自然结束，属失败诚实宪法的贯穿覆盖。 |

## K8 canonical Skill 展开绑定（13）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 153 | keep | `A `completed` receipt is rejected unless the immediately following prompt proves Pi's exact native expansion of the complete canonical TDD Skill and o` | canonical Skill 展开绑定按 ADR 0032 保留；只需确保其实现不再带文本长度/摘要身份壳（ADR 0031）。 |

### `src/canonical-skill-binding.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 59 | keep | `const body = stripFrontmatter(raw).trim(); if (body.length === 0) { throw new Error(`Canonical ${name} Skill is empty at ${path}`); }` | Non-empty required content: an empty canonical Skill makes the expansion binding vacuous, so this is a required-field check, not a format law. |
| 77 | keep | `const matchedPath = parsed?.location === configuredPath ? configuredPath : parsed?.location === snapshot.path ? snapshot.path : undefined;` | Binds the captured expansion to the actual canonical Skill file (pre- or post-realpath); ADR 0032 keeps proof that Pi expanded the required Skill. |
| 91 | keep | `const userMessage = parsed?.userMessage ?? ""; if (parsed?.name !== name \|\| ... \|\| userMessage !== originalRequest) { return undefined; }` | Name match plus original-task preservation is the substance of the K8 binding (rejection reaches the completion path at src/reviewer-role.ts:206 and src/worker-role.ts:380). |

### `src/reviewer-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 127 | keep | `if (loaded.name !== "code-review") throw new Error("Canonical Skill binding loader returned tdd for code-review");` | ADR 0032 保留 canonical Skill 绑定：装错 Skill 会让 Reviewer 依据错误方法出具评审。 |
| 206 | keep | `if (output.status === "completed" && !expansionCaptured) throw new Error("Reviewer completed requires canonical Skill expansion capture");` | ADR 0032 保留：完成路径必须证明 Pi 实际展开了 canonical code-review Skill 且保留原始任务（配合 L231 captureExpansion）。 |

### `src/reviewer-settlement.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 42 | shrink | `canonicalSkill: { sha256: snapshotIdentity.sha256, utf8Length: snapshotIdentity.utf8Length, snapshotIdentity },` | canonical Skill 展开绑定按 ADR 0032 保留，但只需保留 Skill 文本本身；sha256/utf8Length 与内层 snapshotIdentity 完全重复（同一事实存了三份），随 ADR 0031 删除。 |

### `src/worker-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 340 | keep | `if (loaded.name !== "tdd") { throw new Error("Canonical Skill binding loader returned code-review for tdd"); }` | Binds the loaded binding to the requested canonical Skill; wrong binding would let the wrong method be certified. |
| 378 | keep | `if (phase === "apply" && output.status === "completed" && !expansionCaptured) { throw new Error("Coder completed requires the Matt tdd skill to be exp` | Canonical Skill expansion binding on the Coder completion path is an explicit keep class; it proves Pi actually expanded the canonical Skill. |

### `test/canonical-skill-binding.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 126 | keep | `test("canonical binding proves only the complete native expansion", ... rejected = [ ... exact.replace(path, "/alternate/code-review/SKILL.md"), ... ]` | ADR 0032 明确保留：完成路径必须证明 Pi 真的展开了 canonical Skill 并原样保留 original task。这些负向案是该闸门的本体。 |
| 171 | keep | `test("canonical binding fails closed for unavailable and empty Skills", ... /Canonical tdd Skill is unavailable/` | Skill 不可用时 fail-closed，是 K8 绑定的失败面；audit-failure-subprocess.test.ts:252 在真实子进程复核同一条。 |

### `test/judge-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 840 | keep | `test("coder apply binds completion to the immediately following canonical tdd expansion", ... malformedPrompts = [ ... ] ... /completed requires the M` | ADR 0032 保留的 canonical Skill 展开绑定，负向案是闸门本体，不可删。 |

### `test/reviewer-package-lifecycle.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 136 | keep | `assert.match(userText(parent),new RegExp(`<skill name="code-review" location="...">`)); assert.ok(userText(parent).includes(stripFrontmatter(skillRaw)` | ADR 0032 明确保留 canonical Skill 展开绑定：必须证明 Pi 真的展开了要求的 Skill 内容并保留原始任务。 |

## UNCLEAR 未归类（31）

### `README.md`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 120 | needs-adjudication | `before a `bash` tool executes, the package inspects only the string `command` and blocks when it case-sensitively contains any one of these exact ASCI` | 确实按字面拼写拒绝工具输入（形式上像 D2 盯文），但它不是输入输出契约而是不可逆破坏护栏，后果重且无下游兜底；存废需 owner 裁决。 |

### `schemas/navigator-receipt-v1.schema.json`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 1 | keep | `{"title":"NavigatorReceiptV1","additionalProperties":false,"required":["version","status","runId",...],"runId":{"pattern":"^[0-9a-f]{8}-...-7[0-9a-f]{` | 同类实例密集（约 30 处 additionalProperties:false、uuidv7/64-hex/40-or-64-hex 拼写正则、version const 1、9007199254740991 上限），但整份属 Navigator，按 ADR 0020/0026-0030/0035/0045 明确 deferral 到 #28；记录为有理由的范围例外，不是默认保留，#58 不得改。 |

### `src/canonical-skill-binding.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 83 | needs-adjudication | `const expectedContent = matchedPath === undefined ? undefined : `References are relative to ${dirname(matchedPath)}.\n\n${snapshot.body}`; ... if (...` | Two-horned: ADR 0032 keeps the expansion binding, but the equality target locally re-implements Pi's own render string (agent-session.js:962 `References are relative to ${skill.baseDir}.\n\n${body}` plus the stripFrontmatter().trim() at line 58) — a mechanical dependency on upstream free-text presentation and a DRY duplicate of upstream formatting; shrinking to "expansion contains the canonical bo |

### `src/collector-github.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 356 | needs-adjudication | `if (code === 0) { resolve({ status: 200, headers: {}, bodyText: stdout }); return; }` | Not a rejection but its inverse: an unparseable response with exit 0 is fabricated into HTTP 200 with empty headers, so a lost Link header reads as a complete single page and unseen reviews classify as missing — deleting versus tightening this touches evidence completeness, so it needs owner routing rather than a sweep verdict. |

### `src/collector-receipt.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 650 | needs-adjudication | `for (const ref of evidenceRefs) { if (!missingCiteAllowed({ ref, ledger, legId, expected, finalSnapshot })) { fail(`Collector missing leg ... cites di` | 两难：一方面 missing 不授权任何执行，refs 已被 L513 要求存在、被 L761 要求在回执内解析，且真正的证明由 collectMissingProofRefs 自动补齐——allow-list 属「只验证必须有的」之外的额外限制；另一方面它确实防止 missing 腿把无关作者的评审当作己方证据出具。请 owner 裁 K3-保留 还是 D-删除。 |

### `src/collector-tool-schemas.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 6 | needs-adjudication | `const nonBlankString = Type.String({ minLength: 1, pattern: "\\S" });` | Two readings: `\S` is the honest non-empty test for a rationale (a whitespace-only rationale says nothing → keep as required-non-empty), or it is a whitespace-presentation law on free text (→ D2, keep only minLength:1). Same tension at collector-output.ts:481 `value.repository.trim() === ""`. |
| 61 | needs-adjudication | `evidenceRefs: Type.Array(nonEmptyString, { minItems: 1 })   // missing leg` | For missing legs the runtime auto-collects proof refs and injects finalSnapshot.snapshotId itself (src/collector-receipt.ts:665-680), so minItems:1 may be a rejection with no remaining consumer — but the Collector owner should confirm whether a model cite is still required for the missing classification. |

### `src/doctor-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 16 | needs-adjudication | `const active = pi.getActiveTools?.() ?? required; if (active.length !== 2 \|\| !required.every((name) => active.includes(name))) throw new Error("Doct` | 不校验任何模型/外部数据，只是刚调完 setActiveTools 再回读自证，且带 length !== 2 精确计数；同形状代码另有两份（src/merger-role.ts:67-68、src/role-runtime.ts:491-493）。删是工厂级一致决定，不宜 doctor 本地单删。 |

### `src/merger-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 57 | needs-adjudication | `\|\| !state.worktreeClean \|\|` | worktreeClean 由 merger-git-state.ts:56/61 用 `--untracked-files=all` 定义，任何未跟踪的临时文件都会把一次合法完成判死；两难在于「解决已全部提交」的证据 vs 对无害残留文件的过度严格，建议 owner 拍是否收成「无未合并路径 + 无已跟踪改动」。 |

### `src/navigator-contracts.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 34 | needs-adjudication | `const labelPolicy=…;if(new Set(labelPolicy.map(x=>x.labelId)).size!==labelPolicy.length)fail("label policy")` | labelPolicy 语义上是 labelId→meaning 查找表（重复即一个标签两种含义），但代码里没有任何 consumer 真的建表，只是整块 JSON 塞给模型；ADR 0039 的「真正按字段建表/查找」是否覆盖「模型作为 consumer」需裁决。 |

### `src/reviewer-pinned-git.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 112 | needs-adjudication | `if (typeof (error as {code?:unknown}).code === "number" && /Needed a single revision\|unknown revision\|bad object\|not a valid object name/i.test(std` | 三处（line 112/126/167）用 git 人类可读 stderr 的正则来决定「可纠正拒绝 vs 上抛致命」，是对自由文本的机械依赖（锚定宪法），但它拒绝的不是输入格式而是错误分类；#58 是否管这类接缝需 owner 拍。 |

### `src/worker-role.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 37 | needs-adjudication | `const FIXER_BASH_FORBIDDEN_LITERALS = ["rm -rf", "git reset --hard", "git clean", "git checkout --"] ... pi.on("tool_call", ...) => { block: true, rea` | It does reject model output by free-text substring match (which the anchoring constitution disfavors), but it is a destructive-operation capability guard at a real execution seam rather than a data-format contract; none of D1-D6 fit and deleting it would remove the only mechanical guard on irreversible worker commands. |

### `test/audit-failure-subprocess.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 53 | needs-adjudication | `const runDirectory = resolve(packageRoot, `.ak/work/issues/44/runs/audit-failure-subprocess-${mode}`); ... await writeFile(resolve(runDirectory, "stde` | 测试往真实仓库树 .ak/work 里写产物（invocation.json / stderr.log），不是格式契约问题，但会污染工作树并可能被 Doctor 当成真实病例读到。附带上报，供决定是否改到临时目录。 |

### `test/canonical-json.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 32 | needs-adjudication | `test("canonical JSON does not relabel unexpected proxy and property failures"` | 失败诚实覆盖，但只有 canonical-json.ts 存活才有意义。该模块生产侧仅剩 Navigator（#28 deferral）与 assisted（整删）；Doctor 改直接比对后可能整模块删。需与模块存废一并裁决。 |

### `test/class-contracts.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 27 | needs-adjudication | `classes: [{ ...judgeClass, name: "bad,key" }]` | class name 禁逗号是因为 --ak-review-scope-keys 用逗号分隔；既像 D2 表现形式法条，又像真实引用语法约束。删则 scope key 解析歧义，留则违反默认删除。需裁决。 |

### `test/collector-config.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 307 | keep | `assert.equal("createGitHubTransport" in (await import("../src/collector-config.ts")), false);` | 不产生数据拒绝行为，是模块纯度断言；扫到过，判为不在类内。 |

### `test/collector-github.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 68 | keep | `assert.equal(args[0],"api");assert.equal(args[1],"--hostname");assert.equal(args[2],"github.com")` | 断言的是命令构造而非数据拒绝；扫到过，判为不在类内。 |

### `test/collector-package-lifecycle.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 246 | needs-adjudication | `assert.match(result.stdout,/forbids every Skill/i); assert.match(result.stdout,/late hostile sibling-extension/i); assert.match(result.stdout,/not a s` | 不是数据拒绝，但违反锚定宪法（对 --help 自由文本建机械正则依赖）。#58 类别外，建议单列为盯文测试处置。 |

### `test/collector-soul.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 10 | needs-adjudication | `assert.match(soul,/证据收集\|evidence collector\|收集/i); assert.doesNotMatch(soul,/15.?minute\|900000\|8 MiB\|32 MiB\|manifestDigest/i)` | 纯盯文测试（对 Soul 自由文本建正则依赖），不在拒绝行为类内；但其中 /8 MiB\|32 MiB/ 的负向断言会在上限删除后变成永真断言，需一并处置。 |

### `test/doctor-case.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 18 | needs-adjudication | `assert.match(soul, /保留工作.*成本/); assert.match(soul, /开方.*(?:工厂\|资产)/); assert.match(soul, /(?:证据\|举证)/);` | 对 souls/doctor.md 自由散文建正则机械依赖，违反锚定宪法；且 Soul 走 owner 直改通道，测试钉死措辞等于用工厂锁住宪法修订。是否属 #58 范围需裁决（同 judge-soul.test.ts 全文）。 |

### `test/doctor-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 20 | needs-adjudication | `await assert.rejects(output.execute("doctor", { ...testimony, cost: patient.cost }, ...), /closed contract/);` | 模型提交里带 cost 被拒＝闭合对象拒绝（ADR 0025 应删），但 ADR 0042 的"事实由 runtime 拥有、模型不得自报运行事实"又靠它兜。runtime 反正会覆写 cost，拒绝是否必要须裁决；doctor-case.test.ts:53 是同一条。 |

### `test/fixer-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 72 | needs-adjudication | `["apply", { status: "completed", report: "x", classResults: [completed("A"), completed("B", shaA)] }],` | 两个 class 在同一 commit 结算被拒。#59 批准的是 per-class commitSha 字段本身，不必然包含 distinct 唯一性法；按 ADR 0039，commit 是证据不是映射键，重复不该拒绝。需 owner 确认 #59 语义是否含 distinct。 |

### `test/judge-soul.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 10 | needs-adjudication | `assert.match(soul, /仅从本次提交的材料\|materials only\|from (the )?supplied materials/i); ... assert.doesNotMatch(soul, /最多\s*\d+\s*轮\|retry\s*cap/i)` | 整个文件（8 个 test，含 L76-111 的 30+ 条 doesNotMatch 措辞黑名单）对 souls/judge.md 自由散文建正则机械依赖，违反锚定宪法；且 CLAUDE.md 规定 Soul 走 owner 直改通道、工厂不拥有动笔权，测试钉死措辞会把修订通道锁死。是否属 #58 范围需 owner 裁决。L108 的 /judgeStatus\|decisionGate\|fix\.summary/ 还把 Soul 测试耦合到 schema 字段名。 |

### `test/merger-contract.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 33 | needs-adjudication | `assert.throws(() => validateMergerInput({ ...valid(), expectedConflictPaths: ["a.txt", "a.txt"] }), /canonical/);` | 路径集重复被拒。路径是引用目标（对照实时 unmergedPaths），但重复本身按集合语义无害；按 ADR 0039 属"普通数组重复不再拒绝"。与同一行的排序法条耦合，需拆开裁决。 |

### `test/reviewer-auditor.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 72 | needs-adjudication | `assert.match(seen?.systemPrompt ?? "",/not a second substantive reviewer/i); assert.match(...,/Never apply source allowlists, parse prose mechanically` | 六条对 system prompt 自由文本的措辞正则，违反锚定宪法；不属拒绝类，建议单列处置。 |

### `test/reviewer-dispatch.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 17 | needs-adjudication | `assert.match(standards!.prompt.text,/Answer only the canonical Standards question/); assert.match(leg.prompt.text,/bytes are preserved verbatim; no he` | 对生成提示词自由文本的措辞正则依赖，违反锚定宪法；不属 #58 拒绝类，建议单列。 |

### `test/reviewer-package-lifecycle.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 61 | needs-adjudication | `assert.match(packagedReadme,/reviewerProposalSchema/); assert.doesNotMatch(packagedReadme,/standardsMaterials.*may be empty\|preflight\.git\.pin-targe` | 对打包 README 自由文本的正则依赖（锚定宪法），且 ADR 0022 的同型裁决是「README 不得升级为第二法源」；建议随文档面一并处置。 |

### `test/reviewer-role.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 79 | needs-adjudication | `{ expected: /base\.revision must be a nonempty string/ } ... assert.match(result.content[0].text,row.expected)` | 对自由文本诊断建正则依赖（锚定宪法）；同文件 :135 已有 `assert.deepEqual(result.details.violations,[row.code])` 的 typed 断言，可作为真源。非 #58 拒绝类，但与本轮清扫同批处置更省事。 |

### `test/reviewer-soul.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 10 | needs-adjudication | `assert.match(soul,/authority/); assert.doesNotMatch(soul,/Agent\|ak_reviewer_output\|completed\|refused/)` | 纯盯文 Soul 测试，不在拒绝行为类内；与 collector-soul.test.ts 同批处置。 |

### `test/soul-auditor.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 144 | needs-adjudication | `test("Pi soul auditor requires exactly one decision call", ... auditResponse(), auditResponse(pass, revise), decisionWithExtraCall` | 零决策/双决策必须留（两份矛盾决策不能被静默取第一条）；第三例"决策+其他工具"防的是不可能输入（审计上下文只挂了唯一一个工具），是否随 ADR 0041 的 sole-final 理由类推保留需裁决。 |

### `test/terminating-tools.test.ts`

| 行 | 处置 | 证据 | 理由 |
| --- | --- | --- | --- |
| 13 | needs-adjudication | `const hostileDetails = new Proxy({}, { ownKeys() { throw failure; } }); assert.throws(() => validateAcceptedDetails("ak_coder_output", hostileDetails)` | 该探针靠 exact() 里的 Object.keys 触发 ownKeys trap。闭合键集一删，validator 不再枚举键，探针失去触发点，失败诚实宪法（不冒用具体标签）就没有任何覆盖。需要换一个仍然存在的意外失败注入点。 |

---

## 对抗性复核

### 对抗性补漏：未被 751 条清单覆盖的源文件与拒绝类别

## 确认漏掉的整文件（清单里零条 finding）

1. **`src/compliance-transport.ts`（201 行）** —— 最大的漏。它是 soul / fixer / reviewer / doctor / navigator 五个 auditor 共用的合规裁决真源：决策工具 schema（闭合对象）、精确两键校验、pass/revise 与 violations 的交叉法条、唯一决策调用判据全在这里。清单里所有关于 auditor 决策的条目（`test/soul-auditor.test.ts:124/128/130`、`test/fixer-auditor.test.ts:26/27/28`）都只咬到测试断言，从未指向真源。删 ADR 0033 相关法条时如果只改测试不改这个文件，五个角色的运行时行为一条都不会变。

2. **`src/package-contracts/fixer-packet.ts`（93 行）** —— schema + 手写同构 `parseFailure` 双份 validator，加 id 拼写正则、闭合键、重复 id。清单只有 `test/fixer-prerequisite-contract.test.ts` 的若干条。

3. **`src/package-contracts/worker-output.ts`（48 行）** —— Coder 受理详情的真正执行处，含 ADR 0024 判删的 commitSha 存在性/非空/与 status 交叉三段。清单里 Coder commitSha 相关条目全落在 `src/worker-role.ts:55`（schema 字段）和测试上，实际抛错的分支没人记。

4. **`src/package-contracts/judge-output.ts`（140 行）** —— Judge 三分支受理真源（hasExactKeys ×5、逗号法条、name 去重、note 非空）。清单里 Judge 条目全在 `src/judge-role.ts` 和测试上，而 `judge-role.ts:99 validateVerdict` 只是转调这里。

## 类别体系的盲区（不是漏某一行，是漏一整类）

- **运行时能力面（工具面）的拒绝**：`getAllTools` 碰撞/缺失、`setActiveTools` 后的窄化核对、活跃工具面闭合集合、`tool.sourceInfo.path` 覆盖检测、ambient commands / skills / contextFiles / appendSystemPrompt 检测。形状与 D1（闭合集合）、K5（唯一性）完全一致，但对象是宿主能力而非 JSON 数据。清单被迫把它们散记成 K5/shrink、D2/shrink、K3/shrink、UNCLEAR，同一形状拿到四个不同判决。而且「必需工具恰好一份」这段逻辑在 collector-role/role-runtime/doctor-role/merger-role 各写一份共四份同构物，没有任何一条 finding 指出这是 DRY 违例。
- **运行环境前置条件的拒绝**：model undefined / provider not found / auth failed（compliance-transport.ts:67/73/154/168、reviewer-child-executor.ts:43/52）。会拒绝、会终止，但既非输入输出格式也非持久化数据，八个类别一个都套不上。
- **对包内常量字符串的逐字节相等拒绝**：`collector-role.ts:234` 的 fixed kickoff。既像 D2（咬呈现）又像 K1（fail-closed 判别），需 owner 裁。
- **「soul is empty / soul was not loaded」重复 8 处**（worker-role ×4、judge-role ×3、collector-role、doctor-role、merger-role、reviewer-role、role-runtime、soul-auditor）。清单只有 `D2/shrink src/doctor-role.ts:12` 一条。单看每处都是合理的必需非空检查，合看是同一形状的八份复制。我按「不为 N 条同根问题造 N 条 finding」的原则没有逐条列出，但整类值得一并处理。

## 扫到但判为不在类内

- `src/compliance-transport.ts:190` `maxTokens: 2048`、`cacheRetention: "none"`：截断生成参数，不产生拒绝。
- `src/reviewer-scope-prompt.ts`：`utf16-code-units-hex-v1` 编码制度纯输出侧，不拒绝任何输入。
- `src/reviewer-verification-policy.ts`、`src/uuidv7.ts`（生成侧）、`src/sha256.ts`、`src/git-object-id.ts:9 gitObjectIdWidth`：无拒绝分支（`git-object-id.ts:5/9` 的拒绝面清单已覆盖）。
- `src/navigator-auditor.ts` / `src/fixer-auditor.ts` / `src/reviewer-auditor.ts` / `src/soul-auditor.ts`：除 soul 非空外无自有拒绝，全部拒绝行为委托给 compliance-transport.ts。
- `test/helpers/*`、`test/fixtures/*`：只做故障注入，不含校验。

## 反向搜索覆盖范围

`Value.Check`（9 处，全部核对）、`Type.String/Integer/Array/Number` 的 minLength/pattern/format/minItems/minimum/maximum（60+ 处，逐一比对清单）、`Object.keys(...).length` 比较（10 处）、`new Set(...).size !==`（12 处）、非 `instanceof Error` 的 instanceof（10 处）、`throw new Error` 全量按文件枚举并与清单行号对账（collector-github 16 处、collector-role 22 处、worker-role 19 处、reviewer-role 13 处、reviewer-child-executor 6 处、reviewer-workspace 6 处、navigator-role 5 处、doctor-role 8 处）。test/ 下 57 个测试文件逐一核对，每个文件至少有一条清单条目，无整文件遗漏。

### Adjudication audit of the 751-item #58 finding list (mis-delete / mis-keep / scope-creep review)

越权加戏：逐条看下来没有发现提议新增机制、重建 canonicalizer、加配置化上限或把范围伸进 #28（Navigator）/ #11 的条目——Navigator 全部 D1/D2/D3/D5 都判 keep 并与 ADR 0045 的 deferral 一致，activation 只删 trace 保留 barrier，符合 ADR 0019。我上面第 1 条（canonical-json.ts:60）是唯一一处会**反向**踩进 Navigator 的风险点，但那是误删而非加戏。

复核过但判为原判正确、不列 finding 的高风险项：
- src/collector-ledger.ts:736 login.toLowerCase() 与 src/collector-config.ts:400 保持 K6/keep，正确（GitHub 用户名大小写不敏感）。
- Fixer per-class commitSha 字段本体在 fixer-output.ts:17 判 K3/keep，没有被当成 Coder 自报 commitSha 误删；被删的只是跨类唯一性（正确）。
- src/git-object-id.ts:9 gitObjectIdWidth / GitObjectFormat 判 D2/delete 正确：全仓 grep 无 importer（reviewer-pinned-git.ts:72 自己内联 oidWidth），是死导出；isFullGitObjectId 判 K3/keep 与 ADR 0027 一致。
- src/merger-contracts.ts:52 targetObjectId.length !== sourceObjectId.length 判 D2/delete 可接受：merger-role.ts:38（K3/keep）拿实时 git state 逐个比对，下游有兜底。
- src/collector-github.ts:451 pagination hostname 判 K6/delete 可接受：只取 pathname+search 回喂 apiGet，请求主机始终由 gh --hostname 固定，删除不产生 SSRF。
- src/reviewer-pinned-git.ts:148 / merger-git-state.ts:15 的 execFile maxBuffer 留 needs-adjudication 是对的（Node API 必填参数，不是自设契约上限）。

清单自身的两处形式问题（非错判，但会干扰施工）：src/reviewer-agent.ts:30 用 K 类（K1）配 delete 处置，K 类按定义是保留类，类别/处置矛盾；src/collector-tool-schemas.ts:6 同一行同时出现 K2/keep 与 UNCLEAR/needs-adjudication 两条重复条目。

### 补漏与纠判 finding（40）

| 类别 | 处置 | 位置 | 理由 |
| --- | --- | --- | --- |
| D1 | delete | `src/compliance-transport.ts:115` | 整个 src/compliance-transport.ts 未被清单覆盖；这是 5 个 auditor（soul/fixer/reviewer/doctor/navigator）共用的合规裁决闭合键集合，与 ADR 0033「compliance decisions only require fields needed by the status」直接冲突，未知字段不应参与本层校验。 |
| D1 | shrink | `src/compliance-transport.ts:40` | 共享 auditor 决策工具 schema 的 additionalProperties:false；清单只覆盖了各 auditor 测试对 additionalProperties/required 的断言（test/fixer-auditor.test.ts:26、test/soul-auditor.test.ts:128），从未指向唯一真源的这一行。 |
| K2 | shrink | `src/compliance-transport.ts:132` | pass 分支要求 violations 字段必须存在且为空数组，超出「按 status 才需要的字段」；pass 只需 status，revise 才需非空 violations（ADR 0033）。这是所有 auditor 决策的唯一真源，未被清单覆盖。 |
| K7 | keep | `src/compliance-transport.ts:96` | 共享的「合规裁决唯一一次调用」判据，属于 sole-final 保留范围；清单只有 test/soul-auditor.test.ts:144 的 UNCLEAR 测试条目，运行时真源未被记录。 |
| D5 | delete | `src/package-contracts/fixer-packet.ts:45` | 整个文件未被清单覆盖。Value.Check(fixerPrerequisitesSchema) 之后又手写一遍完全同构的逐字段 validator，纯粹为了造错误措辞——典型的第二份 shape validator，DRY 硬规则违例。 |
| D1 | delete | `src/package-contracts/fixer-packet.ts:52` | prerequisite entry 的精确键集合 + L9 的 additionalProperties:false，双重闭合对象；只需 id 与 requirement 存在即可，未知字段不该拒绝。 |
| D2 | delete | `src/package-contracts/fixer-packet.ts:4` | prerequisite id 的字符拼写正则是表现形式法条；id 的真实语义只有「非空 + 在本次附件内唯一」，拼写不影响任何读取分支。清单只覆盖了下游 fixer-output.ts:51 的使用点，未覆盖定义真源。 |
| K5 | keep | `src/package-contracts/fixer-packet.ts:76` | prerequisiteId 是 fixer-output 的 blocker 真实引用目标，重复会造成引用歧义；属真 key 唯一性。清单只有 test 层条目（fixer-prerequisite-contract.test.ts:83），运行时真源未记录。 |
| D1 | delete | `src/package-contracts/worker-output.ts:31` | 整个 src/package-contracts/worker-output.ts 未被清单覆盖。这是 Coder 受理详情的闭合键 helper，与 judge-output.ts / merger-contracts.ts / reviewer-dispatch.ts 的 exact/hasExactKeys 同构第 N 份。 |
| D3 | delete | `src/package-contracts/worker-output.ts:38` | Coder 自报 commitSha 的存在性 / 非空 / 与 status 交叉法条，是 ADR 0024 判删的自报身份壳的运行时真源；清单只覆盖了 src/worker-role.ts:55 的 schema 字段和若干测试行，这条实际执行拒绝的分支未被记录。 |
| D1 | shrink | `src/package-contracts/worker-output.ts:35` | Coder 受理详情按 required ∪ present-optional 计算精确键集合并拒绝未知字段；只应保留 status 判别项与 report 非空。 |
| D1 | delete | `src/package-contracts/judge-output.ts:33` | 整个 src/package-contracts/judge-output.ts 未被清单覆盖（清单只有 src/judge-role.ts 与各 test 文件）。这是 Judge 三分支受理的闭合键真源，在 L84 / L94 / L96 / L114 / L119 被用了 5 次。 |
| D2 | delete | `src/package-contracts/judge-output.ts:74` | class name 禁含逗号是序列化拼写法条（为了让某处能用逗号拼接展示），不是任何读取分支的判别依据；应删。同一行的 names.has 去重是另一回事（见下条）。 |
| K5 | keep | `src/package-contracts/judge-output.ts:74` | class name 是 Fixer classResults 的真实引用键（fixer-output 按 name 结算），重复会造成引用歧义。清单只有 test/class-contracts.test.ts:28 的测试条目，运行时真源未记录。 |
| K2 | needs-adjudication | `src/package-contracts/judge-output.ts:47` | note 是纯人读的可选备注，不驱动任何分支；「给了就必须非空白」是否算必需字段非空检查存疑。清单在 test 层判为 K2/keep（judge-role.test.ts:1462），但运行时真源从未被列，且与 D2「表现形式法条」的边界未被裁定。 |
| D1 | delete | `src/judge-role.ts:58` | Judge 工具 schema 的顶层 additionalProperties:false 未被覆盖——清单只有 src/judge-role.ts:38（fix 子对象）。顶层闭合才是真正会拒绝模型多带字段的那一道，另 L45（classes 项）、L54（decisionGate）同样闭合。 |
| D1 | shrink | `src/doctor-contracts.ts:76` | Doctor 提交 schema 两个成员的顶层 additionalProperties:false 未被清单覆盖（清单只覆盖了 L47 count、L64 caseIdentity、L65 cost 等子对象）。这是模型实际提交时最先撞上的闭合面。 |
| D5 | shrink | `src/doctor-contracts.ts:94` | 与 L95 validateRecordedDoctorOutput 构成同一 Doctor 载荷家族的两份边界 validator（submission / output 只差一个 cost 字段）。清单只列了 :95，漏了 :94，收成一个边界真源时两条必须一起处理。 |
| K5 | keep | `src/doctor-contracts.ts:100` | evidenceId 是已受理证据的真实引用目标，解析不到必须拒绝。清单在同一行只记录了分页整数（D5）与 offset 上界（D4）两条，漏掉了这条应保留的引用解析。 |
| D2 | needs-adjudication | `src/collector-role.ts:234` | 对整段自由文本 kickoff 做逐字节相等拒绝，是清单里没有的一类「对包内常量字符串的精确相等法条」。是宿主注入漂移的真实护栏还是对呈现的机械依赖，需裁决。 |
| K1 | keep | `src/collector-role.ts:214` | 清单只覆盖了同一 handler 里的 options.skills（src/collector-role.ts:206），漏掉了并列的 contextFiles（L214）与 appendSystemPrompt（L222）两个环境隔离拒绝点；三者是同一条 fail-closed 法的三个分支。 |
| D1 | needs-adjudication | `src/collector-role.ts:575` | 对「运行时工具面」做闭合集合拒绝（未知成员即拒），形状同 D1 但对象不是 JSON 数据而是宿主能力面。清单的类别体系没有覆盖运行时能力面这一类，需裁决是归 D1 还是承认它是 K3 式的授权面绑定。 |
| D5 | shrink | `src/collector-role.ts:544` | 「必需工具存在且恰好一份」这一逻辑在 collector-role.ts:544、role-runtime.ts:474、doctor-role.ts:16、merger-role.ts:64 各写一份，四份同构物。清单只零散记了其中两处且归了不同类，没有识别出这是同一形状的重复。 |
| D5 | shrink | `src/role-runtime.ts:474` | 与上一条同根：Navigator 版本的「恰好一份」工具面校验。清单覆盖了同文件 :464（注册前碰撞）与 :490（窄化后计数），独独漏掉了注册后这一份，正好是重复度最高的一环。 |
| D2 | delete | `src/collector-github.ts:223` | 对 GitHub review state 做大小写归一，与已被判 D2/shrink 的 PR state（collector-github.ts:209）同性质但未被记录；下游 VALID_REVIEW_STATES 比较应直接用外部原值，归一属表现形式法条。 |
| K1 | keep | `src/worker-role.ts:196` | plan\|apply 判别项在激活期（CLI flag 面）也执行一次拒绝，这是它真正选择执行分支的地方；清单只记录了输出受理期的 worker-role.ts:138，激活期两处（Fixer L196 / Coder L322）未被覆盖。 |
| K7 | shrink | `src/reviewer-execution-ledger.ts:224` | 与已覆盖的 :220 并列的第二个分支，同样用 Object.keys(results).length 做精确基数比较；只保留「每条 expected 轴都有结果」即可，额外键的存在不必拒绝。 |
| UNCLEAR | needs-adjudication | `src/compliance-transport.ts:67` | 「模型 / provider / 鉴权不可用即拒绝」是一整类会拒绝的行为，但拒绝对象是宿主运行环境而非输入输出数据，D1–D6/K1–K8 无一条覆盖。同类还有 reviewer-child-executor.ts:43 与 :52。需裁决是宣告其不在扫描范围，还是补一个类别。 |
| D2 | shrink | `src/canonical-json.ts:60` | 误删。这一行是序列化器本体（为稳定摘要排序），不是拒绝行为——扫描规则明确「内部为稳定输出而排序不构成输入拒绝权」，ADR 0030 也只禁止序列化成为拒绝条件、明确允许 consumer 保留自己的序列化实现。且 Assisted 删除后 canonicalJson 的存活 importer 是 src/navigator-contracts.ts:1（canonicalSnapshotDigestV1 / evidence read 比对，本清单自己标 D2/keep、D3/keep，属 #28 deferral）。把 :60 一并删除等于在 #58 里改坏 Navigator，违反 ADR 0045/0020「#58 不改 Navigator」。应只删本文件里的 throw 类校验行（19/35/41/43/47/50/53/59）与死代码 :72，保留纯序列化。 |
| K3 | keep | `src/merger-contracts.ts:47` | 错判为 needs-adjudication，实际已由 ADR 0028 直接裁定：「只保留摘要存在且与现场实际字节重算结果相等的验证」——这一行正是该保留形态（现场重算 + 绑定），删的是同文件 :6 digestPattern、:43 十六进制外观、:45 canonical base64。ADR 0037 也把 Merger 的 authority/target 材料绑定列为保留例外。清单自己在 test/merger-contract.test.ts:25（drifted authority sha256）标 K3/keep，与此处 needs-adjudication 自相矛盾。 |
| K3 | keep | `src/doctor-contracts.ts:117` | 误删（K3 被当成 D3 身份外壳）。D3 的定义是 utf8Length/sha256/text 三件套与自报 commitSha；这里是把 finding 的证据绑到 finding 自己的 target 上，正是 ADR 0037 点名保留的「Doctor finding 的已读本案证据」类：不绑定就会出现格式完整但为错误对象出具证据的回执。同一函数内 :107 assertTargets、:110 readCitations、:126、:128 清单都判 K3/keep，唯独 117 判 D3/shrink，分类不成立。 |
| K3 | keep | `src/doctor-contracts.ts:123` | 同 117。真咬人证据必须属于本 finding 的 target，否则 A 闸的咬人记录会被拿去证明 B 闸该保留——这是 ADR 0037 的证据对象绑定，不是身份外壳。清单在紧邻的 :126（actual bite 必须引用已读 session）判 K3/keep，说明分类漂移而非有意区分。 |
| K5 | keep | `src/package-contracts/fixer-output.ts:81` | 不该悬为 needs-adjudication：class name 是裁类循环的真实对账键（CONTEXT「回执对账键」），Judge 的 classes[].name 与 Fixer classResults[].name 按名归属结算，重名会让两份结算覆盖同一类、静默丢一条 finding，正是 ADR 0039 保留例外的构成要件。清单自己在 test/fixer-contract.test.ts:71（重复 name 被拒）标 K5/keep，源侧却不判，前后不一致。 |
| K5 | keep | `README.md:114` | 误删。这句文档描述的是应当保留的 class name 唯一性（见 fixer-output.ts:81 一条）。删掉存活约束的文档会让 README 与生产 validator 脱节；#58 是删机制不是删存活机制的说明。只应删同句里随 :95 一起消失的 commitSha 唯一性表述。 |
| K5 | delete | `README.md:114` | 悬为 needs-adjudication 与源侧判决冲突：fixer-output.ts:95「classResults completed commitSha distinct constraint」已判 K5/delete（commitSha 不是 classResults 的映射键，两个类合并在一次 commit 里结算是合法的，ADR 0039 只保留真实键）。文档句必须随之删除，否则残留一条无对应生产校验的法条。 |
| K5 | delete | `test/fixer-contract.test.ts:72` | 同上：该负向案钉的正是 fixer-output.ts:95 已判 delete 的 commitSha 跨类唯一性。机制删除后此断言必然失败，UNCLEAR 应收敛为 delete，不留悬案。 |
| D3 | delete | `test/reviewer-bundle-materializer.test.ts:11` | 漏删（被误标 K3/keep）。它测的两件事恰好是同一清单判 delete 的机制：src/reviewer-bundle-materializer.ts:16 verifyBundleIdentity、:45 byteLength/sha256 readback、:47 manifestSha256，全部随 ADR 0031 的文本身份壳删除。身份壳一删，manifestSha256 与 entry.sha256 都不存在，此测试没有可变异对象、必然失败。保留理由只剩「有单元测试」，按 CONTEXT 不构成增量收益证据。真正的落盘安全由同文件 :12（路径逃逸/符号链接）、:29 symlink 走查覆盖，且已判 K4/keep。 |
| D4 | shrink | `src/doctor-contracts.ts:100` | 整行 delete 过头。ADR 0035 删的是「F043 的 4096 read limit」，同时明写「只保留参数能够实际执行所必需的条件」——offset 为整数且 ≥0、limit ≥1 正是分页读取能执行的最小条件，非整数/负数会让 subarray 与 coverage 区间产生无意义读并污染 hasRead 判定。清单在完全同形的 navigator-evidence.ts:8（!Number.isSafeInteger(offset)\|\|offset<0\|\|limit<1）判 keep，Doctor 侧应对齐为 shrink：只删 limit>4096 与 schema 的 maximum:4096。 |
| K3 | shrink | `README.md:213` | 整句 delete 会删掉存活机制的说明。COLLECTOR_ELIGIBILITY_MS 只在 collector-ledger.ts:1017 与 collector-tool-schemas.ts:26 充当「等待时长上限」——那两处 ADR 0035 判删；但 :560/:561 用它算 deadlineTime/deadlineMono，支撑清单自己判 K3/keep 的 :648、:666（missing 早于 cutoff 禁止交卷）、:674 与 collector-evidence.ts:116 computeWindowRelation，且 collector-evidence.ts:14 常量本身只判 shrink。README 应只删 request/wait 上限措辞，保留终态资格窗口的描述。 |
| K5 | delete | `test/collector-config.test.ts:255` | 悬案已被别处判定：该案钉的是 collector-config.ts:426 的**腿内**重复 author 拒绝，而 :426 已判 K5/delete（腿内 author 只做集合成员判定，重复无歧义）。GitHub 大小写不敏感这一真实语义由 :400 的 toLowerCase（K6/keep）与 :530 跨腿 owner 冲突（K5/keep）承接，跨腿的 "Bot"/"bot" 仍被拒。故此测试用例随 :426 删除，不需另行裁决。 |
