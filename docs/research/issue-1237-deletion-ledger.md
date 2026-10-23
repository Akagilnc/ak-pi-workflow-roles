# #1237 删除与改弱逐条账（R10-A）

范围：`git diff 7997ffb2 HEAD -- test`。上卷三例只是证据，不是白名单。本账在第十一轮施工时生成；计数不包含本轮新增断言。

## 计数命令

在仓库根执行 `python3 docs/research/issue-1237-deletion-ledger.py`。它打印 `COUNT`，并与本表行数比对。规则：

1. 删除行取 `git diff -U0 7997ffb2 HEAD -- test`，用 `@@ -start` 还原基线行号。
2. 整文件：`git diff --diff-filter=D --name-only 7997ffb2 HEAD -- test`，一个文件一行。
3. 整案：基线里以 `test(` / `it(` 开头（允许 `.only` 等）且该行在删除行集合中的，一行一个。HEAD 仍有同名案也不剔除。
4. 断言：基线里从 `assert.` / `assert(` / `await assert` 起，按括号深度收到语句结束（引号内括号不计）。该语句任一基线行被删，计一条，同一语句不重复。
5. 三者相加，不互相抵消。删文件同时计文件、其案、其断言。

本表 833 行 = 整文件 18 + 整案 115 + 断言 700。

## 处置口径

- 改好：本轮或已核验的改好位置，附隔离副本变异与 HEAD 报红的测试名。
- 仍在：同一文件里断言原文还在，或只是案名改写。不是承接声称。
- T/C/S/M：已裁坏测试的形状，引依据，不引承接路径。
- 整文件已裁：引逐文件表行，该行里的承接路径本账不采用。
- null：没有变异证明，也不按形状归入已裁坏测试。不把 null 写成承接。notary 旗是走不到真实入口的缺口；其余 null 未逐条再证，不能当成已有承接。

处置计数：

- null：504
- 整文件已裁，承接 null：275
- 仍在：23
- S：16
- M：6
- 改好：5
- T：4

## 逐条

| # | 种类 | 基线位置 | 摘录 | 处置 |
| --- | --- | --- | --- | --- |
| 1 | file | `test/contract/gatekeeper-projection.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:56 类别 D/S；该行承接路径本账不采用，承接 null |
| 2 | file | `test/contract/gleaner-left-role.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:57 类别 M/S；该行承接路径本账不采用，承接 null |
| 3 | file | `test/contract/notary-role.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:61 类别 M/T/D；该行承接路径本账不采用，承接 null |
| 4 | file | `test/contract/secretariat-static-scan.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:66 类别 M；该行承接路径本账不采用，承接 null |
| 5 | file | `test/contract/session-opening-materials.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:67 类别 M；该行承接路径本账不采用，承接 null |
| 6 | file | `test/helpers/package-entrypoint-fixtures.ts` | (deleted file) | null（夹具文件，逐文件表无此行，无断言承接） |
| 7 | file | `test/integration/countersign-notary-gate.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:85 类别 B；该行承接路径本账不采用，承接 null |
| 8 | file | `test/integration/engine-material.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:89 类别 D；该行承接路径本账不采用，承接 null |
| 9 | file | `test/integration/factory-board-true-home.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；该行承接路径本账不采用，承接 null |
| 10 | file | `test/integration/public-cli-argv-parsers.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；该行承接路径本账不采用，承接 null |
| 11 | file | `test/primary-aware-cleanup.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；该行承接路径本账不采用，承接 null |
| 12 | file | `test/unit/canonical-json.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:26 类别 S；该行承接路径本账不采用，承接 null |
| 13 | file | `test/unit/engine-material.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:27 类别 D；该行承接路径本账不采用，承接 null |
| 14 | file | `test/unit/judge-recording-anti-forge.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:32 类别 S；该行承接路径本账不采用，承接 null |
| 15 | file | `test/unit/merger-contract.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:33 类别 M；该行承接路径本账不采用，承接 null |
| 16 | file | `test/unit/navigator-route-table.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:34 类别 T；该行承接路径本账不采用，承接 null |
| 17 | file | `test/unit/public-cli-option-definitions.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；该行承接路径本账不采用，承接 null |
| 18 | file | `test/unit/public-cli-registry.test.ts` | (deleted file) | 整文件删除；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；该行承接路径本账不采用，承接 null |
| 19 | assert | `test/contract/analyst-413-r2-findings.test.ts:54` | await assert.rejects( () => readAnalystLibraryIndexPage(join(home, ".ak-roles")), (error: unknown) => { // The rejection's visible identity is this index file. A downstream // cras | null |
| 20 | assert | `test/contract/analyst-413-r2-findings.test.ts:82` | assert.equal(isSyntheticAnalystBookKey("root:foo"), false); | 改好 test/contract/analyst-413-r2-findings.test.ts:205（basename 非合成）与 :211（root:<absolute> 为合成）；变异：隔离副本 isSyntheticAnalystBookKey 改 return true，以及改 return false；HEAD 均红 U3: real book basename root:foo keeps its book scope through cohort cache-miss recompute |
| 21 | assert | `test/contract/analyst-413-r2-findings.test.ts:83` | assert.equal(isSyntheticAnalystBookKey("plain-book"), false); | 改好 test/contract/analyst-413-r2-findings.test.ts:205（basename 非合成）与 :211（root:<absolute> 为合成）；变异：隔离副本 isSyntheticAnalystBookKey 改 return true，以及改 return false；HEAD 均红 U3: real book basename root:foo keeps its book scope through cohort cache-miss recompute |
| 22 | assert | `test/contract/analyst-413-r2-findings.test.ts:85` | assert.equal(isSyntheticAnalystBookKey(`root:${physicalPathIdentity("/analyst-fixture/u3")}`), true); | 改好 test/contract/analyst-413-r2-findings.test.ts:205（basename 非合成）与 :211（root:<absolute> 为合成）；变异：隔离副本 isSyntheticAnalystBookKey 改 return true，以及改 return false；HEAD 均红 U3: real book basename root:foo keeps its book scope through cohort cache-miss recompute |
| 23 | case | `test/contract/analyst-413-r2-findings.test.ts:40` | U1: library-index read boundary rejects null/non-object/rows-not-array with the file path | 案名改写后仍在 test/contract/analyst-413-r2-findings.test.ts:36；不是整案删除 |
| 24 | case | `test/contract/analyst-413-r2-findings.test.ts:79` | U3: isSyntheticAnalystBookKey — root:<absolute path> is synthetic; real basename root:foo is not | 改好 test/contract/analyst-413-r2-findings.test.ts:205（basename 非合成）与 :211（root:<absolute> 为合成）；变异：隔离副本 isSyntheticAnalystBookKey 改 return true，以及改 return false；HEAD 均红 U3: real book basename root:foo keeps its book scope through cohort cache-miss recompute |
| 25 | assert | `test/contract/analyst-b2-frame-buckets-actions.test.ts:181` | assert.equal(metrics.wallMs, 10_000); | null |
| 26 | assert | `test/contract/analyst-b2-frame-buckets-actions.test.ts:182` | assert.equal(metrics.toolBucketMs, 10_000); | null |
| 27 | assert | `test/contract/analyst-b2-frame-buckets-actions.test.ts:183` | assert.equal(metrics.modelBucketMs, 0); | null |
| 28 | assert | `test/contract/analyst-b2-frame-buckets-actions.test.ts:184` | assert.equal( metrics.toolBucketMs + metrics.modelBucketMs, metrics.wallMs, "clipped tool bucket + model must equal wall", ); | null |
| 29 | assert | `test/contract/analyst-b2-frame-buckets-actions.test.ts:189` | assert.equal(metrics.actions.length, 1); | null |
| 30 | assert | `test/contract/analyst-b2-frame-buckets-actions.test.ts:190` | assert.equal(metrics.actions[0]!.kind, "tool"); | null |
| 31 | assert | `test/contract/analyst-b2-frame-buckets-actions.test.ts:191` | assert.equal(metrics.actions[0]!.durationMs, 10_000); | null |
| 32 | assert | `test/contract/analyst-b2-frame-buckets-actions.test.ts:192` | assert.equal(metrics.actions[0]!.startedAt, "2026-08-01T00:00:10.000Z"); | null |
| 33 | assert | `test/contract/analyst-b2-frame-buckets-actions.test.ts:193` | assert.equal(metrics.actions[0]!.endedAt, "2026-08-01T00:00:20.000Z"); | null |
| 34 | assert | `test/contract/analyst-b2-frame-buckets-actions.test.ts:231` | assert.notEqual(bash.commandSummary, "pnpm test:fast\nnode scripts/extra.js"); | null |
| 35 | case | `test/contract/analyst-b2-frame-buckets-actions.test.ts:157` | analyst B2 kernel: out-of-frame tool intervals clip so tool+model ≡ wall | null |
| 36 | assert | `test/contract/collector-self-collect.test.ts:117` | assert.ok(meta); | null |
| 37 | assert | `test/contract/collector-self-collect.test.ts:118` | assert.equal("worker" in meta && meta.worker === true, false); | null |
| 38 | assert | `test/contract/collector-self-collect.test.ts:119` | assert.equal( "phases" in meta && Array.isArray(meta.phases) && meta.phases.includes("apply"), false, ); | null |
| 39 | assert | `test/contract/collector-self-collect.test.ts:144` | assert.equal( harness.tools.has(name), false, `code-collection tool ${name} must be removed`, ); | null |
| 40 | case | `test/contract/collector-self-collect.test.ts:115` | #1088 collector seat stays evidence-only (not construction worker) | null |
| 41 | case | `test/contract/collector-self-collect.test.ts:125` | #1088 collector activation keeps host CLI tools and drops code-collection tools | null |
| 42 | assert | `test/contract/countersign-role.test.ts:46` | assert.equal(sealedBack.status, "continue"); | null |
| 43 | assert | `test/contract/countersign-role.test.ts:47` | assert.equal("disposition" in sealedBack, false, "no disposition default may be injected"); | null |
| 44 | assert | `test/contract/countersign-role.test.ts:48` | assert.deepEqual(sealedBack.findings, ["x"], "findings must not be normalized"); | null |
| 45 | assert | `test/contract/countersign-role.test.ts:49` | assert.equal(sealedBack.evidence, "e-1", "evidence must survive"); | null |
| 46 | assert | `test/contract/countersign-role.test.ts:50` | assert.equal( validateRecordedCountersignOutput({ status: "converged", note: "n" }).status, "converged", ); | null |
| 47 | assert | `test/contract/countersign-role.test.ts:54` | assert.equal( validateRecordedCountersignOutput({ status: "escalate", decisionGate: { question: "q", options: ["a"] }, }).status, "escalate", ); | null |
| 48 | assert | `test/contract/countersign-role.test.ts:61` | assert.throws(() => validateRecordedCountersignOutput({ status: "maybe" })); | null |
| 49 | assert | `test/contract/countersign-role.test.ts:62` | assert.throws(() => validateRecordedCountersignOutput(null)); | null |
| 50 | assert | `test/contract/countersign-role.test.ts:66` | assert.deepEqual( [COUNTERSIGN_OUTPUT_TOOL_NAME, JUDGE_OUTPUT_TOOL_NAME, NOTARY_OUTPUT_TOOL_NAME, AUDITOR_OUTPUT_TOOL_NAME, INSPECTOR_OUTPUT_TOOL_NAME], [REVIEW_SUBMISSION_OUTPUT_T | null |
| 51 | assert | `test/contract/countersign-role.test.ts:70` | assert.equal(countersignVerdictSchema, reviewSubmissionSchema); | null |
| 52 | assert | `test/contract/countersign-role.test.ts:71` | assert.equal(notaryOutputSchema, notaryReviewSubmissionSchema); | null |
| 53 | assert | `test/contract/countersign-role.test.ts:72` | assert.ok([judgeVerdictSchema, auditorOutputSchema].every((schema) => schema === reviewSubmissionSchema)); | M 镜像形状；依据 souls/quality-law.md 锚定（机器只咬契约）；docs/research/issue-1237-test-quality-sweep.md:51 类别 M/S/T；不引承接 |
| 54 | assert | `test/contract/countersign-role.test.ts:73` | assert.equal(inspectorOutputSchema, inspectorSubmissionSchema); | null |
| 55 | assert | `test/contract/countersign-role.test.ts:74` | assert.equal(roleSubmissionDeclaration("inspector").parameters, inspectorSubmissionSchema); | null |
| 56 | assert | `test/contract/countersign-role.test.ts:75` | assert.equal(roleSubmissionDeclaration("countersign").parameters, reviewSubmissionSchema); | null |
| 57 | assert | `test/contract/countersign-role.test.ts:76` | assert.equal(Object.hasOwn(countersignVerdictSchema.properties, "clauses"), false); | null |
| 58 | assert | `test/contract/countersign-role.test.ts:77` | assert.equal(roleSubmissionDeclaration("notary").parameters, notaryReviewSubmissionSchema); | null |
| 59 | assert | `test/contract/countersign-role.test.ts:79` | assert.equal(Value.Check(reviewSubmissionSchema, { status: word, extra: true }), true, word); | null |
| 60 | assert | `test/contract/countersign-role.test.ts:80` | assert.equal( Value.Check(notaryReviewSubmissionSchema, { status: word, clauses: [{ clause: "c", ownerUuid: null, derivation: "无原话" }], }), true, word, ); | null |
| 61 | assert | `test/contract/countersign-role.test.ts:89` | assert.equal(Value.Check(reviewSubmissionSchema, { status: "not-a-status" }), false); | null |
| 62 | assert | `test/contract/countersign-role.test.ts:90` | assert.equal(Value.Check(reviewSubmissionSchema, {}), false); | null |
| 63 | assert | `test/contract/countersign-role.test.ts:92` | assert.equal(Value.Check(notaryReviewSubmissionSchema, { status: "converged" }), false); | null |
| 64 | assert | `test/contract/countersign-role.test.ts:93` | assert.equal( Value.Check(notaryReviewSubmissionSchema, { status: "converged", clauses: [{ clause: "c", ownerUuid: "u", derivation: "d" }], extra: true, }), true, ); | null |
| 65 | assert | `test/contract/countersign-role.test.ts:102` | assert.equal(Value.Check(reviewSubmissionSchema, { status: "converged" }), true); | null |
| 66 | assert | `test/contract/countersign-role.test.ts:104` | assert.equal(Value.Check(inspectorSubmissionSchema, { status: "converged" }), false); | null |
| 67 | assert | `test/contract/countersign-role.test.ts:105` | assert.equal( Value.Check(inspectorSubmissionSchema, { status: "converged", suspect: "ming/a.py:1 两处读法不同，留着", ticketComplexity: [ { class: "同一业务规则只保留一个权威实现", hits: [], checked: "比对 | null |
| 68 | assert | `test/contract/countersign-role.test.ts:116` | assert.equal( Value.Check(inspectorSubmissionSchema, { status: "continue", suspect: "ming/a.py:1", ticketComplexity: [{ class: "同一业务规则只保留一个权威实现", hits: null, checked: "" }], }), fa | null |
| 69 | assert | `test/contract/countersign-role.test.ts:133` | assert.ok(h.tools.has(COUNTERSIGN_OUTPUT_TOOL_NAME)); | null |
| 70 | assert | `test/contract/countersign-role.test.ts:134` | assert.ok(h.beforeStart()); | null |
| 71 | assert | `test/contract/countersign-role.test.ts:140` | assert.ok(prompted.systemPrompt.length > "BASE".length); | null |
| 72 | assert | `test/contract/countersign-role.test.ts:160` | assert.ok(tool); | null |
| 73 | assert | `test/contract/countersign-role.test.ts:169` | assert.equal(withFindings.terminate, true); | null |
| 74 | assert | `test/contract/countersign-role.test.ts:170` | assert.equal( (withFindings.details as { status: string }).status, "continue", ); | null |
| 75 | assert | `test/contract/countersign-role.test.ts:174` | assert.deepEqual(withFindings.content, []); | null |
| 76 | assert | `test/contract/countersign-role.test.ts:184` | assert.equal(withoutClauses.terminate, true); | null |
| 77 | assert | `test/contract/countersign-role.test.ts:185` | assert.deepEqual(withoutClauses.details, { status: "converged" }); | null |
| 78 | assert | `test/contract/countersign-role.test.ts:193` | assert.equal(withLegacyClauses.terminate, true); | null |
| 79 | assert | `test/contract/countersign-role.test.ts:194` | assert.deepEqual(withLegacyClauses.details, legacy); | null |
| 80 | case | `test/contract/countersign-role.test.ts:38` | validateRecordedCountersignOutput recognizes 署/封驳/上呈 read-only — 原卷保真 | null |
| 81 | case | `test/contract/countersign-role.test.ts:65` | review officers share the output tool; only notary requires clauses | null |
| 82 | case | `test/contract/countersign-role.test.ts:126` | Countersign runtime registers output tool and injects soul without ticket body preload | null |
| 83 | case | `test/contract/countersign-role.test.ts:152` | Countersign execute accepts as-is and terminates — sole-final barrier is ledger-owned | null |
| 84 | case | `test/contract/doctor-role.test.ts:39` | Doctor activation exposes only paged session evidence and output tools | null |
| 85 | assert | `test/contract/gatekeeper-pass-envelope.test.ts:158` | assert.equal(booked.length, 0, "parent history must not book officer-pointer rows"); | null |
| 86 | assert | `test/contract/gatekeeper-projection.test.ts:15` | assert.deepEqual(projectLawfulGatekeeperOutput(input), input); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:56 类别 D/S；承接 null |
| 87 | case | `test/contract/gatekeeper-projection.test.ts:9` | gatekeeper projection keeps original findings payload as-is (#836) | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:56 类别 D/S；承接 null |
| 88 | assert | `test/contract/gleaner-left-role.test.ts:18` | assert.ok(record); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:57 类别 M/S；承接 null |
| 89 | assert | `test/contract/gleaner-left-role.test.ts:19` | assert.equal(record.outputTool, GLEANER_LEFT_OUTPUT_TOOL_NAME); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:57 类别 M/S；承接 null |
| 90 | assert | `test/contract/gleaner-left-role.test.ts:20` | assert.equal((GATE_OFFICER_SEATS as readonly string[]).includes("gleaner-left"), false); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:57 类别 M/S；承接 null |
| 91 | assert | `test/contract/gleaner-left-role.test.ts:24` | assert.throws(() => validateRecordedGleanerLeftOutput({ status: "bounce" })); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:57 类别 M/S；承接 null |
| 92 | assert | `test/contract/gleaner-left-role.test.ts:25` | assert.throws(() => validateRecordedGleanerLeftOutput({ status: "pass" })); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:57 类别 M/S；承接 null |
| 93 | assert | `test/contract/gleaner-left-role.test.ts:26` | assert.throws(() => validateRecordedGleanerLeftOutput({ countersignStatus: "converged" }), ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:57 类别 M/S；承接 null |
| 94 | assert | `test/contract/gleaner-left-role.test.ts:29` | assert.throws(() => validateRecordedGleanerLeftOutput(null)); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:57 类别 M/S；承接 null |
| 95 | assert | `test/contract/gleaner-left-role.test.ts:35` | assert.equal(recorded.status, "completed"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:57 类别 M/S；承接 null |
| 96 | case | `test/contract/gleaner-left-role.test.ts:16` | gleaner-left is a callable non-gate seat | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:57 类别 M/S；承接 null |
| 97 | case | `test/contract/gleaner-left-role.test.ts:23` | recorded output does not recognize bounce or verdict statuses | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:57 类别 M/S；承接 null |
| 98 | assert | `test/contract/judge-role.test.ts:154` | assert.ok(prompt.includes(base), "base system prompt must survive"); | null |
| 99 | assert | `test/contract/judge-role.test.ts:156` | assert.ok(prompt.includes(material), `prompt must deliver ${JSON.stringify(material)}`); | null |
| 100 | assert | `test/contract/judge-role.test.ts:338` | assert.deepEqual(new Set(harness.handlers.keys()), new Set([ "input", "before_agent_start", "session_start", "tool_result", "turn_end", "agent_end", "agent_settled", "session_shutd | M 镜像形状；依据 souls/quality-law.md 锚定（机器只咬契约）；docs/research/issue-1237-test-quality-sweep.md:58 类别 M/T/D/S；不引承接 |
| 101 | assert | `test/contract/judge-role.test.ts:353` | assert.equal(harness.handlers.has("tool_call"), false, "tool_call"); | null |
| 102 | assert | `test/contract/judge-role.test.ts:362` | await assert.rejects( Promise.resolve(harness.handlers.get("session_start")?.({}, { abort() {} })), new Error("Unsupported workflow role: router"), ); | null |
| 103 | assert | `test/contract/judge-role.test.ts:429` | assert.deepEqual(new Set(fixer.flags.keys()), new Set(["ak-fixer-phase"])); | M 镜像形状；依据 souls/quality-law.md 锚定（机器只咬契约）；docs/research/issue-1237-test-quality-sweep.md:58 类别 M/T/D/S；不引承接 |
| 104 | assert | `test/contract/judge-role.test.ts:431` | assert.deepEqual([...fixer.tools.keys()], [FIXER_OUTPUT_TOOL_NAME]); | M 镜像形状；依据 souls/quality-law.md 锚定（机器只咬契约）；docs/research/issue-1237-test-quality-sweep.md:58 类别 M/T/D/S；不引承接 |
| 105 | assert | `test/contract/judge-role.test.ts:432` | assert.ok(fixer.handlers.has("before_agent_start")); | null |
| 106 | assert | `test/contract/judge-role.test.ts:433` | assert.equal(fixerRoleEvents.has("input"), false); | null |
| 107 | assert | `test/contract/judge-role.test.ts:434` | assert.equal(fixer.handlers.has("input"), true); | null |
| 108 | assert | `test/contract/judge-role.test.ts:445` | assert.ok(fixerTool); | null |
| 109 | assert | `test/contract/judge-role.test.ts:446` | assert.deepEqual( (await fixerTool.execute( "plan-call", { status: "planned", report: "Plan the smallest repair." }, undefined, undefined, await withPassingGatekeeper(toolCallConte | null |
| 110 | assert | `test/contract/judge-role.test.ts:466` | assert.deepEqual(new Set(coder.flags.keys()), new Set(["ak-coder-phase"])); | M 镜像形状；依据 souls/quality-law.md 锚定（机器只咬契约）；docs/research/issue-1237-test-quality-sweep.md:58 类别 M/T/D/S；不引承接 |
| 111 | assert | `test/contract/judge-role.test.ts:468` | assert.deepEqual([...coder.tools.keys()], [CODER_OUTPUT_TOOL_NAME]); | M 镜像形状；依据 souls/quality-law.md 锚定（机器只咬契约）；docs/research/issue-1237-test-quality-sweep.md:58 类别 M/T/D/S；不引承接 |
| 112 | assert | `test/contract/judge-role.test.ts:469` | assert.ok(coder.handlers.has("before_agent_start")); | null |
| 113 | assert | `test/contract/judge-role.test.ts:470` | assert.ok(coder.handlers.has("input")); | null |
| 114 | assert | `test/contract/judge-role.test.ts:545` | assert.ok(typeof tool.description === "string" && tool.description.length > 0); | null |
| 115 | assert | `test/contract/judge-role.test.ts:546` | assert.ok( tool.promptGuidelines === undefined // tool.promptGuidelines.length === 0, `${fixture.name} must not carry promptGuidelines instruction family`, ); | S 失效名缺席；名字 promptGuidelines 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 116 | assert | `test/contract/judge-role.test.ts:562` | assert.equal(result.usage, undefined); | null |
| 117 | assert | `test/contract/judge-role.test.ts:638` | assert.equal(result.terminate, true); | 仍在 test/contract/judge-role.test.ts:504 |
| 118 | assert | `test/contract/judge-role.test.ts:639` | assert.deepEqual(result.details, unreadable); | null |
| 119 | case | `test/contract/judge-role.test.ts:355` | unsupported role fails with the frozen diagnostic before any loader runs | null |
| 120 | case | `test/contract/judge-role.test.ts:407` | focused Fixer and Coder controllers own their flags, lifecycle hooks, and prompt envelopes | null |
| 121 | case | `test/contract/judge-role.test.ts:478` | named Judge and worker tools preserve schema leaves and receipts | null |
| 122 | case | `test/contract/judge-role.test.ts:621` | judge output tool returns an unreadable status for public routing (#756/#1057) | null |
| 123 | case | `test/contract/judge-role.test.ts:917` | fixer role startup materials carry soul and phase only; returns a thin report envelope | null |
| 124 | assert | `test/contract/navigator-attendance-lifecycle.test.ts:484` | assert.equal( (presentation.details as { unavailableReason?: string } / undefined)?.unavailableReason, "Navigator exceeded post-role delivery grace", ); | null |
| 125 | assert | `test/contract/notary-role.test.ts:39` | assert.equal(projectLawfulNotaryOutput({ status: "pass", findings: [] })?.status, "pass"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:61 类别 M/T/D；承接 null |
| 126 | assert | `test/contract/notary-role.test.ts:41` | assert.equal(bounce?.status, "bounce"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:61 类别 M/T/D；承接 null |
| 127 | assert | `test/contract/notary-role.test.ts:43` | assert.deepEqual( projectLawfulNotaryOutput({ status: "incomplete", reason: "missing draft" }), { status: "incomplete", reason: "missing draft" }, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:61 类别 M/T/D；承接 null |
| 128 | assert | `test/contract/notary-role.test.ts:47` | assert.deepEqual(projectLawfulNotaryOutput({ status: "maybe" }), { status: "maybe" }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:61 类别 M/T/D；承接 null |
| 129 | assert | `test/contract/notary-role.test.ts:48` | assert.equal(projectLawfulNotaryOutput(null), undefined); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:61 类别 M/T/D；承接 null |
| 130 | assert | `test/contract/notary-role.test.ts:50` | assert.deepEqual(retainNotarySubmission(raw), raw); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:61 类别 M/T/D；承接 null |
| 131 | assert | `test/contract/notary-role.test.ts:54` | assert.equal(readNotaryTicketFlag(undefined), undefined); | null（公开入口只写已校验正整数，产不出非法旗；仓内无现成扩展激活案能把非法值送进 readNotaryTicketFlag） |
| 132 | assert | `test/contract/notary-role.test.ts:55` | assert.equal(readNotaryTicketFlag(""), undefined); | null（公开入口只写已校验正整数，产不出非法旗；仓内无现成扩展激活案能把非法值送进 readNotaryTicketFlag） |
| 133 | assert | `test/contract/notary-role.test.ts:56` | assert.equal(readNotaryTicketFlag("582"), 582); | null（公开入口只写已校验正整数，产不出非法旗；仓内无现成扩展激活案能把非法值送进 readNotaryTicketFlag） |
| 134 | assert | `test/contract/notary-role.test.ts:57` | assert.throws(() => readNotaryTicketFlag("nope")); | null（公开入口只写已校验正整数，产不出非法旗；仓内无现成扩展激活案能把非法值送进 readNotaryTicketFlag） |
| 135 | assert | `test/contract/notary-role.test.ts:64` | assert.deepEqual(bound, { sourceRunPath: LOCATOR.runDirectory, ticketNumber: 582, }); | null（公开入口只写已校验正整数，产不出非法旗；仓内无现成扩展激活案能把非法值送进 readNotaryTicketFlag） |
| 136 | assert | `test/contract/notary-role.test.ts:82` | assert.equal(h.flags.has("ak-notary-source-run"), true); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:61 类别 M/T/D；承接 null |
| 137 | assert | `test/contract/notary-role.test.ts:83` | assert.equal(h.flags.has("ak-notary-ticket-number"), false); | null（公开入口只写已校验正整数，产不出非法旗；仓内无现成扩展激活案能把非法值送进 readNotaryTicketFlag） |
| 138 | assert | `test/contract/notary-role.test.ts:87` | assert.ok(h.tools.has(NOTARY_OUTPUT_TOOL_NAME)); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:61 类别 M/T/D；承接 null |
| 139 | assert | `test/contract/notary-role.test.ts:90` | assert.match(start.systemPrompt, /<audited_seat_soul seat="judge">\nJUDGE LAW\n<\/audited_seat_soul>/); | T 文案锁；依据 souls/quality-law.md:32；docs/research/issue-1237-test-quality-sweep.md:61 类别 M/T/D；不引承接 |
| 140 | case | `test/contract/notary-role.test.ts:38` | projectLawfulNotaryOutput keeps original payload as-is (#836) | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:61 类别 M/T/D；承接 null |
| 141 | case | `test/contract/notary-role.test.ts:53` | projectNotaryBoundFromFlags + ticket reader: blank unbound; valid binds; invalid throws | null（公开入口只写已校验正整数，产不出非法旗；仓内无现成扩展激活案能把非法值送进 readNotaryTicketFlag） |
| 142 | case | `test/contract/notary-role.test.ts:70` | Notary activate registers source-run flag + tool; ticket flag is envelope-owned | null（公开入口只写已校验正整数，产不出非法旗；仓内无现成扩展激活案能把非法值送进 readNotaryTicketFlag） |
| 143 | assert | `test/contract/secretariat-role.test.ts:77` | assert.equal(active.some((name) => name.startsWith("ak_secretariat_summon_")), false); | null |
| 144 | assert | `test/contract/secretariat-role.test.ts:170` | assert.equal(result.content.length, 0); | null |
| 145 | assert | `test/contract/secretariat-role.test.ts:171` | assert.equal(result.terminate, true); | null |
| 146 | assert | `test/contract/secretariat-role.test.ts:172` | assert.deepEqual(result.details, { secretariatStatus: "converged", ticketNumber: 969 }); | null |
| 147 | assert | `test/contract/secretariat-role.test.ts:236` | assert.equal(filed.terminate, true); | null |
| 148 | assert | `test/contract/secretariat-role.test.ts:237` | assert.deepEqual(await readRecordedSubmissionRows(root, "run-ledger", root), [ { role: "secretariat", kind: "accepted", accepted: params, toolCallId: "c", }, ]); | null |
| 149 | assert | `test/contract/secretariat-role.test.ts:277` | assert.equal(unknown.terminate, true); | null |
| 150 | assert | `test/contract/secretariat-role.test.ts:278` | assert.deepEqual(unknown.details, { secretariatStatus: "unexpected" }); | null |
| 151 | case | `test/contract/secretariat-role.test.ts:136` | secretariat tool finishes before audit on every host | null |
| 152 | assert | `test/contract/secretariat-static-scan.test.ts:55` | assert.deepEqual( paths, ["souls/ticket-law.md"], `expected sole souls/ticket-law.md; found: ${paths.join(", ") // "(none)"}`, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:66 类别 M；承接 null |
| 153 | assert | `test/contract/secretariat-static-scan.test.ts:72` | assert.ok(roleFiles.length > 0); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:66 类别 M；承接 null |
| 154 | assert | `test/contract/secretariat-static-scan.test.ts:89` | assert.equal( staticImport.test(source), false, `${file} must not value-import ${name}`, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:66 类别 M；承接 null |
| 155 | assert | `test/contract/secretariat-static-scan.test.ts:103` | assert.equal( dynamicBind.test(source) // dynamicMember.test(source), false, `${file} must not dynamically bind/call ${name}`, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:66 类别 M；承接 null |
| 156 | assert | `test/contract/secretariat-static-scan.test.ts:115` | assert.deepEqual(ids, ["attach", "project"].sort()); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:66 类别 M；承接 null |
| 157 | assert | `test/contract/secretariat-static-scan.test.ts:116` | assert.equal( options.some((o) => o.id === "mode" // o.id === "ticket" // o.id === "phase"), false, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:66 类别 M；承接 null |
| 158 | case | `test/contract/secretariat-static-scan.test.ts:53` | ticket-law is the sole structural law owner | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:66 类别 M；承接 null |
| 159 | case | `test/contract/secretariat-static-scan.test.ts:67` | role modules do not value-import or call shared summon drivers (ADR 0018) | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:66 类别 M；承接 null |
| 160 | case | `test/contract/secretariat-static-scan.test.ts:112` | public secretariat face has no new flags or mode params | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:66 类别 M；承接 null |
| 161 | assert | `test/contract/session-opening-materials.test.ts:11` | await assert.rejects( () => joinPackageMaterials(["souls/__no_such_opening_material__.md"]), (error: unknown) => error instanceof Error && "code" in error && (error as NodeJS.Errno | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:67 类别 M；承接 null |
| 162 | case | `test/contract/session-opening-materials.test.ts:10` | missing injected material fails as native ENOENT, not a soft empty | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:67 类别 M；承接 null |
| 163 | assert | `test/contract/sitian-facade-contracts.test.ts:45` | assert.ok(runSummaryPtr.recordFile.includes("settlement-summary")); | null |
| 164 | assert | `test/contract/submission-ledger.test.ts:283` | assert.ok(!kinds.includes("outcome") // (await ledgerRecords(f.root)).every((r) => r.kind !== "outcome" // (r.payload as { code?: string }).code !== "non-sole-round")); | null |
| 165 | assert | `test/contract/submission-ledger.test.ts:466` | assert.deepEqual(accepted.details, row.details, row.role); | null |
| 166 | assert | `test/contract/submission-ledger.test.ts:467` | assert.equal(accepted.terminate, true, row.role); | null |
| 167 | assert | `test/contract/submission-ledger.test.ts:472` | assert.deepEqual( rows, [{ role: row.role, kind: "accepted", accepted: row.details, toolCallId: `${row.role}-output` }], row.role, ); | null |
| 168 | assert | `test/contract/submission-ledger.test.ts:599` | assert.ok(firstCandidate); | null |
| 169 | assert | `test/contract/submission-ledger.test.ts:600` | assert.equal(firstCandidate.priorEventId, undefined); | null |
| 170 | assert | `test/contract/submission-ledger.test.ts:601` | assert.equal("priorEventId" in firstCandidate, false); | S 失效名缺席；名字 priorEventId 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 171 | case | `test/contract/submission-ledger.test.ts:435` | every packaged role records original payload through the production ledger host (#836) | null |
| 172 | case | `test/contract/submission-ledger.test.ts:559` | legacy records with priorEventId are readable and new records omit priorEventId | null |
| 173 | assert | `test/contract/ticket-trajectory.test.ts:392` | assert.equal(DEFAULT_REFRESH_BOUNDARY_SECONDS, 30); | null |
| 174 | assert | `test/helpers/failure-settlement-kit.ts:93` | assert.equal(input.result.exitCode, 1); | null |
| 175 | assert | `test/helpers/failure-settlement-kit.ts:95` | assert.equal(input.stderr.length, 1, "exactly one stderr diagnostic emission"); | null |
| 176 | assert | `test/helpers/failure-settlement-kit.ts:96` | assert.ok((input.stderr[0] ?? "").length > 0); | null |
| 177 | assert | `test/helpers/failure-settlement-kit.ts:105` | assert.equal(typeof terminal.roleOutcome.diagnostic, "string"); | null |
| 178 | assert | `test/helpers/failure-settlement-kit.ts:106` | assert.ok(terminal.roleOutcome.diagnostic.length > 0); | null |
| 179 | assert | `test/helpers/failure-settlement-kit.ts:116` | assert.equal(isLawfulTypedTerminalOutcome(terminal.roleOutcome), false); | null |
| 180 | assert | `test/helpers/failure-settlement-kit.ts:117` | assert.equal(exitCodeForTerminalOutcome(terminal.roleOutcome), 1); | null |
| 181 | assert | `test/helpers/failure-settlement-kit.ts:118` | assert.ok(terminal.navigator); | null |
| 182 | assert | `test/helpers/failure-settlement-kit.ts:119` | assert.equal(typeof terminal.runId, "string"); | null |
| 183 | assert | `test/helpers/failure-settlement-kit.ts:120` | assert.ok(terminal.runId !== undefined && terminal.runId.length > 0); | null |
| 184 | assert | `test/helpers/failure-settlement-kit.ts:121` | assert.ok(Array.isArray(terminal.artifacts)); | null |
| 185 | assert | `test/helpers/failure-settlement-kit.ts:122` | assert.ok(terminal.artifacts.length >= 1); | null |
| 186 | assert | `test/helpers/failure-settlement-kit.ts:143` | assert.equal("judgeStatus" in errorBody, false); | null |
| 187 | assert | `test/helpers/failure-settlement-kit.ts:145` | assert.notEqual(errorBody.cause, "unrecognized"); | null |
| 188 | assert | `test/helpers/failure-settlement-kit.ts:146` | assert.notEqual(terminal.roleOutcome.cause, "unrecognized"); | null |
| 189 | assert | `test/helpers/run-dossier-fixture.ts:190` | assert.equal(existsSync(join(runDirectory, name)), false, `retired dossier file present: ${name}`); | null |
| 190 | assert | `test/helpers/run-dossier-fixture.ts:196` | assert.equal( /-\d+(\.jsonl/\.failed)?$/\.copying(\./$)/\.previous(\./$)/-(headless/acp)-session\.json$/^host-session$/^submission-ledger$/^attempt-history$/^auditor-roles$/.test(e | null |
| 191 | assert | `test/integration/analyst-c4-ticket-scope.test.ts:74` | assert.equal(actualRunIds.includes(RUN_NO_TICKET_PRIMARY), false); | null |
| 192 | assert | `test/integration/analyst-c4-ticket-scope.test.ts:76` | assert.equal(actualRunIds.includes(RUN_DECOY_TICKET_PRIMARY), false); | null |
| 193 | assert | `test/integration/analyst-c4-ticket-scope.test.ts:77` | assert.equal(actualRunIds.includes(RUN_NO_TICKET_ALIEN), false); | null |
| 194 | assert | `test/integration/analyst-c4-ticket-scope.test.ts:96` | assert.equal(actualRunIds.includes(RUN_FALLBACK_OUT), false); | null |
| 195 | assert | `test/integration/analyst-entry.test.ts:775` | assert.equal( "version" in (first.page as unknown as Record<string, unknown>), false, "page admits no readerless version field", ); | null |
| 196 | assert | `test/integration/analyst-entry.test.ts:784` | assert.equal( "a2SeamProbe" in (first.page as unknown as Record<string, unknown>), false, "retired a2-seam-probe must not appear on the issue page", ); | S 失效名缺席；名字 a2SeamProbe 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 197 | assert | `test/integration/analyst-public-cli.test.ts:117` | assert.equal(typeof PUBLIC_ROLE_ARGV.analyst.parse, "function"); | null |
| 198 | assert | `test/integration/analyst-public-cli.test.ts:120` | assert.equal(keys.includes("analyst"), true); | null |
| 199 | assert | `test/integration/analyst-public-cli.test.ts:305` | assert.equal(parseAnalystArgv([]).query, "issue"); | null |
| 200 | case | `test/integration/analyst-public-cli.test.ts:116` | PUBLIC_ROLE_ARGV registers analyst parse in the single production table | null |
| 201 | assert | `test/integration/audited-run-identity-1166.test.ts:334` | assert.equal(inspected.prompt, expectedPrompt); | null |
| 202 | assert | `test/integration/audited-run-identity-1166.test.ts:345` | assert.equal(inspected.pathMaterials.length, 0); | null |
| 203 | assert | `test/integration/audited-run-identity-1166.test.ts:383` | assert.notEqual(readableGateItem(first), readableGateItem(second)); | null |
| 204 | assert | `test/integration/audited-run-identity-1166.test.ts:455` | assert.equal(firstResult.exitCode, 0, firstIo.stderr.join("")); | null |
| 205 | assert | `test/integration/audited-run-identity-1166.test.ts:456` | assert.ok(notaryPrompts.length >= 1); | 仍在 test/integration/audited-run-identity-1166.test.ts:562 |
| 206 | assert | `test/integration/audited-run-identity-1166.test.ts:457` | assert.equal(notaryPrompts[0], NOTARY_FIXED_DISPATCH); | null |
| 207 | assert | `test/integration/audited-run-identity-1166.test.ts:472` | assert.equal(resumed.exitCode, 0, resumeIo.stderr.join("")); | null |
| 208 | assert | `test/integration/audited-run-identity-1166.test.ts:475` | assert.ok(notaryPrompts.length >= 2, "same parent must re-summon notary"); | 仍在 test/integration/audited-run-identity-1166.test.ts:581 |
| 209 | assert | `test/integration/audited-run-identity-1166.test.ts:476` | assert.equal(notaryPrompts.at(-1), NOTARY_FIXED_DISPATCH); | null |
| 210 | assert | `test/integration/audited-run-identity-1166.test.ts:559` | assert.equal(result.exitCode, 0); | null |
| 211 | assert | `test/integration/audited-run-identity-1166.test.ts:565` | assert.equal(inspected.pathMaterials.length, 0); | null |
| 212 | assert | `test/integration/audited-run-identity-1166.test.ts:566` | assert.equal( inspected.prompt, seat.role === "notary" ? NOTARY_FIXED_DISPATCH : expectedPrompt, ); | null |
| 213 | assert | `test/integration/audited-run-identity-1166.test.ts:571` | assert.equal(inspected.toolNames?.includes(AUDITOR_DOSSIER_TOOL_NAME), false); | null |
| 214 | assert | `test/integration/audited-run-identity-1166.test.ts:599` | assert.notEqual(readableGateItem(first), readableGateItem(second)); | null |
| 215 | assert | `test/integration/audited-run-identity-1166.test.ts:609` | assert.equal(request.continuation.prompt, NOTARY_FIXED_DISPATCH); | null |
| 216 | assert | `test/integration/audited-run-identity-1166.test.ts:612` | assert.equal(inspected.prompt, NOTARY_FIXED_DISPATCH); | null |
| 217 | assert | `test/integration/audited-run-identity-1166.test.ts:676` | assert.equal(notaryPrompts[0], NOTARY_FIXED_DISPATCH); | null |
| 218 | assert | `test/integration/audited-run-identity-1166.test.ts:696` | assert.equal(notaryPrompts.at(-1), NOTARY_FIXED_DISPATCH); | null |
| 219 | assert | `test/integration/audited-run-identity-1166.test.ts:707` | assert.equal( finalResult.terminal.roleOutcome.decisiveFacts?.notaryTerminal, undefined, "parent final must not project notaryTerminal", ); | null |
| 220 | case | `test/integration/audited-run-identity-1166.test.ts:236` | #1166 public gate: four seats share identity; first utterance is ledger submission | null |
| 221 | case | `test/integration/audited-run-identity-1166.test.ts:364` | #1166/#1208 same parent re-submits: notary fixed dispatch; auditor gets new ledger copy | null |
| 222 | case | `test/integration/audited-run-identity-1166.test.ts:480` | #1166/#1208 direct notary/auditor public entry: same identity; notary fixed, auditor peer body | null |
| 223 | case | `test/integration/audited-run-identity-1166.test.ts:582` | #1195 countersign→notary blind: fixed dispatch, never the countersign body, on gate and same-parent resubmit | null |
| 224 | assert | `test/integration/countersign-notary-gate.test.ts:53` | assert.equal(result.terminate, true); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:85 类别 B；承接 null |
| 225 | assert | `test/integration/countersign-notary-gate.test.ts:54` | assert.deepEqual(result.details, { status: "converged" }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:85 类别 B；承接 null |
| 226 | assert | `test/integration/countersign-notary-gate.test.ts:66` | assert.equal(result.terminate, true); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:85 类别 B；承接 null |
| 227 | assert | `test/integration/countersign-notary-gate.test.ts:67` | assert.deepEqual(result.details, { status: "escalate", note: "need owner" }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:85 类别 B；承接 null |
| 228 | assert | `test/integration/countersign-notary-gate.test.ts:79` | assert.equal(result.terminate, true); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:85 类别 B；承接 null |
| 229 | assert | `test/integration/countersign-notary-gate.test.ts:80` | assert.deepEqual(result.details, { status: "not-a-status", note: "typo" }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:85 类别 B；承接 null |
| 230 | case | `test/integration/countersign-notary-gate.test.ts:44` | countersign output finishes before Notary is summoned | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:85 类别 B；承接 null |
| 231 | case | `test/integration/countersign-notary-gate.test.ts:57` | countersign escalate skips Notary gate and accepts as-is (#753) | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:85 类别 B；承接 null |
| 232 | case | `test/integration/countersign-notary-gate.test.ts:70` | countersign unreadable status files before public queue reask (#1057) | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:85 类别 B；承接 null |
| 233 | assert | `test/integration/engine-detour-cancel-idle.test.ts:139` | assert.equal( settled, undefined, "silent detour must not be killed by a removed package-owned tool idle clock", ); | null |
| 234 | assert | `test/integration/engine-detour-cancel-idle.test.ts:147` | await assert.rejects(pending, (error: unknown) => error === reason); | 仍在 test/integration/engine-detour-cancel-idle.test.ts:47 |
| 235 | case | `test/integration/engine-detour-cancel-idle.test.ts:110` | silent detour child is not cut by a package-owned tool idle backstop | null |
| 236 | assert | `test/integration/engine-material.test.ts:19` | assert.deepEqual(listEngineMaterialNames(root), []); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:89 类别 D；承接 null |
| 237 | assert | `test/integration/engine-material.test.ts:22` | assert.deepEqual(listEngineMaterialNames(root), ["only"]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:89 类别 D；承接 null |
| 238 | case | `test/integration/engine-material.test.ts:17` | packaged notes directory is discovery-only; missing notes is not an error | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:89 类别 D；承接 null |
| 239 | assert | `test/integration/factory-board-true-home.test.ts:46` | assert.ok( await pathExists(home127), "true-home acceptance requires home #127 (authentic accepted-toolResult trajectory)", ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 240 | assert | `test/integration/factory-board-true-home.test.ts:78` | assert.ok( expected127.length >= 1, "true-home #127 must contain at least one accepted terminating toolResult", ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 241 | assert | `test/integration/factory-board-true-home.test.ts:84` | assert.ok(namedFixer, "true-home #127 must keep named fixer-apply-001 accepted receipt"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 242 | assert | `test/integration/factory-board-true-home.test.ts:85` | assert.equal(namedFixer.resultStatus, "completed"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 243 | assert | `test/integration/factory-board-true-home.test.ts:88` | assert.ok(expected130.runCount >= 1, "#130 must have runs"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 244 | assert | `test/integration/factory-board-true-home.test.ts:89` | assert.ok(expected130.reviewerRunCount >= 1, "#130 reviewer rounds present"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 245 | assert | `test/integration/factory-board-true-home.test.ts:94` | assert.ok( flyingOffsetMs < UNACCEPTED_FLYING_MS, "probe offset must stay inside the flying band", ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 246 | assert | `test/integration/factory-board-true-home.test.ts:106` | assert.ok(activeLeg, `true-home #${activeIssue} must have at least one run`); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 247 | assert | `test/integration/factory-board-true-home.test.ts:107` | assert.equal( activeLeg.hasAcceptedResult, false, `true-home #${activeIssue} latest ${activeLeg.runId} must be unaccepted (no accepted terminating toolResult)`, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 248 | assert | `test/integration/factory-board-true-home.test.ts:112` | assert.ok( activeLeg.mtimeMs > 0, `true-home #${activeIssue} latest ${activeLeg.runId} must expose session mtime`, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 249 | assert | `test/integration/factory-board-true-home.test.ts:122` | assert.ok( expectedDisplayActivityAt, `true-home #${activeIssue} latest must yield last-activity (content ts or mtime)`, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 250 | assert | `test/integration/factory-board-true-home.test.ts:170` | assert.equal(await treeFingerprint(ledgerDir), before, "true-home acceptance stays read-only"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 251 | assert | `test/integration/factory-board-true-home.test.ts:175` | assert.ok(t127 && t130 && family78); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 252 | assert | `test/integration/factory-board-true-home.test.ts:176` | assert.equal(t130["data-parent-issue"], "78"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 253 | assert | `test/integration/factory-board-true-home.test.ts:177` | assert.equal(t127["data-parent-issue"], "78"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 254 | assert | `test/integration/factory-board-true-home.test.ts:184` | assert.ok(runs127.length >= expected127.length, "board retains true-home #127 runs"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 255 | assert | `test/integration/factory-board-true-home.test.ts:187` | assert.ok(row, `true-home #127 accepted run visible: ${expected.runId}`); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 256 | assert | `test/integration/factory-board-true-home.test.ts:188` | assert.equal(row["data-has-result"], "true", `${expected.runId} accepted toolResult`); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 257 | assert | `test/integration/factory-board-true-home.test.ts:189` | assert.equal( row["data-result-status"], expected.resultStatus, `${expected.runId} status from accepted toolResult`, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 258 | assert | `test/integration/factory-board-true-home.test.ts:197` | assert.equal(namedOnBoard?.["data-has-result"], "true"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 259 | assert | `test/integration/factory-board-true-home.test.ts:198` | assert.equal(namedOnBoard?.["data-result-status"], "completed"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 260 | assert | `test/integration/factory-board-true-home.test.ts:199` | assert.ok( t127["data-current-state"] === "accepted-awaiting" // (t127["data-current-state"] ?? "").startsWith("unaccepted-"), "current state remains a mechanical latest-run partit | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 261 | assert | `test/integration/factory-board-true-home.test.ts:206` | assert.equal(Number(t130["data-run-count"]), expected130.runCount); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 262 | assert | `test/integration/factory-board-true-home.test.ts:207` | assert.ok(Math.abs(Number(t130["data-cost-usd"]) - expected130.costUsd) < 1e-9); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 263 | assert | `test/integration/factory-board-true-home.test.ts:208` | assert.equal(Number(t130["data-total-tokens"]), expected130.totalTokens); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 264 | assert | `test/integration/factory-board-true-home.test.ts:214` | assert.equal(runs130.length, expected130.runCount); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 265 | assert | `test/integration/factory-board-true-home.test.ts:216` | assert.equal(reviewerRuns130.length, expected130.reviewerRunCount, "#130 御史台 multi-round runs"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 266 | assert | `test/integration/factory-board-true-home.test.ts:226` | assert.ok( Math.abs(boardReviewerCost - expected130.reviewerCostUsd) < 1e-9, `#130 reviewer cost board=${boardReviewerCost} independent=${expected130.reviewerCostUsd}`, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 267 | assert | `test/integration/factory-board-true-home.test.ts:230` | assert.equal(boardReviewerTokens, expected130.reviewerTokens); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 268 | assert | `test/integration/factory-board-true-home.test.ts:231` | assert.ok(Math.abs(boardReviewerAxisWall - expected130.axisWallMs) < 1); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 269 | assert | `test/integration/factory-board-true-home.test.ts:233` | assert.ok( elementsWith(html, "data-station-block").some((s) => s["data-station-block"] === "reviewer"), "#130 御史台 station block rendered", ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 270 | assert | `test/integration/factory-board-true-home.test.ts:240` | assert.ok(familyCost + 1e-9 >= Number(t130["data-cost-usd"])); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 271 | assert | `test/integration/factory-board-true-home.test.ts:242` | assert.ok(sorted.includes(78), "#78 family is a sort entry"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 272 | assert | `test/integration/factory-board-true-home.test.ts:244` | assert.ok(!sorted.includes(130), "#130 stays nested under family; burn rides aggregate"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 273 | assert | `test/integration/factory-board-true-home.test.ts:248` | assert.ok( sorted.indexOf(78) < sorted.length, "#78 family carrying #130 still participates in page sort order", ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 274 | assert | `test/integration/factory-board-true-home.test.ts:258` | assert.ok(tActive, `true-home active #${activeIssue} ticket rendered`); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 275 | assert | `test/integration/factory-board-true-home.test.ts:260` | assert.ok(sorted.includes(activeIssue), "active ticket remains a sort entry"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 276 | assert | `test/integration/factory-board-true-home.test.ts:262` | assert.equal(sorted[0], 78, "#78 family (with #130 burn) leads when it outburns active"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 277 | assert | `test/integration/factory-board-true-home.test.ts:264` | assert.ok( sorted.indexOf(78) < sorted.length, "#78 family carrying #130 still participates in page sort order", ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 278 | assert | `test/integration/factory-board-true-home.test.ts:272` | assert.equal( tActive["data-current-state"], "unaccepted-flying", `true-home #${activeIssue} latest ${activeLeg.runId} must be 在飞 at honest now=${now.toISOString()} mtimeMs=${activ | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 279 | assert | `test/integration/factory-board-true-home.test.ts:279` | assert.ok(visibleAge, `true-home #${activeIssue} must render visible leg-age label`); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 280 | assert | `test/integration/factory-board-true-home.test.ts:280` | assert.ok(visibleAct, `true-home #${activeIssue} must render visible last-activity label`); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 281 | assert | `test/integration/factory-board-true-home.test.ts:281` | assert.equal(visibleAct["data-last-activity-at"], expectedDisplayActivityAt); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 282 | assert | `test/integration/factory-board-true-home.test.ts:282` | assert.equal(visibleAct["data-last-activity-mtime-ms"], String(activeLeg.mtimeMs)); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 283 | assert | `test/integration/factory-board-true-home.test.ts:283` | assert.equal(Number(visibleAge["data-leg-age-ms"]), expectedLegAgeMs); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 284 | assert | `test/integration/factory-board-true-home.test.ts:284` | assert.ok(Number(visibleAge["data-leg-age-ms"]) >= flyingOffsetMs); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 285 | assert | `test/integration/factory-board-true-home.test.ts:286` | assert.equal(tActive["data-last-activity-at"], visibleAct["data-last-activity-at"]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 286 | assert | `test/integration/factory-board-true-home.test.ts:287` | assert.equal(tActive["data-last-activity-mtime-ms"], visibleAct["data-last-activity-mtime-ms"]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 287 | assert | `test/integration/factory-board-true-home.test.ts:288` | assert.equal(tActive["data-leg-age-ms"], visibleAge["data-leg-age-ms"]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 288 | case | `test/integration/factory-board-true-home.test.ts:27` | S3 true-home acceptance: #127 accepted trajectory, active leg, #130 cost reconciliation | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:90 类别 D/S；承接 null |
| 289 | assert | `test/integration/factory-board.test.ts:1004` | assert.equal( elementsWith(html, "data-threshold-flying-ms")[0]?.["data-threshold-flying-ms"], String(UNACCEPTED_FLYING_MS), ); | null |
| 290 | assert | `test/integration/factory-board.test.ts:1008` | assert.equal( elementsWith(html, "data-threshold-watch-ms")[0]?.["data-threshold-watch-ms"], String(UNACCEPTED_WATCH_MS), ); | null |
| 291 | assert | `test/integration/factory-board.test.ts:1561` | assert.equal( elementsWith(html, banned).length, 0, `board must not project ${banned}`, ); | null |
| 292 | assert | `test/integration/factory-board.test.ts:1572` | assert.match(t["data-current-state"] ?? "", /^unaccepted-/); | 仍在 test/integration/factory-board.test.ts:1120 |
| 293 | assert | `test/integration/factory-board.test.ts:2134` | assert.equal(DEFAULT_REFRESH_BOUNDARY_SECONDS, 30); | null |
| 294 | assert | `test/integration/factory-board.test.ts:3302` | assert.equal(page.badgeSummary.textContent, "未知票 ×0"); | null |
| 295 | case | `test/integration/factory-board.test.ts:1493` | S3 board projects no textual conclusion and excludes unlabelled narrative self-report | null |
| 296 | assert | `test/integration/gate-officer-resume-accounting.test.ts:245` | assert.equal( "materials" in request, false, "station-child officer must not grow a materials field on RoleTurnRequest", ); | null |
| 297 | assert | `test/integration/gate-officer-resume-accounting.test.ts:301` | assert.equal(prompts[i + 1], NOTARY_FIXED_DISPATCH); | null |
| 298 | assert | `test/integration/gate-officer-resume-accounting.test.ts:450` | assert.equal("materials" in request, false); | null |
| 299 | assert | `test/integration/gate-officer-resume-accounting.test.ts:475` | assert.equal(projected.result.status, "converged"); | 仍在 test/integration/gate-officer-resume-accounting.test.ts:180 |
| 300 | assert | `test/integration/gate-officer-resume-accounting.test.ts:476` | assert.ok(prompts.length >= 1); | null |
| 301 | assert | `test/integration/gate-officer-resume-accounting.test.ts:477` | assert.equal(prompts[prompts.length - 1], NOTARY_FIXED_DISPATCH); | null |
| 302 | assert | `test/integration/gate-officer-resume-accounting.test.ts:480` | assert.ok(officerRun, "officer run directory must exist"); | null |
| 303 | assert | `test/integration/gate-officer-resume-accounting.test.ts:482` | await assert.rejects( () => access(join(officerRun!, "attachments", "case-dossier")), (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOEN | null |
| 304 | assert | `test/integration/gate-officer-resume-accounting.test.ts:508` | assert.deepEqual(JSON.parse(prepared.prompt), body); | null |
| 305 | assert | `test/integration/gate-officer-resume-accounting.test.ts:515` | assert.equal(dossiers.length, 0); | null |
| 306 | assert | `test/integration/gate-officer-resume-accounting.test.ts:523` | await assert.rejects( () => access(join(officerRun!, ".case-dossier-stage")), (error: unknown) => error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT", ); | null |
| 307 | case | `test/integration/gate-officer-resume-accounting.test.ts:209` | #879/#1208 notary each turn receives fixed dispatch — not history array or parent body | null |
| 308 | case | `test/integration/gate-officer-resume-accounting.test.ts:413` | #1092/#1208 station-child notary: no case-dossier pointer material; dialogue = fixed dispatch | null |
| 309 | assert | `test/integration/host-session-acp-grok-usage-compact.test.ts:150` | assert.equal("ordinal" in (copyRec.payload as object), false); | null |
| 310 | assert | `test/integration/host-session-acp-write-fail.test.ts:93` | assert.equal(stderrChunks.length, 2); | null |
| 311 | assert | `test/integration/host-session-live-records.test.ts:160` | assert.equal("ordinal" in (copyRec.payload as object), false); | null |
| 312 | assert | `test/integration/host-session-live-records.test.ts:229` | assert.equal(stderrChunks.length, 3); | null |
| 313 | assert | `test/integration/host-session-live-records.test.ts:241` | assert.equal(stderrChunks.length, 6); | null |
| 314 | assert | `test/integration/merger-role.test.ts:56` | assert.equal(result.terminate, true); assert.deepEqual(result.details, args); | null |
| 315 | assert | `test/integration/merger-role.test.ts:60` | assert.equal(again.terminate, true); assert.deepEqual(again.details, args); | null |
| 316 | assert | `test/integration/merger-role.test.ts:67` | assert.equal(accepted.terminate, true); | null |
| 317 | assert | `test/integration/merger-role.test.ts:68` | assert.equal(accepted.details.status, "completed"); | null |
| 318 | assert | `test/integration/merger-role.test.ts:69` | assert.deepEqual(accepted.details, args); | null |
| 319 | case | `test/integration/merger-role.test.ts:52` | Merger accepts one honest escalation without Git success verification | null |
| 320 | case | `test/integration/merger-role.test.ts:63` | Merger accepts completed receipt without path-scope/completion Git verification gate | null |
| 321 | assert | `test/integration/public-cli-1132-delivery-request.test.ts:796` | assert.equal( result.terminal.roleOutcome.decisiveFacts?.officerPayloads, undefined, "parent/other-seat payload copies must not ride the returned terminal", ); | null |
| 322 | assert | `test/integration/public-cli-1132-delivery-request.test.ts:879` | assert.equal( opened.terminal?.roleOutcome.decisiveFacts?.officerPayloads, undefined, `limit ${limit}: no other-seat payload copy`, ); | null |
| 323 | assert | `test/integration/public-cli-1169-relocate-resume-no-unbound-paths.test.ts:254` | assert.equal(topLevel.has(forbidden), false, `topology forbids ${forbidden}`); | null |
| 324 | assert | `test/integration/public-cli-1169-relocate-resume-no-unbound-paths.test.ts:297` | assert.equal("frozenPath" in attachment, false); | S 失效名缺席；名字 frozenPath 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 325 | assert | `test/integration/public-cli-argv-parsers.test.ts:34` | assert.deepEqual(parsePublicSeatArgv("coder", ["Implement the slice."]), { phase: "apply", instruction: "Implement the slice.", attachmentPaths: [], }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 326 | assert | `test/integration/public-cli-argv-parsers.test.ts:39` | assert.deepEqual(parsePublicSeatArgv("coder", ["plan", "Propose first cut."]), { phase: "plan", instruction: "Propose first cut.", attachmentPaths: [], }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 327 | assert | `test/integration/public-cli-argv-parsers.test.ts:44` | assert.deepEqual( parsePublicSeatArgv("coder", [ "apply", "--attach", "a.md", "--project", "/tmp/p", "Do the work.", ]), { phase: "apply", instruction: "Do the work.", attachmentPa | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 328 | assert | `test/integration/public-cli-argv-parsers.test.ts:60` | assert.throws(() => parsePublicSeatArgv("coder", ["--unknown-flag"]), isUsage); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 329 | assert | `test/integration/public-cli-argv-parsers.test.ts:61` | assert.throws(() => parsePublicSeatArgv("coder", ["--project", "", "task"]), isUsage); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 330 | assert | `test/integration/public-cli-argv-parsers.test.ts:70` | await assert.rejects( () => admitPublicRole("coder", { phase: "apply", instruction: " ", attachmentPaths: [], }, { principalAuthority: piDurablePrincipalAuthority, home, cwd: proje | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 331 | assert | `test/integration/public-cli-argv-parsers.test.ts:95` | assert.equal(admitted.role, "coder"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 332 | assert | `test/integration/public-cli-argv-parsers.test.ts:96` | assert.equal(admitted.phase, "plan"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 333 | assert | `test/integration/public-cli-argv-parsers.test.ts:97` | assert.equal(admitted.instruction, "Plan the first vertical slice."); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 334 | assert | `test/integration/public-cli-argv-parsers.test.ts:98` | assert.equal("taskPath" in admitted, false); | S 失效名缺席；名字 taskPath 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 335 | assert | `test/integration/public-cli-argv-parsers.test.ts:99` | await assert.rejects( () => access(join(admitted.runDirectory, "task.md")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 336 | assert | `test/integration/public-cli-argv-parsers.test.ts:105` | assert.equal( admitted.runDirectory, join(home, ".ak-roles", "books", bookKey, "unbound", "runs", "run-coder-plan-001@coder"), ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 337 | assert | `test/integration/public-cli-argv-parsers.test.ts:114` | assert.equal(persisted.role, "coder"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 338 | assert | `test/integration/public-cli-argv-parsers.test.ts:115` | assert.equal(persisted.phase, "plan"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 339 | assert | `test/integration/public-cli-argv-parsers.test.ts:117` | assert.equal(persisted.instruction, "Plan the first vertical slice."); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 340 | assert | `test/integration/public-cli-argv-parsers.test.ts:122` | assert.deepEqual(parsePublicSeatArgv("collector", ["--pr", "1168", "--repo", "acme/widgets"]), { prNumber: 1168, repo: "acme/widgets", instruction: "", attachmentPaths: [], }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 341 | assert | `test/integration/public-cli-argv-parsers.test.ts:131` | assert.throws( () => parsePublicSeatArgv("collector", ["--pr", "1168", "--repo", "acme/widgets", "--wait-ms", "120000"]), (error: unknown) => error instanceof CliUsageError, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 342 | assert | `test/integration/public-cli-argv-parsers.test.ts:138` | assert.deepEqual(parsePublicSeatArgv("doctor", ["--issue", "40", "note"]), { issueNumber: 40, instruction: "note", attachmentPaths: [], }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 343 | assert | `test/integration/public-cli-argv-parsers.test.ts:143` | assert.deepEqual( parsePublicSeatArgv("doctor", [ "--issue", "7", "--runs", ".ak-roles/books/demo/7/runs", "--project", "/tmp/p", "--attach", "/tmp/a.md", ]), { issueNumber: 7, run | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 344 | assert | `test/integration/public-cli-argv-parsers.test.ts:177` | assert.throws(() => parsePublicSeatArgv("doctor", [...raw]), (error: unknown) => error instanceof CliUsageError && error.code === "AK_ROLE_USAGE", JSON.stringify(raw)); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 345 | assert | `test/integration/public-cli-argv-parsers.test.ts:185` | assert.deepEqual(parsePublicSeatArgv("fixer", ["Repair the class."]), { phase: "apply", instruction: "Repair the class.", attachmentPaths: [], }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 346 | assert | `test/integration/public-cli-argv-parsers.test.ts:190` | assert.deepEqual(parsePublicSeatArgv("fixer", ["plan", "Propose the repair."]), { phase: "plan", instruction: "Propose the repair.", attachmentPaths: [], }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 347 | assert | `test/integration/public-cli-argv-parsers.test.ts:195` | assert.deepEqual( parsePublicSeatArgv("fixer", [ "apply", "--prerequisites", "prereq.json", "--attach", "a.md", "--project", "/tmp/p", "Settle findings.", ]), { phase: "apply", ins | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 348 | assert | `test/integration/public-cli-argv-parsers.test.ts:215` | assert.deepEqual( parsePublicSeatArgv("fixer", ["--prerequisites", "", "Repair."]), { phase: "apply", instruction: "Repair.", attachmentPaths: [], prerequisitesPath: "", }, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 349 | assert | `test/integration/public-cli-argv-parsers.test.ts:224` | assert.throws(() => parsePublicSeatArgv("fixer", ["--unknown-flag"]), isUsage); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 350 | assert | `test/integration/public-cli-argv-parsers.test.ts:225` | assert.throws(() => parsePublicSeatArgv("fixer", ["--prerequisites"]), isUsage); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 351 | assert | `test/integration/public-cli-argv-parsers.test.ts:226` | assert.throws(() => parsePublicSeatArgv("fixer", ["--project", "", "task"]), isUsage); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 352 | assert | `test/integration/public-cli-argv-parsers.test.ts:241` | assert.equal(fromPersistent.engine, "cursor"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 353 | assert | `test/integration/public-cli-argv-parsers.test.ts:242` | assert.equal(fromPersistent.engineSource, "persistent"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 354 | assert | `test/integration/public-cli-argv-parsers.test.ts:243` | assert.equal(fromPersistent.source, "persistent"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 355 | assert | `test/integration/public-cli-argv-parsers.test.ts:248` | assert.equal(fromInvocation.engine, "opus"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 356 | assert | `test/integration/public-cli-argv-parsers.test.ts:249` | assert.equal(fromInvocation.engineSource, "invocation"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 357 | assert | `test/integration/public-cli-argv-parsers.test.ts:251` | assert.equal(fromInvocation.source, "persistent"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 358 | assert | `test/integration/public-cli-argv-parsers.test.ts:252` | assert.deepEqual(fromInvocation.selection, { provider: "xai", model: "grok-4.5", thinking: "high", }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 359 | assert | `test/integration/public-cli-argv-parsers.test.ts:259` | assert.equal(bare.engine, undefined); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 360 | assert | `test/integration/public-cli-argv-parsers.test.ts:260` | assert.equal(bare.engineSource, "unconfigured"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 361 | assert | `test/integration/public-cli-argv-parsers.test.ts:273` | assert.equal(reviewerPersistent.engine, "cursor"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 362 | assert | `test/integration/public-cli-argv-parsers.test.ts:274` | assert.equal(reviewerPersistent.engineSource, "persistent"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 363 | assert | `test/integration/public-cli-argv-parsers.test.ts:278` | assert.equal(reviewerInvocation.engine, "opus"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 364 | assert | `test/integration/public-cli-argv-parsers.test.ts:279` | assert.equal(reviewerInvocation.engineSource, "invocation"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 365 | assert | `test/integration/public-cli-argv-parsers.test.ts:285` | assert.equal(fixer.engine, "opus"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 366 | assert | `test/integration/public-cli-argv-parsers.test.ts:286` | assert.equal(fixer.engineSource, "invocation"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 367 | case | `test/integration/public-cli-argv-parsers.test.ts:30` | parseCoderArgv defaults to apply and preserves explicit plan/apply | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 368 | case | `test/integration/public-cli-argv-parsers.test.ts:64` | admitCoderInvocation rejects blank task and freezes plan phase | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 369 | case | `test/integration/public-cli-argv-parsers.test.ts:121` | public Collector accepts PR/repository without an observer declaration | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 370 | case | `test/integration/public-cli-argv-parsers.test.ts:130` | #1088 public Collector --wait-ms is retired with code collection | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 371 | case | `test/integration/public-cli-argv-parsers.test.ts:137` | parseDoctorArgv requires positive issue; accepts optional runs and rejects malformed grammar | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 372 | case | `test/integration/public-cli-argv-parsers.test.ts:181` | parseFixerArgv defaults to apply and preserves explicit plan/apply plus prerequisites path | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 373 | case | `test/integration/public-cli-argv-parsers.test.ts:229` | engine priority: invocation > persistent > unconfigured (judge only) | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:104 类别 D/M；承接 null |
| 374 | assert | `test/integration/public-cli-attach-path-passthrough.test.ts:102` | assert.equal(existsSync(join(runDirectory, "attachments")), false); | null |
| 375 | assert | `test/integration/public-cli-attach-path-passthrough.test.ts:118` | assert.equal("frozenPath" in attachment, false); | S 失效名缺席；名字 frozenPath 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 376 | assert | `test/integration/public-cli-attach-path-passthrough.test.ts:119` | assert.equal("sha256" in attachment, false); | null |
| 377 | assert | `test/integration/public-cli-attach-path-passthrough.test.ts:120` | assert.equal("byteLength" in attachment, false); | null |
| 378 | assert | `test/integration/public-cli-attach-path-passthrough.test.ts:121` | assert.equal("provenancePath" in attachment, false); | S 失效名缺席；名字 provenancePath 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 379 | assert | `test/integration/public-cli-attach-path-passthrough.test.ts:211` | await assert.rejects( () => access(join(runDirectory, "request-manifest.json")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", ); | null |
| 380 | assert | `test/integration/public-cli-attach-path-passthrough.test.ts:226` | assert.equal("manifestDigest" in current.admitted, false); | null |
| 381 | assert | `test/integration/public-cli-auto-resume-limit-422.test.ts:62` | assert.equal(calls,5); | null |
| 382 | assert | `test/integration/public-cli-auto-resume-limit-422.test.ts:63` | assert.equal(result.exitCode,1); | 仍在 test/integration/public-cli-auto-resume-limit-422.test.ts:60 |
| 383 | assert | `test/integration/public-cli-auto-resume-limit-422.test.ts:82` | assert.equal(calls,1); | null |
| 384 | assert | `test/integration/public-cli-auto-resume-limit-422.test.ts:83` | assert.equal(result.exitCode,1); | 仍在 test/integration/public-cli-auto-resume-limit-422.test.ts:60 |
| 385 | case | `test/integration/public-cli-auto-resume-limit-422.test.ts:46` | #422 loop honors injected effective limit once (N=4 → 5 dispatches, count=4) | null |
| 386 | case | `test/integration/public-cli-auto-resume-limit-422.test.ts:67` | #422 loop with injected limit 0 disables auto resume (single dispatch) | null |
| 387 | assert | `test/integration/public-cli-cli.test.ts:110` | assert.equal(doc.executable, "ak-role"); | null |
| 388 | assert | `test/integration/public-cli-cli.test.ts:112` | assert.equal(names.includes("roles"), true); | null |
| 389 | assert | `test/integration/public-cli-cli.test.ts:113` | assert.equal(names.includes("config"), true); | null |
| 390 | assert | `test/integration/public-cli-cli.test.ts:114` | assert.equal(names.includes("help"), true); | null |
| 391 | assert | `test/integration/public-cli-cli.test.ts:116` | assert.equal(names.includes(role), true); | null |
| 392 | assert | `test/integration/public-cli-cli.test.ts:185` | assert.equal(invocationEffective.source, "invocation"); | null |
| 393 | assert | `test/integration/public-cli-cli.test.ts:186` | assert.deepEqual(invocationEffective.selection, { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high", }); | null |
| 394 | assert | `test/integration/public-cli-cli.test.ts:205` | assert.equal(bareRoles.exitCode, 0); | null |
| 395 | assert | `test/integration/public-cli-cli.test.ts:212` | assert.equal(bareEffective.source, "invocation"); | null |
| 396 | assert | `test/integration/public-cli-cli.test.ts:213` | assert.deepEqual(bareEffective.selection, { provider: "kimi-coding", model: "k3-256k", }); | null |
| 397 | assert | `test/integration/public-cli-cli.test.ts:275` | assert.equal( resolveEffectiveSeat(gatePersisted, "gatekeeper", { "openai-codex": true, xai: true, }).source, "persistent", ); | null |
| 398 | case | `test/integration/public-cli-cli.test.ts:108` | help document capabilities match typed registry without depending on layout | null |
| 399 | case | `test/integration/public-cli-cli.test.ts:123` | config persistence round-trips across processes on the typed seat face | null |
| 400 | assert | `test/integration/public-cli-coder.test.ts:153` | assert.equal(req.continuation.prompt.startsWith("/skill:"), false); | null |
| 401 | assert | `test/integration/public-cli-coder.test.ts:563` | assert.equal("taskPath" in admitted, false); | S 失效名缺席；名字 taskPath 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 402 | assert | `test/integration/public-cli-coder.test.ts:565` | assert.equal(existsSync(join(sessionDirectory, "worker-submission-gate")), false); | null |
| 403 | assert | `test/integration/public-cli-coder.test.ts:582` | assert.equal(args.includes("--ak-coder-task"), false); | null |
| 404 | assert | `test/integration/public-cli-coder.test.ts:623` | assert.equal(existsSync(join(sessionDirectory, "worker-submission-gate")), false); | null |
| 405 | assert | `test/integration/public-cli-coder.test.ts:884` | assert.equal(dispatched, false, `${badSpec} must not reach pi dispatch`); | null |
| 406 | assert | `test/integration/public-cli-coder.test.ts:885` | assert.notEqual(result.exitCode, 0, `${badSpec} must be rejected`); | null |
| 407 | case | `test/integration/public-cli-coder.test.ts:478` | ak-role resume continues relocated coder plan phase without a gate nest | null |
| 408 | assert | `test/integration/public-cli-collector.test.ts:71` | assert.equal(result.exitCode, 0); | null |
| 409 | assert | `test/integration/public-cli-collector.test.ts:72` | assert.deepEqual(result.terminal && (objectPayloads(result.terminal.roleOutcome)[0] ?? {}).groups, receipt().groups); | null |
| 410 | assert | `test/integration/public-cli-collector.test.ts:81` | assert.deepEqual(submitted[0]?.groups, receipt().groups); | null |
| 411 | assert | `test/integration/public-cli-collector.test.ts:82` | assert.equal(stdout.length > 0, true); | null |
| 412 | assert | `test/integration/public-cli-collector.test.ts:87` | assert.throws( () => parsePublicSeatArgv("collector", ["--pr", "1", "--repo", "a/b", "--wait-ms", "120000"]), (error: unknown) => error instanceof CliUsageError, ); | null |
| 413 | assert | `test/integration/public-cli-collector.test.ts:116` | assert.equal(result.exitCode, 0); | null |
| 414 | assert | `test/integration/public-cli-collector.test.ts:117` | assert.equal( result.terminal && (objectPayloads(result.terminal.roleOutcome)[0] ?? {}).prState, "MERGED", ); | null |
| 415 | case | `test/integration/public-cli-collector.test.ts:47` | typed groups travel from real output settlement into the report artifact | null |
| 416 | case | `test/integration/public-cli-collector.test.ts:86` | #1088 public Collector rejects retired --wait-ms | null |
| 417 | case | `test/integration/public-cli-collector.test.ts:93` | #676 J2 MERGED prState travels from sealed receipt into public Terminal | null |
| 418 | assert | `test/integration/public-cli-config.test.ts:48` | assert.deepEqual(reloaded.seats.judge, { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high", }); | null |
| 419 | assert | `test/integration/public-cli-config.test.ts:53` | assert.deepEqual(reloaded.seats.navigator, { provider: "xai", model: "grok-4.5", thinking: "medium", }); | null |
| 420 | assert | `test/integration/public-cli-config.test.ts:58` | assert.equal(publicCliConfigPath(home).endsWith("public-cli.json"), true); | null |
| 421 | assert | `test/integration/public-cli-config.test.ts:60` | assert.deepEqual(raw.seats.judge?.model, "gpt-5.6-sol"); | null |
| 422 | assert | `test/integration/public-cli-config.test.ts:85` | assert.equal(effective.source, "invocation"); | null |
| 423 | assert | `test/integration/public-cli-config.test.ts:86` | assert.deepEqual(effective.selection, { provider: "xai", model: "grok-4.5", thinking: "medium", }); | null |
| 424 | assert | `test/integration/public-cli-config.test.ts:108` | assert.deepEqual(seats, [ "judge", "fixer", "coder", "reviewer", "collector", "doctor", "merger", "notary", "countersign", "secretariat", "gleaner-left", "inspector", "gatekeeper", | null |
| 425 | assert | `test/integration/public-cli-config.test.ts:332` | assert.equal(effective.source, "persistent"); | 仍在 test/integration/public-cli-config.test.ts:314 |
| 426 | assert | `test/integration/public-cli-config.test.ts:333` | assert.deepEqual(effective.selection, { provider: "xai", model: "grok-4.5", thinking: "high", }); | null |
| 427 | assert | `test/integration/public-cli-config.test.ts:343` | assert.deepEqual(bare, { provider: "kimi-coding", model: "k3-256k", }); | null |
| 428 | assert | `test/integration/public-cli-config.test.ts:347` | assert.equal("thinking" in bare, false); | null |
| 429 | assert | `test/integration/public-cli-config.test.ts:348` | assert.equal(formatModelSpec(bare), "kimi-coding/k3-256k"); | null |
| 430 | assert | `test/integration/public-cli-config.test.ts:356` | assert.equal(effective.source, "invocation"); | null |
| 431 | assert | `test/integration/public-cli-config.test.ts:357` | assert.deepEqual(effective.selection, { provider: "kimi-coding", model: "k3-256k", }); | null |
| 432 | assert | `test/integration/public-cli-config.test.ts:361` | assert.equal(effective.selection !== undefined && "thinking" in effective.selection, false); | null |
| 433 | assert | `test/integration/public-cli-config.test.ts:366` | assert.deepEqual(withThinking, { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high", }); | null |
| 434 | assert | `test/integration/public-cli-config.test.ts:371` | assert.equal(formatModelSpec(withThinking), "openai-codex/gpt-5.6-luna:high"); | null |
| 435 | assert | `test/integration/public-cli-config.test.ts:379` | assert.deepEqual(effective.selection, { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "medium", }); | null |
| 436 | assert | `test/integration/public-cli-config.test.ts:388` | assert.throws(() => parseModelSpec(modelSpec), Error); | null |
| 437 | assert | `test/integration/public-cli-config.test.ts:391` | assert.deepEqual(parseModelSpec("openai-codex/gpt-5.6-luna:bogus"), { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "bogus", }); | null |
| 438 | assert | `test/integration/public-cli-config.test.ts:396` | assert.deepEqual(parseModelSpec("openai-codex/gpt-5.6-luna:xhigh"), { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "xhigh", }); | null |
| 439 | assert | `test/integration/public-cli-config.test.ts:401` | assert.deepEqual(parseModelSpec("openai-codex/gpt-5.6-luna:"), { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "", }); | null |
| 440 | assert | `test/integration/public-cli-config.test.ts:407` | assert.deepEqual(parseModelSpec("no-such-provider/no-such-model"), { provider: "no-such-provider", model: "no-such-model", }); | null |
| 441 | assert | `test/integration/public-cli-config.test.ts:416` | assert.deepEqual(bare, { provider: "kimi-coding", model: "k3-256k", }); | null |
| 442 | assert | `test/integration/public-cli-config.test.ts:420` | assert.equal("thinking" in bare, false); | null |
| 443 | assert | `test/integration/public-cli-config.test.ts:421` | assert.deepEqual(buildSeatModelCliArgs(bare), [ "--provider", "kimi-coding", "--model", "k3-256k", ]); | null |
| 444 | assert | `test/integration/public-cli-config.test.ts:432` | assert.deepEqual(reloaded.seats.judge, { provider: "kimi-coding", model: "k3-256k", }); | null |
| 445 | assert | `test/integration/public-cli-config.test.ts:436` | assert.equal(reloaded.seats.judge !== undefined && "thinking" in reloaded.seats.judge, false); | null |
| 446 | assert | `test/integration/public-cli-config.test.ts:442` | assert.equal(effective.source, "persistent"); | 仍在 test/integration/public-cli-config.test.ts:314 |
| 447 | assert | `test/integration/public-cli-config.test.ts:443` | assert.deepEqual(effective.selection, { provider: "kimi-coding", model: "k3-256k", }); | null |
| 448 | assert | `test/integration/public-cli-config.test.ts:447` | assert.equal( effective.selection !== undefined && "thinking" in effective.selection, false, ); | null |
| 449 | assert | `test/integration/public-cli-config.test.ts:451` | assert.equal(formatModelSpec(effective.selection!), "kimi-coding/k3-256k"); | null |
| 450 | case | `test/integration/public-cli-config.test.ts:31` | bulk persistent configuration survives a new process boundary | null |
| 451 | case | `test/integration/public-cli-config.test.ts:103` | effective seat configurations enumerate the public configurable roster | null |
| 452 | case | `test/integration/public-cli-config.test.ts:322` | persistent seat config is the effective model source | null |
| 453 | case | `test/integration/public-cli-config.test.ts:341` | bare provider/model invocation is legal and does not invent thinking | null |
| 454 | case | `test/integration/public-cli-config.test.ts:364` | provider/model:thinking suffix still parses and formats with thinking | null |
| 455 | case | `test/integration/public-cli-config.test.ts:386` | malformed model specs keep the pre-#346 typed rejection surface | null |
| 456 | case | `test/integration/public-cli-config.test.ts:414` | persistent bare provider/model stores as-is without inventing thinking | null |
| 457 | assert | `test/integration/public-cli-countersign-run.test.ts:150` | assert.deepEqual( admitted.role, "countersign"); | null |
| 458 | assert | `test/integration/public-cli-countersign-run.test.ts:152` | assert.equal(admitted.instructionEmpty, false); | null |
| 459 | assert | `test/integration/public-cli-countersign-run.test.ts:160` | assert.equal(turn.activation.role, "countersign"); | 仍在 test/integration/public-cli-countersign-run.test.ts:158 |
| 460 | assert | `test/integration/public-cli-countersign-run.test.ts:162` | assert.equal( "ticketNumber" in turn.activation ? turn.activation.ticketNumber : undefined, undefined, ); | 仍在 test/integration/public-cli-countersign-run.test.ts:153 |
| 461 | assert | `test/integration/public-cli-countersign-run.test.ts:202` | assert.equal(piArgv.includes("--ak-countersign-ticket-number"), false); | null |
| 462 | case | `test/integration/public-cli-countersign-run.test.ts:134` | countersign admission binds the countersign role without inventing a ticket | null |
| 463 | assert | `test/integration/public-cli-diarist-run.test.ts:1003` | assert.equal(existsSync(join(paths.volumeDir, "起居录.md")), false); | null |
| 464 | assert | `test/integration/public-cli-diarist-run.test.ts:1188` | assert.equal(volume.lines.every((line) => !("line" in line)), true); | null |
| 465 | assert | `test/integration/public-cli-diarist-run.test.ts:1447` | assert.deepEqual( await findPlacedMigratingRun( booksDirectory, "demo-book", boundLeaf, `unbound/runs/${boundLeaf}`, ), { runDirectory: boundTarget, disposition: "placed" }, "downs | null |
| 466 | assert | `test/integration/public-cli-diarist-run.test.ts:1856` | assert.equal(existsSync(join(sample.volumeDir, "起居录.md")), false); | null |
| 467 | assert | `test/integration/public-cli-engine-axis.test.ts:98` | assert.equal(reloaded.seats.judge?.engine, "opus"); | null |
| 468 | assert | `test/integration/public-cli-engine-axis.test.ts:99` | assert.deepEqual( { provider: reloaded.seats.judge?.provider, model: reloaded.seats.judge?.model, thinking: reloaded.seats.judge?.thinking, }, { provider: "openai-codex", model: "g | null |
| 469 | assert | `test/integration/public-cli-engine-axis.test.ts:124` | assert.equal(legacy.seats.coder?.engine, undefined); | null |
| 470 | assert | `test/integration/public-cli-engine-axis.test.ts:125` | assert.equal("engine" in (legacy.seats.coder ?? {}), false); | null |
| 471 | assert | `test/integration/public-cli-engine-axis.test.ts:144` | assert.equal(reviewerCfg.seats.reviewer?.engine, "cursor"); | null |
| 472 | assert | `test/integration/public-cli-engine-axis.test.ts:163` | assert.equal(coderCfg.seats.coder?.engine, "opus"); | null |
| 473 | assert | `test/integration/public-cli-engine-axis.test.ts:181` | assert.throws( () => validatePublicCliConfigAxes(bad, packageRoot), Error, ); | null |
| 474 | assert | `test/integration/public-cli-engine-axis.test.ts:203` | assert.equal(freeName.seats.judge?.engine, "ghost-engine"); | null |
| 475 | assert | `test/integration/public-cli-engine-axis.test.ts:218` | assert.equal((await loadPublicCliConfig(cliHome)).seats.judge?.engine, "cursor"); | null |
| 476 | assert | `test/integration/public-cli-engine-axis.test.ts:224` | assert.equal(unset.exitCode, 0); | 仍在 test/integration/public-cli-engine-axis.test.ts:201 |
| 477 | assert | `test/integration/public-cli-engine-axis.test.ts:225` | assert.equal((await loadPublicCliConfig(cliHome)).seats.judge?.engine, undefined); | null |
| 478 | assert | `test/integration/public-cli-engine-axis.test.ts:936` | assert.equal(PUBLIC_CALLABLE_ROLES.length, 16); | null |
| 479 | assert | `test/integration/public-cli-engine-axis.test.ts:1187` | assert.equal(loaded.seats.navigator?.engine, "opus"); | null |
| 480 | case | `test/integration/public-cli-engine-axis.test.ts:86` | persistent judge engine round-trips; syntax-illegal engine rejected at parse/validate | null |
| 481 | assert | `test/integration/public-cli-engine-startup-material.test.ts:104` | assert.deepEqual(engines[0], { kind: "engine-session-material", name: ENGINE, model: ENGINE_MODEL, handbook, dispatchHandbook: dispatch, }); | null |
| 482 | assert | `test/integration/public-cli-engine-startup-material.test.ts:242` | assert.deepEqual(engines[0], { kind: "engine-session-material", name: ENGINE, model: ENGINE_MODEL, handbook, dispatchHandbook: dispatch, }); | null |
| 483 | assert | `test/integration/public-cli-failure-artifacts.test.ts:76` | assert.equal(stdout.length, 1); | null |
| 484 | assert | `test/integration/public-cli-failure-artifacts.test.ts:141` | assert.equal(stdout.length, 1, "one complete Terminal"); | null |
| 485 | assert | `test/integration/public-cli-failure-artifacts.test.ts:250` | assert.equal(stdout.length, 1); | null |
| 486 | assert | `test/integration/public-cli-failure-artifacts.test.ts:317` | assert.equal(stdout.length, 1); | null |
| 487 | assert | `test/integration/public-cli-failure-artifacts.test.ts:453` | assert.equal(stdout.length, 1); | null |
| 488 | assert | `test/integration/public-cli-failure-artifacts.test.ts:454` | assert.ok(stderr.length > 0); | null |
| 489 | assert | `test/integration/public-cli-failure-artifacts.test.ts:643` | assert.equal(stdout.length, 1, "exactly one Terminal emission"); | null |
| 490 | assert | `test/integration/public-cli-failure-real-entry.test.ts:307` | assert.equal(stderr.length, 1); | null |
| 491 | assert | `test/integration/public-cli-failure-real-entry.test.ts:308` | assert.equal(stderr[0]?.includes(hostStderr), true); | 改好 test/integration/public-cli-failure-real-entry.test.ts:296；变异：隔离副本 /tmp/r10a-mut 将 presentFailureTerminal 的 hostStderr 附带改为 false；HEAD 红 production knownFailure channel reaches settlement as provider with typed identity |
| 492 | assert | `test/integration/public-cli-failure-real-entry.test.ts:419` | assert.notEqual(terminal.roleOutcome.decisiveFacts.errorName, "MissingProviderCredential"); | S 失效名缺席；名字 MissingProviderCredential 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 493 | assert | `test/integration/public-cli-failure-real-entry.test.ts:432` | assert.notEqual(errorBody.identity?.name, "MissingProviderCredential"); | S 失效名缺席；名字 MissingProviderCredential 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 494 | assert | `test/integration/public-cli-failure-real-entry.test.ts:433` | assert.ok(stderr[0]!.length > 0); | null |
| 495 | assert | `test/integration/public-cli-failure-real-entry.test.ts:624` | assert.ok(stderr[0]!.length > 0); | null |
| 496 | assert | `test/integration/public-cli-failure-real-entry.test.ts:688` | assert.equal(stderr.length, 1); | null |
| 497 | assert | `test/integration/public-cli-failure-real-entry.test.ts:694` | assert.deepEqual( (result.terminal!.submissions ?? []).map((row) => JSON.stringify(row)), [`{"status":"converged","ticketNumber":1171}`], "the sealed receipt stays recorded on the  | null |
| 498 | assert | `test/integration/public-cli-failure-settlement.test.ts:148` | assert.equal(stdout.length, 1); | null |
| 499 | assert | `test/integration/public-cli-failure-settlement.test.ts:310` | assert.equal(stdout.length, 1); | null |
| 500 | assert | `test/integration/public-cli-fixer.test.ts:72` | await assert.rejects( () => admitFixerInvocation({ principalAuthority: piDurablePrincipalAuthority, home, cwd: project, phase: "apply", instruction: " ", attachmentPaths: [], }), ( | null |
| 501 | assert | `test/integration/public-cli-fixer.test.ts:99` | assert.equal(badAdmitted.prerequisitesPath, badPrereq); | null |
| 502 | assert | `test/integration/public-cli-fixer.test.ts:100` | assert.equal("packetPath" in badAdmitted, false); | S 失效名缺席；名字 packetPath 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 503 | assert | `test/integration/public-cli-fixer.test.ts:101` | assert.equal("prerequisites" in badAdmitted, false); | null |
| 504 | assert | `test/integration/public-cli-fixer.test.ts:121` | assert.deepEqual( admitted.role, "fixer"); | null |
| 505 | assert | `test/integration/public-cli-fixer.test.ts:123` | assert.equal(admitted.phase, "plan"); | 仍在 test/integration/public-cli-fixer.test.ts:288 |
| 506 | assert | `test/integration/public-cli-fixer.test.ts:124` | assert.equal(admitted.instruction, "Plan the class repair."); | null |
| 507 | assert | `test/integration/public-cli-fixer.test.ts:125` | assert.equal(admitted.prerequisitesPath, goodPrereq); | null |
| 508 | assert | `test/integration/public-cli-fixer.test.ts:126` | assert.equal("packetPath" in admitted, false); | S 失效名缺席；名字 packetPath 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 509 | assert | `test/integration/public-cli-fixer.test.ts:127` | await assert.rejects( () => access(join(admitted.runDirectory, "fix-packet.md")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", ); | null |
| 510 | assert | `test/integration/public-cli-fixer.test.ts:131` | await assert.rejects( () => access(join(admitted.runDirectory, "prerequisites.json")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", ); | null |
| 511 | assert | `test/integration/public-cli-fixer.test.ts:137` | assert.equal( admitted.runDirectory, join(home, ".ak-roles", "books", bookKey, "unbound", "runs", "run-fixer-plan-001@fixer"), ); | null |
| 512 | assert | `test/integration/public-cli-fixer.test.ts:144` | assert.equal(persisted.role, "fixer"); | null |
| 513 | assert | `test/integration/public-cli-fixer.test.ts:145` | assert.equal(persisted.phase, "plan"); | null |
| 514 | assert | `test/integration/public-cli-fixer.test.ts:146` | assert.equal(persisted.prerequisitesPath, goodPrereq); | null |
| 515 | assert | `test/integration/public-cli-fixer.test.ts:147` | assert.equal("prerequisites" in persisted, false); | null |
| 516 | assert | `test/integration/public-cli-fixer.test.ts:197` | assert.equal(args.includes("--ak-fix-packet"), false); | null |
| 517 | assert | `test/integration/public-cli-fixer.test.ts:223` | await assert.rejects( () => access(join(runDirectory, "fix-packet.md")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", ); | null |
| 518 | assert | `test/integration/public-cli-fixer.test.ts:227` | await assert.rejects( () => access(join(runDirectory, "prerequisites.json")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", ); | null |
| 519 | assert | `test/integration/public-cli-fixer.test.ts:239` | assert.equal("prerequisites" in admitted, false); | null |
| 520 | assert | `test/integration/public-cli-fixer.test.ts:240` | assert.equal("packetPath" in admitted, false); | S 失效名缺席；名字 packetPath 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 521 | assert | `test/integration/public-cli-fixer.test.ts:412` | assert.equal("packetPath" in admitted, false); | S 失效名缺席；名字 packetPath 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 522 | assert | `test/integration/public-cli-fixer.test.ts:429` | assert.equal(args.includes("--ak-fix-packet"), false); | null |
| 523 | assert | `test/integration/public-cli-fixer.test.ts:431` | assert.equal(args.includes("[ak-role:resume-continue]"), false); | null |
| 524 | case | `test/integration/public-cli-fixer.test.ts:66` | admitFixerInvocation keeps opaque --prerequisites path; rejects blank instruction only | null |
| 525 | assert | `test/integration/public-cli-gleaner-left-run.test.ts:53` | assert.throws(() => parsePublicSeatArgv("gleaner-left", ["--bogus", "--base", "HEAD"]), (error: unknown) => { return error instanceof CliUsageError; }); | null |
| 526 | assert | `test/integration/public-cli-gleaner-left-run.test.ts:113` | assert.equal(result.exitCode, 0); | 仍在 test/integration/public-cli-gleaner-left-run.test.ts:115 |
| 527 | assert | `test/integration/public-cli-gleaner-left-run.test.ts:114` | assert.ok(result.terminal); | 仍在 test/integration/public-cli-gleaner-left-run.test.ts:116 |
| 528 | assert | `test/integration/public-cli-gleaner-left-run.test.ts:115` | assert.equal(result.terminal.roleOutcome.kind, "accepted"); | 仍在 test/integration/public-cli-gleaner-left-run.test.ts:117 |
| 529 | assert | `test/integration/public-cli-gleaner-left-run.test.ts:116` | assert.equal(result.terminal.roleOutcome.role, "gleaner-left"); | 仍在 test/integration/public-cli-gleaner-left-run.test.ts:118 |
| 530 | assert | `test/integration/public-cli-gleaner-left-run.test.ts:117` | assert.deepEqual(payloadStatusSequence(result.terminal.roleOutcome), ["completed"]); | 仍在 test/integration/public-cli-gleaner-left-run.test.ts:158 |
| 531 | assert | `test/integration/public-cli-gleaner-left-run.test.ts:119` | assert.equal(facts.status, "completed"); | null |
| 532 | assert | `test/integration/public-cli-gleaner-left-run.test.ts:120` | assert.deepEqual(facts.findings, []); | null |
| 533 | assert | `test/integration/public-cli-gleaner-left-run.test.ts:132` | assert.equal(state?.role, "gleaner-left"); | null |
| 534 | assert | `test/integration/public-cli-gleaner-left-run.test.ts:133` | assert.equal(state?.state, "terminal"); | null |
| 535 | case | `test/integration/public-cli-gleaner-left-run.test.ts:90` | public gleaner-left settles empty 弹章 as typed Terminal | null |
| 536 | assert | `test/integration/public-cli-host-axis.test.ts:665` | assert.equal(children.some((name) => name.endsWith("-home")), false); | null |
| 537 | assert | `test/integration/public-cli-host-axis.test.ts:845` | assert.equal(hostPrompt.startsWith("/skill:"), false, hostPrompt.slice(0, 80)); | null |
| 538 | assert | `test/integration/public-cli-host-axis.test.ts:929` | assert.equal(hostPrompt.startsWith("/skill:"), false, hostPrompt.slice(0, 80)); | null |
| 539 | assert | `test/integration/public-cli-host-axis.test.ts:969` | assert.equal(hostPrompt.startsWith("/skill:"), false, hostPrompt.slice(0, 80)); | null |
| 540 | case | `test/integration/public-cli-host-axis.test.ts:788` | #822 coder apply non-pi hosts: prompt free of /skill:; planned receipt | null |
| 541 | assert | `test/integration/public-cli-instruction-seat.test.ts:75` | assert.equal( facts !== null && typeof facts === "object" && "status" in facts ? (facts as { status: unknown }).status : undefined, "dispatch", ); | null |
| 542 | assert | `test/integration/public-cli-instruction-seat.test.ts:81` | assert.equal( facts !== null && typeof facts === "object" && "officer" in facts ? (facts as { officer: unknown }).officer : undefined, "inspector", ); | null |
| 543 | assert | `test/integration/public-cli-judge.test.ts:121` | assert.throws(() => parsePublicSeatArgv("judge", ["--unknown-flag"]), isUsage); | null |
| 544 | assert | `test/integration/public-cli-judge.test.ts:130` | assert.equal(parsed.instruction, "opaque instruction"); | null |
| 545 | assert | `test/integration/public-cli-judge.test.ts:131` | assert.deepEqual(parsed.attachmentPaths, ["a.md"]); | null |
| 546 | assert | `test/integration/public-cli-judge.test.ts:132` | assert.equal(parsed.project, "/tmp/p"); | null |
| 547 | assert | `test/integration/public-cli-judge.test.ts:141` | assert.throws(() => parsePublicSeatArgv("judge", ["--project=", "task"]), isUsage); | null |
| 548 | assert | `test/integration/public-cli-judge.test.ts:142` | assert.throws(() => parsePublicSeatArgv("judge", ["--project", "", "task"]), isUsage); | null |
| 549 | assert | `test/integration/public-cli-judge.test.ts:143` | assert.throws(() => parsePublicSeatArgv("judge", ["--project", " ", "task"]), isUsage); | null |
| 550 | assert | `test/integration/public-cli-judge.test.ts:144` | assert.throws(() => parsePublicSeatArgv("judge", ["--attach"]), isUsage); | null |
| 551 | assert | `test/integration/public-cli-judge.test.ts:323` | assert.equal( capturedArgs!.some((arg) => arg.includes("burden")), false, ); | null |
| 552 | assert | `test/integration/public-cli-judge.test.ts:336` | assert.equal(stdout.length, 1); | null |
| 553 | assert | `test/integration/public-cli-judge.test.ts:337` | assert.notEqual(stdout[0]?.trim(), ""); | null |
| 554 | assert | `test/integration/public-cli-judge.test.ts:429` | assert.equal(stdout.length, 1); | null |
| 555 | assert | `test/integration/public-cli-judge.test.ts:430` | assert.ok(stdout[0]!.length > 0); | null |
| 556 | case | `test/integration/public-cli-judge.test.ts:114` | parseJudgeArgv rejects public burden selectors and unknown flags | null |
| 557 | case | `test/integration/public-cli-judge.test.ts:135` | parseJudgeArgv rejects blank --project and missing --attach argument | null |
| 558 | assert | `test/integration/public-cli-merger-run.test.ts:433` | assert.equal(result.exitCode, 0, `${row.role} exit: ${stderr}`); | null |
| 559 | assert | `test/integration/public-cli-merger-run.test.ts:434` | assert.equal(result.terminal?.roleOutcome.kind, "accepted", `${row.role}: ${stderr}`); | null |
| 560 | assert | `test/integration/public-cli-merger-run.test.ts:435` | assert.equal(result.terminal?.roleOutcome.role, row.role, row.role); | null |
| 561 | assert | `test/integration/public-cli-merger-run.test.ts:436` | assert.deepEqual( result.terminal ? payloadStatusSequence(result.terminal.roleOutcome) : [], row.status === undefined ? [] : [row.status], row.role, ); | null |
| 562 | case | `test/integration/public-cli-merger-run.test.ts:423` | public-cli every packaged role accepts via shared sealed→Terminal entry | null |
| 563 | assert | `test/integration/public-cli-merger.test.ts:80` | assert.throws(() => parsePublicSeatArgv("merger", ["--unknown-flag"]), isUsage); | null |
| 564 | assert | `test/integration/public-cli-merger.test.ts:81` | assert.throws(() => parsePublicSeatArgv("merger", ["--project", "", "task"]), isUsage); | null |
| 565 | assert | `test/integration/public-cli-merger.test.ts:151` | assert.equal("task" in (raw.materials ?? {}), false); | null |
| 566 | assert | `test/integration/public-cli-merger.test.ts:152` | assert.equal("authority" in (raw.materials ?? {}), false); | null |
| 567 | assert | `test/integration/public-cli-merger.test.ts:176` | assert.equal(prompt.startsWith("/skill:"), false); | null |
| 568 | assert | `test/integration/public-cli-merger.test.ts:396` | assert.equal( args.some((a) => a.includes("[ak-role:resume-continue]")), false, ); | null |
| 569 | case | `test/integration/public-cli-merger.test.ts:58` | parseMergerArgv accepts common Invocation flags and rejects unknown options | null |
| 570 | assert | `test/integration/public-cli-navigator-attendance.test.ts:54` | assert.ok(advice, `${role}/${status} must have a table row`); | null |
| 571 | assert | `test/integration/public-cli-navigator-attendance.test.ts:245` | assert.match(JSON.stringify(result.terminal?.roleOutcome), /PARENT HOST BOOM/); | T 文案锁；依据 souls/quality-law.md:32；docs/research/issue-1237-test-quality-sweep.md:134 类别 T/M；不引承接 |
| 572 | assert | `test/integration/public-cli-navigator-attendance.test.ts:258` | assert.match(fact?.disposition === "unavailable" ? fact.reason : "", /EISDIR/); | T 文案锁；依据 souls/quality-law.md:32；docs/research/issue-1237-test-quality-sweep.md:134 类别 T/M；不引承接 |
| 573 | assert | `test/integration/public-cli-navigator-attendance.test.ts:260` | assert.deepEqual(fact, { disposition: "advice", prose: scenario.expect.advice }); | null |
| 574 | assert | `test/integration/public-cli-navigator-lookup.test.ts:78` | assert.deepEqual(onlyPayload(result), { byRole: NAVIGATOR_ROUTE_TABLE }); | null |
| 575 | assert | `test/integration/public-cli-navigator-lookup.test.ts:82` | assert.deepEqual(receiptBodies, [{ byRole: NAVIGATOR_ROUTE_TABLE }]); | null |
| 576 | assert | `test/integration/public-cli-navigator-lookup.test.ts:91` | assert.deepEqual(onlyPayload(result), { byStatus: NAVIGATOR_ROUTE_TABLE.coder }); | null |
| 577 | assert | `test/integration/public-cli-navigator-lookup.test.ts:104` | assert.deepEqual(onlyPayload(result), { byRole: NAVIGATOR_ROUTE_TABLE }); | null |
| 578 | assert | `test/integration/public-cli-navigator-lookup.test.ts:111` | assert.deepEqual(onlyPayload(result), { byRole: NAVIGATOR_ROUTE_TABLE }); | null |
| 579 | assert | `test/integration/public-cli-navigator-lookup.test.ts:140` | assert.match(stderr.join(""), /EISDIR/); | T 文案锁；依据 souls/quality-law.md:32；docs/research/issue-1237-test-quality-sweep.md:135 类别 T/M；不引承接 |
| 580 | assert | `test/integration/public-cli-notary.test.ts:211` | await assert.rejects( () => resolveNotarySourceRunLocator({ projectRoot: project, sourceRun: join(project, "missing@judge"), home, }), (error: unknown) => error instanceof NotarySo | null |
| 581 | assert | `test/integration/public-cli-notary.test.ts:220` | await assert.rejects( () => resolveNotarySourceRunLocator({ projectRoot: project, sourceRun: projection, home, }), (error: unknown) => error instanceof NotarySourceRunError, ); | null |
| 582 | assert | `test/integration/public-cli-notary.test.ts:264` | await assert.rejects( () => readRoleRunState(runDirectory, piDurablePrincipalAuthority), TypeError, ); | null |
| 583 | assert | `test/integration/public-cli-notary.test.ts:289` | await assert.rejects( () => resolveNotarySourceRunLocator({ projectRoot: project, sourceRun: bare, home, }), (error: unknown) => error instanceof NotarySourceRunError, ); | null |
| 584 | assert | `test/integration/public-cli-report-ticket.test.ts:268` | assert.equal("runDirectory" in reported, false); | null |
| 585 | assert | `test/integration/public-cli-report-ticket.test.ts:733` | assert.ok(transportPrompt.includes("--attach"), "transport carries file flags"); | null |
| 586 | assert | `test/integration/public-cli-report-ticket.test.ts:744` | assert.equal(Object.hasOwn(fixerLines[0]!, "model"), false); | null |
| 587 | assert | `test/integration/public-cli-report-ticket.test.ts:745` | assert.equal(Object.hasOwn(fixerLines[0]!, "host"), false); | null |
| 588 | assert | `test/integration/public-cli-report-ticket.test.ts:746` | assert.equal(Object.hasOwn(fixerLines[0]!, "thinking"), false); | null |
| 589 | assert | `test/integration/public-cli-report-ticket.test.ts:1894` | assert.equal( inspectorPointers.length, 0, `${reask}: parent must not book officer-pointer rows`, ); | null |
| 590 | assert | `test/integration/public-cli-resume-416.test.ts:100` | assert.equal(seenEnvelope,false); | null |
| 591 | assert | `test/integration/public-cli-resume-416.test.ts:278` | assert.equal(isLawfulTypedTerminalOutcome({kind:"audit_escalation",role:"judge",status:"audit_escalation",decisiveFacts:{}}),true); | null |
| 592 | assert | `test/integration/public-cli-resume-416.test.ts:299` | assert.equal(isLawfulTypedTerminalOutcome({kind:"no_receipt",role:"judge",status:"no-accepted-receipt",decisiveFacts:{acceptedReceipt:false}} as unknown as Parameters<typeof isLawf | null |
| 593 | assert | `test/integration/public-cli-resume-416.test.ts:358` | assert.equal(resumeArgs!.includes("[ak-role:resume-continue]"), false); | null |
| 594 | assert | `test/integration/public-cli-resume-416.test.ts:359` | assert.equal(manualStdout.length,1); | null |
| 595 | assert | `test/integration/public-cli-resume.test.ts:217` | assert.ok(result.terminal); | 仍在 test/integration/public-cli-resume.test.ts:272 |
| 596 | assert | `test/integration/public-cli-resume.test.ts:641` | assert.equal(args.includes("[ak-role:resume-continue]"), false); | null |
| 597 | assert | `test/integration/public-cli-resume.test.ts:681` | assert.equal(existsSync(join(liveRunDirectory, "attachments")), false); | null |
| 598 | case | `test/integration/public-cli-resume.test.ts:178` | quota-like prose without typed 429 is not resumable | null |
| 599 | assert | `test/integration/public-cli-reviewer.test.ts:114` | assert.throws( () => parsePublicSeatArgv("reviewer", [ "--base", "main", "--authority-ref", "The system SHALL launch two workers", ]), isUsage, ); | null |
| 600 | assert | `test/integration/public-cli-reviewer.test.ts:128` | assert.deepEqual( parsePublicSeatArgv("reviewer", [ "--base", "main", "--authority-ref", "https://example.test/a", ]), { instruction: "", attachmentPaths: [], baseRevision: "main", | null |
| 601 | assert | `test/integration/public-cli-reviewer.test.ts:231` | assert.throws( () => parsePublicSeatArgv("reviewer", [ "--unknown-flag", "--base", "main", "--authority-ref", "CLAUDE.md", ]), isUsage, ); | null |
| 602 | assert | `test/integration/public-cli-reviewer.test.ts:289` | assert.throws( () => parsePublicSeatArgv("reviewer", [ "--project", "", "--base", "main", "--authority-ref", "CLAUDE.md", "task", ]), isUsage, ); | null |
| 603 | assert | `test/integration/public-cli-reviewer.test.ts:494` | assert.equal(args.includes("--ak-review-task"), false); | null |
| 604 | assert | `test/integration/public-cli-reviewer.test.ts:639` | assert.equal(projectEntries.includes("docs"), false); | null |
| 605 | assert | `test/integration/public-cli-reviewer.test.ts:831` | assert.equal(captured!.includes("--ak-review-task"), false); | null |
| 606 | assert | `test/integration/public-cli-reviewer.test.ts:868` | assert.equal("taskPath" in admittedFacts, false); | S 失效名缺席；名字 taskPath 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 607 | assert | `test/integration/public-cli-reviewer.test.ts:869` | assert.equal("taskSha256" in admittedFacts, false); | S 失效名缺席；名字 taskSha256 在 src/extensions/scripts/souls 零命中；依据 docs/research/issue-1237-test-quality-sweep.md:300 R6-A；不引承接 |
| 608 | assert | `test/integration/public-cli-reviewer.test.ts:1082` | assert.equal(args.includes("--ak-review-task"), false); | null |
| 609 | assert | `test/integration/public-cli-reviewer.test.ts:1088` | assert.equal(resumeDialogue.includes("/skill:"), false); | null |
| 610 | case | `test/integration/public-cli-reviewer.test.ts:104` | parseReviewerArgv defaults to both lenses and accepts an optional single-lens override | null |
| 611 | assert | `test/integration/public-cli-same-ticket-resume.test.ts:674` | await assert.rejects( () => readdir(join(runDirectory, "attachments")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", ); | null |
| 612 | assert | `test/integration/public-cli-same-ticket-resume.test.ts:710` | await assert.rejects( () => readdir(join(runDirectory, "attachments")), (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT", ); | null |
| 613 | assert | `test/integration/public-cli-same-ticket-resume.test.ts:1209` | assert.deepEqual(rounds, []); | null |
| 614 | assert | `test/integration/public-cli-secretariat-run.test.ts:491` | assert.equal(factsOut?.countersignTerminal, undefined, "parent final must not project countersignTerminal"); | null |
| 615 | assert | `test/integration/public-cli-secretariat-run.test.ts:492` | assert.equal(factsOut?.notaryTerminal, undefined, "parent final must not project notaryTerminal"); | null |
| 616 | assert | `test/integration/public-cli-secretariat-run.test.ts:593` | assert.equal( resumed.terminal?.roleOutcome.decisiveFacts?.countersignTerminal, undefined, "resumed secretariat must not project countersignTerminal", ); | null |
| 617 | assert | `test/integration/public-cli-secretariat-run.test.ts:598` | assert.equal( resumed.terminal?.roleOutcome.decisiveFacts?.notaryTerminal, undefined, "resumed secretariat must not project notaryTerminal", ); | null |
| 618 | assert | `test/integration/public-cli-secretariat-run.test.ts:629` | assert.equal( result.terminal?.roleOutcome.decisiveFacts?.countersignTerminal, undefined, "notary escalate terminal must not carry parent countersignTerminal", ); | null |
| 619 | assert | `test/integration/public-cli-secretariat-run.test.ts:742` | assert.equal( result.terminal.roleOutcome.decisiveFacts?.countersignTerminal, undefined, "parent escalate terminal must not project countersignTerminal", ); | null |
| 620 | assert | `test/integration/public-cli-secretariat-run.test.ts:747` | assert.equal( result.terminal.roleOutcome.decisiveFacts?.notaryTerminal, undefined, "parent escalate terminal must not project notaryTerminal", ); | null |
| 621 | assert | `test/integration/public-cli-secretariat-run.test.ts:1134` | assert.equal( gateEntered, false, `${hostName} tool execution must not summon 给事中 before returning`, ); | null |
| 622 | assert | `test/integration/public-cli-secretariat-run.test.ts:1139` | assert.equal(submitted, true, `${hostName} must seal the submitted receipt`); | null |
| 623 | assert | `test/integration/public-cli-secretariat-run.test.ts:1150` | assert.equal( gateEntered, false, `${hostName} escalate must not summon 给事中`, ); | null |
| 624 | case | `test/integration/public-cli-secretariat-run.test.ts:1129` | #1057 adapter boundary ${hostName}: converged tool finishes before gate | null |
| 625 | case | `test/integration/public-cli-secretariat-run.test.ts:1142` | #969 adapter boundary ${hostName}: escalate skips gate | null |
| 626 | assert | `test/integration/role-envelope-engine-axis.test.ts:87` | assert.ok(judge.systemPrompt.body.includes(soul)); | null |
| 627 | assert | `test/integration/role-envelope-engine-axis.test.ts:88` | assert.deepEqual(judge.systemPrompt.materials, [{ kind: "role-reference-materials", content: await packagedMaterials([ "CLAUDE.md", "souls/audit-law.md", "souls/quality-law.md", "s | null |
| 628 | assert | `test/integration/role-envelope-engine-axis.test.ts:125` | assert.ok(auditor.systemPrompt.body.includes(soul)); | null |
| 629 | assert | `test/integration/role-envelope-engine-axis.test.ts:126` | assert.deepEqual(auditor.systemPrompt.materials, [{ kind: "role-reference-materials", content: await packagedMaterials([ "CLAUDE.md", "souls/judge.md", "souls/audit-law.md", "souls | null |
| 630 | assert | `test/integration/role-envelope-engine-axis.test.ts:154` | assert.deepEqual(judge.systemPrompt.materials, [{ kind: "role-reference-materials", content: await packagedMaterials([ "CLAUDE.md", "souls/audit-law.md", "souls/quality-law.md", "s | null |
| 631 | assert | `test/integration/role-envelope-engine-axis.test.ts:190` | assert.deepEqual(auditor.systemPrompt.materials, [{ kind: "role-reference-materials", content: await packagedMaterials([ "CLAUDE.md", "souls/judge.md", "souls/audit-law.md", "souls | null |
| 632 | assert | `test/integration/role-envelope-engine-axis.test.ts:425` | assert.equal(dossierCount(preparedA), 0); | null |
| 633 | assert | `test/integration/role-envelope-engine-axis.test.ts:426` | assert.equal(dossierCount(preparedB), 0); | null |
| 634 | case | `test/integration/role-envelope-engine-axis.test.ts:76` | shared envelope keeps seat identity separate from typed reference materials | null |
| 635 | case | `test/integration/role-envelope-engine-axis.test.ts:142` | Pi production root supplies typed main and auditor reference materials | null |
| 636 | case | `test/integration/role-envelope-engine-axis.test.ts:375` | #1092 concurrent envelopes do not fold case-dossier pointer materials | null |
| 637 | assert | `test/integration/run-test-all.test.ts:203` | assert.equal( pkg.scripts["test:all"], "node scripts/run-test-all.mjs", "test:all must delegate only to the scheduling owner", ); | null |
| 638 | assert | `test/integration/run-test-all.test.ts:218` | assert.equal(pkg.scripts["test"], bareUnitContract); | null |
| 639 | assert | `test/integration/run-test-all.test.ts:219` | assert.equal(pkg.scripts["test:fast"], fastUnitContract); | null |
| 640 | assert | `test/integration/run-test-all.test.ts:220` | assert.equal( pkg.scripts["test:integration"], `node --import tsx ${preload} ${reporter} --test test/unit/**/*.test.ts test/contract/**/*.test.ts test/integration/**/*.test.ts`, ); | null |
| 641 | assert | `test/integration/run-test-all.test.ts:224` | assert.equal( pkg.scripts["test:adjudication"], `node --import tsx ${preload} ${reporter} --test test/adjudication/**/*.test.ts`, ); | null |
| 642 | case | `test/integration/run-test-all.test.ts:199` | package.json test entries wire HOME redirect preload or run-test-all owner | null |
| 643 | assert | `test/integration/ticket-snapshot-family-edges.test.ts:215` | await assert.rejects( () => runner(["api", "graphql", "-f", `query=${query}`]), Error, ); | null |
| 644 | case | `test/integration/ticket-snapshot-family-edges.test.ts:281` | fixture runner rejects blockedBy.pageInfo parked under another alias parent | null |
| 645 | case | `test/integration/ticket-snapshot-family-edges.test.ts:292` | fixture runner rejects blockedBy.nodes.state parked under another alias parent | null |
| 646 | assert | `test/integration/ticket-trajectory-binding.test.ts:87` | assert.equal(runs.some((run) => run.runId === runFolder), false); | null |
| 647 | assert | `test/integration/ticket-trajectory-binding.test.ts:101` | assert.equal(runs.some((run) => run.runId === "legacy-coder-1"), true); | 仍在 test/integration/ticket-trajectory-binding.test.ts:104 |
| 648 | assert | `test/integration/ticket-trajectory-binding.test.ts:141` | assert.equal(index.runsByTicket.get(176)?.length, 1); | null |
| 649 | assert | `test/integration/ticket-trajectory-binding.test.ts:142` | assert.equal(index.runsByTicket.get(177)?.length, 1); | null |
| 650 | assert | `test/integration/ticket-trajectory-binding.test.ts:143` | assert.equal(index.unboundRuns.length, 0); | null |
| 651 | case | `test/integration/ticket-trajectory-binding.test.ts:97` | legacy issues/<n>/runs is still included | null |
| 652 | assert | `test/integration/worker-submission-gates.test.ts:140` | assert.throws( () => gate.assertAcceptable("unfinished", {}), (error: unknown) => error instanceof WorkerUnfinishedReasonReminderError && error.code === "worker_unfinished_reason_r | null |
| 653 | assert | `test/integration/worker-submission-gates.test.ts:146` | assert.throws(() => gate.assertAcceptable("unfinished", { reason: " " }), WorkerUnfinishedReasonReminderError); | null |
| 654 | assert | `test/integration/worker-submission-gates.test.ts:147` | assert.doesNotThrow(() => gate.assertAcceptable("unfinished", { reason: "prerequisite_missing: pending owner decision on adapter scope", }), ); | null |
| 655 | assert | `test/integration/worker-submission-gates.test.ts:153` | assert.throws(() => loop.assertAcceptable("unfinished", {}), WorkerUnfinishedReasonReminderError); | null |
| 656 | assert | `test/integration/worker-submission-gates.test.ts:154` | assert.throws(() => loop.assertAcceptable("unfinished", {}), WorkerUnfinishedReasonReminderError); | null |
| 657 | assert | `test/integration/worker-submission-gates.test.ts:155` | assert.doesNotThrow(() => loop.assertAcceptable("unfinished", {})); | null |
| 658 | assert | `test/integration/worker-submission-gates.test.ts:156` | assert.doesNotThrow(() => loop.assertAcceptable("planned")); | null |
| 659 | assert | `test/integration/worker-submission-gates.test.ts:157` | assert.doesNotThrow(() => loop.assertAcceptable("refused")); | null |
| 660 | assert | `test/integration/worker-submission-gates.test.ts:182` | assert.equal(existsSync(join(parent.runDirectory, "session", "worker-submission-gate")), false); | null |
| 661 | case | `test/integration/worker-submission-gates.test.ts:138` | unfinished reason gate bounces missing reason up to twice then accepts; reasoned unfinished free; other statuses unchanged | null |
| 662 | assert | `test/package/npm-identity-metadata.test.ts:126` | assert.equal( extracted.paths.some((path) => path === "patches" // path.startsWith("patches/")), false, "npm pack must exclude repository-only patches", ); | null |
| 663 | assert | `test/package/npm-identity-metadata.test.ts:138` | assert.notEqual(extracted.packageJson.license, "MIT"); | null |
| 664 | assert | `test/package/npm-identity-metadata.test.ts:139` | assert.notEqual(extracted.packageJson.license, "Apache-2.0 OR MIT"); | null |
| 665 | assert | `test/package/npm-identity-metadata.test.ts:140` | assert.notEqual(extracted.packageJson.license, "(Apache-2.0 OR MIT)"); | null |
| 666 | assert | `test/package/npm-identity-metadata.test.ts:156` | assert.ok(extracted.paths.includes(soul), `pack must include ${soul}`); | null |
| 667 | assert | `test/package/npm-identity-metadata.test.ts:159` | assert.ok( extracted.paths.includes("CLAUDE.md"), "npm pack file list must include CLAUDE.md", ); | null |
| 668 | assert | `test/package/npm-identity-metadata.test.ts:164` | assert.equal( extracted.paths.some((path) => path.startsWith("resources/methods/")), false, "npm artifact must not ship method Skill copies", ); | null |
| 669 | assert | `test/package/npm-identity-metadata.test.ts:173` | assert.ok(extracted.paths.includes(path), `pack must include non-method resource ${path}`); | null |
| 670 | assert | `test/package/npm-identity-metadata.test.ts:175` | assert.equal( extracted.paths.some((path) => path.startsWith("dist/package-resources/method-skill") // path.startsWith("src/package-resources/method-skill")), false, "npm artifact  | null |
| 671 | assert | `test/package/npm-identity-metadata.test.ts:182` | assert.ok( extracted.paths.includes("dist/public-cli/main.js"), "pack must include dist/public-cli/main.js", ); | null |
| 672 | assert | `test/package/npm-identity-metadata.test.ts:186` | assert.ok( extracted.paths.includes(INTERNAL_ROLE_ENTRYPOINT_RELATIVE), "pack must include the internal role entrypoint", ); | null |
| 673 | assert | `test/package/npm-identity-metadata.test.ts:190` | assert.ok( extracted.paths.includes("extensions/role-runtime.ts"), "pack must include extensions/role-runtime.ts", ); | null |
| 674 | assert | `test/package/npm-identity-metadata.test.ts:201` | assert.ok(extracted.paths.includes(path), `${path} must be present in the npm tarball`); | null |
| 675 | assert | `test/package/npm-identity-metadata.test.ts:204` | assert.ok(extracted.paths.includes("src/navigator-attendance.ts"), "src/navigator-attendance.ts must be present in the npm tarball"); | null |
| 676 | assert | `test/package/npm-identity-metadata.test.ts:205` | assert.ok(extracted.paths.includes("dist/navigator-attendance.js"), "dist/navigator-attendance.js must be present in the npm tarball"); | null |
| 677 | assert | `test/package/npm-identity-metadata.test.ts:206` | assert.ok(extracted.paths.includes("dist/activation-ledger-topology.js"), "dist/activation-ledger-topology.js must be present in the npm tarball"); | null |
| 678 | assert | `test/package/npm-identity-metadata.test.ts:214` | assert.ok(extracted.paths.includes(path), `${path} must be present in the npm tarball`); | null |
| 679 | assert | `test/package/npm-identity-metadata.test.ts:220` | assert.ok(extracted.paths.includes("packets/fixer-repair.md"), "packets/fixer-repair.md must be present in the npm tarball"); | null |
| 680 | assert | `test/package/npm-identity-metadata.test.ts:221` | assert.equal( extracted.paths.includes("packets/fixer-prerequisites.json"), false, "deleted typed prerequisites example must not be packed", ); | null |
| 681 | assert | `test/package/npm-identity-metadata.test.ts:226` | assert.equal( extracted.paths.includes("packets/fixer-repair.json"), false, "removed closed packet shell must not be packed", ); | null |
| 682 | assert | `test/package/npm-identity-metadata.test.ts:234` | assert.equal(extracted.packageJson.bin?.["ak-role"], "dist/public-cli/main.js"); | null |
| 683 | case | `test/package/npm-identity-metadata.test.ts:154` | packed artifact ships the release inventory without bundled method Skills | null |
| 684 | assert | `test/primary-aware-cleanup.test.ts:8` | await assert.rejects( () => withPrimaryAwareCleanup( async () => "ok", async () => { throw cleanup; }, ), (error: unknown) => error === cleanup, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；承接 null |
| 685 | assert | `test/primary-aware-cleanup.test.ts:23` | await assert.rejects( () => withPrimaryAwareCleanup( async () => { throw primary; }, async () => { throw cleanup; }, ), (error: unknown) => { assert.ok(error instanceof AggregateEr | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；承接 null |
| 686 | assert | `test/primary-aware-cleanup.test.ts:54` | assert.equal(value, 42); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；承接 null |
| 687 | assert | `test/primary-aware-cleanup.test.ts:55` | assert.deepEqual(steps, ["body", "cleanup"]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；承接 null |
| 688 | assert | `test/primary-aware-cleanup.test.ts:60` | await assert.rejects( () => withPrimaryAwareCleanup( async () => { throw primary; }, async () => {}, ), (error: unknown) => error === primary, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；承接 null |
| 689 | assert | `test/primary-aware-cleanup.test.ts:75` | await assert.rejects( () => withPrimaryAwareCleanup( async () => "ok", async () => { throw first; }, async () => { throw second; }, ), (error: unknown) => { assert.ok(error instanc | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；承接 null |
| 690 | case | `test/primary-aware-cleanup.test.ts:6` | cleanup failure alone fails the test | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；承接 null |
| 691 | case | `test/primary-aware-cleanup.test.ts:20` | primary failure wins while cleanup failure remains aggregated | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；承接 null |
| 692 | case | `test/primary-aware-cleanup.test.ts:43` | successful body returns value when cleanup succeeds | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；承接 null |
| 693 | case | `test/primary-aware-cleanup.test.ts:58` | primary failure propagates when cleanup succeeds | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；承接 null |
| 694 | case | `test/primary-aware-cleanup.test.ts:72` | multiple cleanup failures aggregate when body succeeds | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:161 类别 M；承接 null |
| 695 | assert | `test/unit/activation-envelope-module.test.ts:28` | assert.equal(isAbsolute(ledgerHome), true); | null |
| 696 | assert | `test/unit/activation-envelope-module.test.ts:29` | assert.equal(ledgerHome, resolve(absoluteHome, ".ak-roles")); | null |
| 697 | case | `test/unit/activation-envelope-module.test.ts:14` | resolved ledger home rejects relative process home (pure path math) | null |
| 698 | assert | `test/unit/canonical-json.test.ts:10` | assert.equal(canonicalJson(left), expected); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:26 类别 S；承接 null |
| 699 | assert | `test/unit/canonical-json.test.ts:11` | assert.equal(canonicalJson(right), expected); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:26 类别 S；承接 null |
| 700 | assert | `test/unit/canonical-json.test.ts:12` | assert.deepEqual(canonicalJsonBytes(left), canonicalJsonBytes(right)); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:26 类别 S；承接 null |
| 701 | assert | `test/unit/canonical-json.test.ts:34` | assert.throws(() => canonicalJson(new Proxy({}, { ownKeys() { throw ownKeysFailure; } })), (error) => error === ownKeysFailure); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:26 类别 S；承接 null |
| 702 | assert | `test/unit/canonical-json.test.ts:37` | assert.throws(() => canonicalJson(value), (error) => error === propertyFailure); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:26 类别 S；承接 null |
| 703 | case | `test/unit/canonical-json.test.ts:6` | Doctor consumers share recursive canonical JSON semantics | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:26 类别 S；承接 null |
| 704 | case | `test/unit/canonical-json.test.ts:15` | canonical JSON rejects the closed domain counterexamples with typed structural paths | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:26 类别 S；承接 null |
| 705 | case | `test/unit/canonical-json.test.ts:32` | canonical JSON does not relabel unexpected proxy and property failures | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:26 类别 S；承接 null |
| 706 | assert | `test/unit/engine-material.test.ts:21` | assert.throws(() => assertLegalEngineName(name), (err: unknown) => err instanceof Error); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:27 类别 D；承接 null |
| 707 | assert | `test/unit/engine-material.test.ts:23` | assert.equal(assertLegalEngineName("nope-engine"), "nope-engine"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:27 类别 D；承接 null |
| 708 | assert | `test/unit/engine-material.test.ts:24` | assert.equal(assertLegalEngineName("opus"), "opus"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:27 类别 D；承接 null |
| 709 | assert | `test/unit/engine-material.test.ts:25` | assert.equal(assertLegalEngineName("company..opus"), "company..opus"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:27 类别 D；承接 null |
| 710 | case | `test/unit/engine-material.test.ts:17` | assertLegalEngineName rejects only real path hazards; consecutive dots pass | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:27 类别 D；承接 null |
| 711 | assert | `test/unit/host-neutral-role-envelope.test.ts:34` | assert.ok(flags.has("ak-role")); | null |
| 712 | assert | `test/unit/host-neutral-role-envelope.test.ts:35` | assert.ok(handlers.some(([event]) => event === "session_start")); | null |
| 713 | assert | `test/unit/host-neutral-role-envelope.test.ts:36` | assert.ok(handlers.some(([event]) => event === "turn_end")); | null |
| 714 | case | `test/unit/host-neutral-role-envelope.test.ts:8` | shared envelope configures every public seat on a non-Pi host | null |
| 715 | assert | `test/unit/judge-recording-anti-forge.test.ts:12` | assert.throws( () => assertPackagedSoulMatchesMeta( { packageSha: "deadbeef", soulDigest: "0".repeat(64), }, "synthetic-bundle", () => soulText, ), Error, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:32 类别 S；承接 null |
| 716 | assert | `test/unit/judge-recording-anti-forge.test.ts:26` | assert.doesNotThrow(() => assertPackagedSoulMatchesMeta( { packageSha: "deadbeef", soulDigest: soulTextDigest(soulText), }, "synthetic-bundle", () => soulText, ), ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:32 类别 S；承接 null |
| 717 | case | `test/unit/judge-recording-anti-forge.test.ts:9` | anti-forge helper rejects mismatched synthetic soul digest | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:32 类别 S；承接 null |
| 718 | assert | `test/unit/merger-contract.test.ts:11` | assert.doesNotThrow(() => validateMergerInput(valid())); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:33 类别 M；承接 null |
| 719 | assert | `test/unit/merger-contract.test.ts:12` | assert.throws(() => validateMergerInput({ ...valid(), attemptId: " " }), MergerInputContractError); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:33 类别 M；承接 null |
| 720 | case | `test/unit/merger-contract.test.ts:10` | Merger input rejects a blank attempt identity | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:33 类别 M；承接 null |
| 721 | assert | `test/unit/navigator-route-table.test.ts:9` | assert.ok( advice.trim() !== "" && Array.from(advice).length <= NAVIGATOR_ADVICE_MAX_CHARS, `${role}/${status}`, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:34 类别 T；承接 null |
| 722 | case | `test/unit/navigator-route-table.test.ts:6` | every table row is one short non-empty line | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:34 类别 T；承接 null |
| 723 | assert | `test/unit/pi-adapter-agent-start.test.ts:95` | assert.ok(handler); | null |
| 724 | assert | `test/unit/pi-adapter-agent-start.test.ts:100` | assert.ok(result && typeof result === "object"); | 仍在 test/unit/pi-adapter-agent-start.test.ts:92 |
| 725 | assert | `test/unit/pi-adapter-agent-start.test.ts:127` | assert.equal(bodyOnly.systemPrompt, "BASE"); | null |
| 726 | assert | `test/unit/pi-adapter-agent-start.test.ts:128` | assert.equal("readingMaterial" in bodyOnly, false); | null |
| 727 | assert | `test/unit/pi-adapter-agent-start.test.ts:132` | assert.equal("readingMaterial" in withBound, false); | null |
| 728 | assert | `test/unit/pi-adapter-agent-start.test.ts:133` | assert.equal(typeof withBound.systemPrompt, "string"); | null |
| 729 | assert | `test/unit/pi-adapter-agent-start.test.ts:134` | assert.notEqual(withBound.systemPrompt, bodyOnly.systemPrompt); | null |
| 730 | assert | `test/unit/pi-adapter-agent-start.test.ts:135` | assert.notEqual(withBound.systemPrompt, withOther.systemPrompt); | null |
| 731 | assert | `test/unit/pi-adapter-agent-start.test.ts:136` | assert.equal( currentSystemPrompt, renderAgentStartMaterials( renderAgentStartMaterials("BASE", [bound]), [otherBound], ), ); | null |
| 732 | assert | `test/unit/pi-adapter-agent-start.test.ts:244` | assert.ok(capturedEnv); | null |
| 733 | assert | `test/unit/pi-adapter-agent-start.test.ts:245` | assert.equal(capturedEnv.AK_ROLE_SUMMONS_INSTRUCTION, undefined); | null |
| 734 | assert | `test/unit/pi-adapter-agent-start.test.ts:246` | assert.equal( Object.prototype.hasOwnProperty.call(capturedEnv, "AK_ROLE_SUMMONS_INSTRUCTION"), false, ); | null |
| 735 | case | `test/unit/pi-adapter-agent-start.test.ts:71` | Pi adapter folds readingMaterial into provider systemPrompt and strips the typed field | null |
| 736 | case | `test/unit/pi-adapter-agent-start.test.ts:223` | #1199 Pi spawn env must not carry summons body (stdin already holds dialogue) | null |
| 737 | assert | `test/unit/process-cancel.test.ts:24` | assert.equal(processCancelDiagnostic("SIGTERM"), "ak-role terminated by SIGTERM"); | null |
| 738 | assert | `test/unit/public-cli-option-definitions.test.ts:82` | assert.deepEqual( helpDocument().globalOptions.map(structured), projectOwnerOptions("global").map(structured), ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 739 | assert | `test/unit/public-cli-option-definitions.test.ts:88` | assert.ok(doc, owner); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 740 | assert | `test/unit/public-cli-option-definitions.test.ts:89` | assert.equal(doc.command, owner); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 741 | assert | `test/unit/public-cli-option-definitions.test.ts:90` | assert.equal( doc.kind, owner === "global" ? "global" : owner === "analyst" ? "deterministic" : "role", ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 742 | assert | `test/unit/public-cli-option-definitions.test.ts:99` | assert.ok(fromTable.length > 0, owner); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 743 | assert | `test/unit/public-cli-option-definitions.test.ts:100` | assert.deepEqual( doc.options.map(structured), fromTable.map(structured), owner, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 744 | assert | `test/unit/public-cli-option-definitions.test.ts:106` | assert.equal(helpDocumentForCommand("not-a-command"), undefined); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 745 | assert | `test/unit/public-cli-option-definitions.test.ts:116` | assert.deepEqual(requiredRows.sort(), [ "auditor/source-run", "auditor/subject", "doctor/issue", "gleaner-left/base", "notary/source-run", "reviewer/authority-ref", "reviewer/base" | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 746 | assert | `test/unit/public-cli-option-definitions.test.ts:125` | assert.throws(() => parsePublicSeatArgv("reviewer", ["task"]), isUsage); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 747 | assert | `test/unit/public-cli-option-definitions.test.ts:127` | assert.deepEqual(parsePublicSeatArgv("collector", ["task"]), { instruction: "task", attachmentPaths: [], }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 748 | assert | `test/unit/public-cli-option-definitions.test.ts:131` | assert.throws(() => parsePublicSeatArgv("doctor", ["task"]), isUsage); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 749 | assert | `test/unit/public-cli-option-definitions.test.ts:146` | assert.throws( () => createTypedOptionConsumer([req]).assertRequired(), isUsage, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 750 | assert | `test/unit/public-cli-option-definitions.test.ts:152` | assert.ok(present.takeDashed(["--probe", "v"])); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 751 | assert | `test/unit/public-cli-option-definitions.test.ts:157` | assert.equal(parsePublicSeatArgv("coder", ["task"]).phase, "apply"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 752 | assert | `test/unit/public-cli-option-definitions.test.ts:158` | assert.equal(parsePublicSeatArgv("coder", ["plan", "task"]).phase, "plan"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 753 | assert | `test/unit/public-cli-option-definitions.test.ts:159` | assert.equal(parsePublicSeatArgv("coder", ["apply", "task"]).phase, "apply"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 754 | assert | `test/unit/public-cli-option-definitions.test.ts:160` | assert.equal(parsePublicSeatArgv("fixer", ["plan", "fix it"]).phase, "plan"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 755 | assert | `test/unit/public-cli-option-definitions.test.ts:161` | assert.equal(parsePublicSeatArgv("fixer", ["just fix"]).phase, "apply"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 756 | assert | `test/unit/public-cli-option-definitions.test.ts:220` | assert.throws( () => row.parse(row.argv), isUsage, row.name, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 757 | assert | `test/unit/public-cli-option-definitions.test.ts:227` | assert.deepEqual( parsePublicSeatArgv("coder", ["--attach", "/a", "--attach", "/b", "task"]).attachmentPaths, ["/a", "/b"], ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 758 | assert | `test/unit/public-cli-option-definitions.test.ts:231` | assert.deepEqual( parsePublicSeatArgv("reviewer", [ "--base", "main", "--lens", "completeness", "--authority-ref", "https://example.test/a", "--authority-ref", "https://example.tes | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 759 | assert | `test/unit/public-cli-option-definitions.test.ts:249` | assert.throws( () => parseAnalystArgv(["sweep", "sweep", "--attach", "/x"]), isUsage, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 760 | assert | `test/unit/public-cli-option-definitions.test.ts:257` | assert.ok(rejected.includes("--burden")); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 761 | assert | `test/unit/public-cli-option-definitions.test.ts:258` | assert.ok(rejected.includes("--ak-merger-input")); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 762 | assert | `test/unit/public-cli-option-definitions.test.ts:259` | assert.ok(rejected.includes("--project-root")); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 763 | assert | `test/unit/public-cli-option-definitions.test.ts:260` | assert.ok(rejected.includes("--model-groups")); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 764 | assert | `test/unit/public-cli-option-definitions.test.ts:264` | assert.ok(doc, owner); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 765 | assert | `test/unit/public-cli-option-definitions.test.ts:267` | assert.equal( rejected.includes(spelling), false, `${owner} leaked rejected ${spelling}`, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 766 | assert | `test/unit/public-cli-option-definitions.test.ts:289` | assert.ok(byId.get("ticket")?.modes?.includes("issue")); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 767 | assert | `test/unit/public-cli-option-definitions.test.ts:290` | assert.equal(byId.has("project-root"), false); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 768 | assert | `test/unit/public-cli-option-definitions.test.ts:291` | assert.equal(byId.has("model-groups"), false); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 769 | assert | `test/unit/public-cli-option-definitions.test.ts:292` | assert.equal(byId.get("cohort")?.selectsMode, "cohort"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 770 | assert | `test/unit/public-cli-option-definitions.test.ts:293` | assert.equal(byId.get("cohort")?.exclusiveWith, undefined); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 771 | assert | `test/unit/public-cli-option-definitions.test.ts:294` | assert.equal(byId.get("sweep")?.selectsMode, "sweep"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 772 | assert | `test/unit/public-cli-option-definitions.test.ts:295` | assert.equal(byId.get("attach")?.selectsMode, "sweep"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 773 | assert | `test/unit/public-cli-option-definitions.test.ts:296` | assert.deepEqual(byId.get("attach")?.requiredInModes, ["sweep"]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 774 | assert | `test/unit/public-cli-option-definitions.test.ts:297` | assert.deepEqual(byId.get("attach")?.maxCountByMode, { sweep: 1 }); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 775 | assert | `test/unit/public-cli-option-definitions.test.ts:304` | assert.deepEqual(byId.get(id)?.requiredInModes, ["cohort"]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 776 | assert | `test/unit/public-cli-option-definitions.test.ts:305` | assert.deepEqual(byId.get(id)?.modes, ["cohort"]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 777 | assert | `test/unit/public-cli-option-definitions.test.ts:307` | assert.deepEqual([...ANALYST_REQUIRE_ANY_OF], []); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 778 | assert | `test/unit/public-cli-option-definitions.test.ts:309` | assert.ok(rejected.includes("--project-root")); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 779 | assert | `test/unit/public-cli-option-definitions.test.ts:310` | assert.ok(rejected.includes("--model-groups")); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 780 | assert | `test/unit/public-cli-option-definitions.test.ts:399` | assert.equal(parseAnalystArgv(s.argv).query, s.expect.query, s.name); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 781 | assert | `test/unit/public-cli-option-definitions.test.ts:401` | assert.throws(() => parseAnalystArgv(s.argv), isUsage, s.name); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 782 | assert | `test/unit/public-cli-option-definitions.test.ts:416` | assert.equal(covered.has(rule), true, `missing ${rule}`); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 783 | assert | `test/unit/public-cli-option-definitions.test.ts:488` | assert.ok(ok >= 10); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 784 | assert | `test/unit/public-cli-option-definitions.test.ts:527` | assert.deepEqual({ ...structured(row), owner: "judge" }, canon, owner); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 785 | assert | `test/unit/public-cli-option-definitions.test.ts:528` | assert.equal(row.description.en, judgeProject.description.en, owner); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 786 | assert | `test/unit/public-cli-option-definitions.test.ts:530` | assert.notEqual( optionsForOwner("merger").find((o) => o.id === "project")!.description.en, judgeProject.description.en, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 787 | assert | `test/unit/public-cli-option-definitions.test.ts:534` | assert.equal(optionsForOwner("reviewer").some((o) => o.id === "attach"), false); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 788 | assert | `test/unit/public-cli-option-definitions.test.ts:536` | assert.deepEqual(analystAttach.modes, ["sweep"]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 789 | assert | `test/unit/public-cli-option-definitions.test.ts:537` | assert.equal(analystAttach.selectsMode, "sweep"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 790 | case | `test/unit/public-cli-option-definitions.test.ts:80` | table→helpDocument: per-command structured option semantics are equivalent | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 791 | case | `test/unit/public-cli-option-definitions.test.ts:109` | unconditional required: table required:true is the sole missing-option gate | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 792 | case | `test/unit/public-cli-option-definitions.test.ts:156` | real parsers: phase from table; repeatable:false rejects; repeatable:true admits | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 793 | case | `test/unit/public-cli-option-definitions.test.ts:255` | rejected spellings: absent from public surfaces; parsers refuse them | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 794 | case | `test/unit/public-cli-option-definitions.test.ts:285` | analyst structured mode contracts drive parseAnalystArgv (pos/neg matrix) | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 795 | case | `test/unit/public-cli-option-definitions.test.ts:420` | public dashed options admitted; shared project/attach owner-binding preserved | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:38 类别 M/D/C；承接 null |
| 796 | assert | `test/unit/public-cli-registry.test.ts:337` | assert.deepEqual([...PACKAGED_ROLE_REGISTRY], [...EXPECTED_PACKAGED_ROLE_METADATA]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 797 | assert | `test/unit/public-cli-registry.test.ts:338` | assert.deepEqual( [...PUBLIC_CALLABLE_ROLES], EXPECTED_PACKAGED_ROLE_METADATA.map((entry) => entry.role), ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 798 | assert | `test/unit/public-cli-registry.test.ts:342` | assert.equal(PUBLIC_CALLABLE_ROLES.length, EXPECTED_PACKAGED_ROLE_METADATA.length); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 799 | assert | `test/unit/public-cli-registry.test.ts:343` | assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("notary"), true); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 800 | assert | `test/unit/public-cli-registry.test.ts:344` | assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("countersign"), true); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 801 | assert | `test/unit/public-cli-registry.test.ts:345` | assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("gleaner-left"), true); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 802 | assert | `test/unit/public-cli-registry.test.ts:346` | assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("inspector"), true); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 803 | assert | `test/unit/public-cli-registry.test.ts:347` | assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("diarist"), true); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 804 | assert | `test/unit/public-cli-registry.test.ts:348` | assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("secretariat"), true); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 805 | assert | `test/unit/public-cli-registry.test.ts:349` | assert.deepEqual( [...PUBLIC_CONFIGURABLE_SEATS], [...PUBLIC_CALLABLE_ROLES], ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 806 | assert | `test/unit/public-cli-registry.test.ts:353` | assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("auditor"), true); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 807 | assert | `test/unit/public-cli-registry.test.ts:354` | assert.equal((PUBLIC_CALLABLE_ROLES as readonly string[]).includes("evidence-child"), false); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 808 | assert | `test/unit/public-cli-registry.test.ts:356` | assert.equal( (PUBLIC_CONFIGURABLE_SEATS as readonly string[]).includes(forbidden), false, `must not expose ${forbidden}`, ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 809 | assert | `test/unit/public-cli-registry.test.ts:368` | assert.equal(names.includes(command), true, `support command ${command}`); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 810 | assert | `test/unit/public-cli-registry.test.ts:371` | assert.equal(names.includes(role), true, `callable role ${role}`); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 811 | assert | `test/unit/public-cli-registry.test.ts:374` | assert.equal(rolesCap?.kind, "support"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 812 | assert | `test/unit/public-cli-registry.test.ts:376` | assert.equal(judgeCap?.kind, "role"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 813 | assert | `test/unit/public-cli-registry.test.ts:377` | assert.ok(judgeCap && judgeCap.kind === "role"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 814 | assert | `test/unit/public-cli-registry.test.ts:378` | assert.deepEqual(judgeCap.phases, [null]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 815 | assert | `test/unit/public-cli-registry.test.ts:380` | assert.ok(fixerCap && fixerCap.kind === "role"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 816 | assert | `test/unit/public-cli-registry.test.ts:381` | assert.deepEqual(fixerCap.phases, ["plan", "apply"]); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 817 | assert | `test/unit/public-cli-registry.test.ts:382` | assert.equal(fixerCap.defaultPhase, "apply"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 818 | assert | `test/unit/public-cli-registry.test.ts:384` | assert.equal(analystCap?.kind, "deterministic"); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 819 | assert | `test/unit/public-cli-registry.test.ts:385` | assert.equal( (PUBLIC_CALLABLE_ROLES as readonly string[]).includes("analyst"), false, "analyst is deterministic, not an LLM-configurable seat", ); | 整文件内断言；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 820 | case | `test/unit/public-cli-registry.test.ts:334` | public registry exposes callable roles with no automatic/classifiable distinction | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 821 | case | `test/unit/public-cli-registry.test.ts:364` | help capabilities derive from typed public registry facts | 整文件内整案；依据 docs/research/issue-1237-test-quality-sweep.md:39 类别 M/D；承接 null |
| 822 | assert | `test/unit/public-cli-ticket-argv.test.ts:16` | assert.equal(parsePositiveTicketNumber("582", "--ticket"), 582); | null |
| 823 | assert | `test/unit/public-cli-ticket-argv.test.ts:17` | assert.throws(() => parsePositiveTicketNumber("0", "--ticket"), CliUsageError); | null |
| 824 | assert | `test/unit/public-cli-ticket-argv.test.ts:18` | assert.throws(() => parsePositiveTicketNumber("08", "--ticket"), CliUsageError); | null |
| 825 | assert | `test/unit/public-cli-ticket-argv.test.ts:19` | assert.throws(() => parsePositiveTicketNumber("x", "--ticket"), CliUsageError); | null |
| 826 | assert | `test/unit/public-cli-ticket-argv.test.ts:28` | assert.equal("ticket" in parsed, false); | null |
| 827 | assert | `test/unit/public-cli-ticket-argv.test.ts:38` | assert.equal(parsed.sourceRun, "01a034f1-75bf-71a6-bcf5-d1299145b1a5@judge"); | null |
| 828 | assert | `test/unit/public-cli-ticket-argv.test.ts:39` | assert.equal("ticket" in parsed, false); | null |
| 829 | assert | `test/unit/public-cli-ticket-argv.test.ts:44` | assert.equal(parsed.query, "issue"); | null |
| 830 | assert | `test/unit/public-cli-ticket-argv.test.ts:45` | assert.equal(parsed.ticket, 125); | null |
| 831 | case | `test/unit/public-cli-ticket-argv.test.ts:15` | parsePositiveTicketNumber rejects non-positive and leading junk | null |
| 832 | case | `test/unit/public-cli-ticket-argv.test.ts:33` | parseNotaryArgv keeps required --source-run | null |
| 833 | case | `test/unit/public-cli-ticket-argv.test.ts:42` | parseAnalystArgv still binds --ticket (query scope, not seat binding) | null |

