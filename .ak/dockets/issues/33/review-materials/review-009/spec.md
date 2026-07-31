# Pinned Spec review materials

- method amendment: https://github.com/Akagilnc/ak-pi-workflow-roles/issues/17#issuecomment-5145155929
- base: `60927670d11b7f3e58800f98b98c518575e8acf7`
- target: `fc92fbdaaf1f62eae9079c98ce44d06dd430fe75`
- diff: `git diff 60927670d11b7f3e58800f98b98c518575e8acf7...fc92fbdaaf1f62eae9079c98ce44d06dd430fe75`

## Complete commit list

```text
fc92fbd docs(docket): preserve issue 33 review-005 repair
e8387b9 fix(recorder): compact native lifecycle sealing
b18af34 docs(docket): preserve issue 33 post-repair judgment
0022128 docs(docket): preserve issue 33 strict post-repair review
907f652 docs(docket): preserve issue 33 axis-isolation failure
28cf8f3 docs(docket): preserve issue 33 merged class repair
d8b4205 fix(recorder): stream lifecycle state and synchronize v2 schemas
a87934f docs(docket): preserve issue 33 merged judgment
8eaaa0c docs(docket): preserve issue 33 post-amendment review
5ae285b docs(docket): preserve issue 33 refused review
eda132e docs(docket): preserve issue 33 method-failed review
c0b45e5 docs(docket): preserve issue 33 C8 legality recheck
961ae8d docs(docket): preserve issue 33 completion judgment
994494e docs(docket): preserve issue 33 coder completion claim
8ff5334 fix(recorder): close v2 public schemas
88d097f docs(docket): preserve issue 33 refused boundary attempt
3228a06 test(recorder): pin streamed session boundaries
ed960f0 docs(docket): preserve issue 33 session-contract slice
53a784b test(recorder): prove config and session integrity matrix
fae1c27 docs(docket): preserve issue 33 coder continuation
b1d4185 fix(recorder): close native session lifecycle shapes
339e440 feat(recorder): seal native Pi sessions
8aa17ea docs(docket): preserve issue 33 design authority
```

## Authority paths

- `.ak/dockets/issues/33/judgment/design-authority/receipt.json` and `inputs/candidate`
- `.ak/dockets/issues/33/judgment/c8-legality-recheck/receipt.json`
- `.ak/dockets/issues/33/judgment/review-005/receipt.json`
- `.ak/dockets/issues/33/repair/review-005-apply/receipt.json`
- `.ak/dockets/issues/33/judgment/review-003-merged/receipt.json`

## Current Issue #33 tracker authority

```json
{
  "body": "## 案由\n\nIssue #12 的两次 Judge 调用均出现同一事实:\n\n- Pi child 正常退出 `0`;\n- package `ak_judge_output` 已通过审计并接受;\n- Recorder 随后在 `extraction` 返回 `internal-error / platform-error`;\n- 无 docket 被发布,只能靠 `--session-dir` 保留的 native session 找回现场。\n\n根因已用真实 Recorder seam 复现:Recorder 先完整 tee Pi `--mode json` stdout,结束后 `readFileSync` 整个文件。Pi 的 `message_update` 携带累计 assistant message,长/high-thinking 调用令 transport 近似二次膨胀;2 GiB stdout 稳定触发 Node `ERR_FS_FILE_TOO_LARGE`,映射成已见失败。\n\n与此同时,当前调用纪律已经强制:\n\n```text\npi --session-dir .ak/work/<issue>/runs/<invocation>/session\n```\n\nPi native session 已可靠保留消息、tool call/result、审计拒回、最终 accepted result、时间戳和失败现场。Recorder 再从无界 stdout 重建同一 lifecycle,属于重复记录和新的失效源。\n\n## Owner 方向\n\n**Recorder 不再做“录音机”;瘦成 package-owned docket sealer。**\n\n保留的不可替代职责:\n\n1. child spawn 前声明材料准入:Git reference、external input、exhibit 的身份/摘要/工作树约束;\n2. child 的真实 spawn/exit/signal 与有界公开诊断;\n3. 从该次 Pi native session 验证唯一 package-accepted typed result及 Judge/Reviewer audit observation;\n4. 只扫描、派生并持久化紧凑 receipt/manifest/redaction facts;raw session 不晋升、不提交;\n5. same-filesystem、atomic、create-if-absent publication。\n\n删除的旧职责:\n\n- 以完整 `--mode json` stdout/stderr 作为 receipt lifecycle 真源;\n- 落盘后整文件 `readFileSync`;\n- 对累计 `message_update` 的全量保存/扫描;\n- 为 stdout 双 representation 重建而存在的 transport 复杂度。\n\n## Authority 必须裁清的设计边界\n\n1. **Session 身份绑定**:config 如何 typed 声明该次 session 目录;Recorder 如何在 spawn 前后机械证明“恰好一个本次新建的顶层 Pi session JSONL”,处理预存文件、symlink、多个文件、缺失、修改和 child failure。\n2. **Accepted lifecycle 绑定**:native session 没有现行 machine stdout 的 `tool_execution_start`;需定义 top-level assistant toolCall → package toolResult 的充分、封闭、防递归伪造规则,以及 Judge/Reviewer audit fact 的来源。\n3. **通用性**:Recorder 是否正式收窄为 Pi-role sealer,还是保留非-Pi child/no-session 路径;不得为兼容保留两套并行复杂核心。\n4. **stdout/stderr**:是否只透传并保留固定大小 ring-buffer diagnostic;凭证扫描的边界必须明确,不能声称扫描未持久化的完整 raw session/stream。\n5. **失败与发布**:session 缺失/歧义/格式损坏/无 accepted result、child nonzero/signal、audit failure分别如何进入有限诚实状态;不得把 child failure洗成 Recorder failure,不得从 session 合成不存在的 receipt。\n6. **schema/version/caller 迁移**:config 是否升级版本;调用者如何从 `--mode json` 迁移;README 只写用法,契约归 schema/runtime。\n7. **原始 session 生命周期**:始终留在 gitignored `.ak/work`;sealer 不删除、不复制、不脱敏 raw session,由 caller 手工/策略清理。\n\n## 验收\n\n- [ ] 正常 Coder/Fixer/Judge/Reviewer/Collector native session 均可封出与 package typed contract一致的 receipt;Judge/Reviewer audit observation不丢失\n- [ ] child stdout 可超过 2 GiB 或无限产生无关 update而 Recorder 不整流物化、不因 stream 大小失败;测试必须在正确 seam 证明有界内存/有界诊断,不靠真实写满 2 GiB\n- [ ] session 缺失、零/多新文件、symlink、预存文件修改、截断 JSONL、递归伪造、重复 acceptance、toolCall/result 不同一、accepted text/details 不同一全部 fail closed\n- [ ] declaration admission仍在 spawn 前;receipt/manifest仍原子 no-replace发布\n- [ ] raw session、stdout、stderr均不进入 docket;秘密只在实际晋升的 typed 派生物和有界公开诊断上扫描\n- [ ] child exit/signal truth保留;未知失败保留真实 cause category,不冒标\n- [ ] package lifecycle、dist、schema、README与冷安装调用同步\n- [ ] 删除旧 stdout lifecycle extractor及其只服务旧 transport的测试/代码,不双轨\n\n## 非目标\n\n- 不实现 #12 Doctor/StatsLine;\n- 不展开 #26 全仓 failure-honesty sweep;\n- 不实现 #13 retry/recurrence;\n- 不把 raw session 变成第二 docket 或提交进 Git;\n- 不增加 scheduler、自动重试、角色路由、轮数或工作流拓扑;\n- 不因本票修 Pi 本身的 JSON event 设计。\n\n## 顺序\n\n本票先于 #12 Doctor construction。先由 Judge 裁定上述 session trust/config/failure contract,再按正常 Coder → Reviewer → Judge → authorized Fixer 流程实施。无需为已完整的 class disposition 增设 Plan。\n\n\n## C8 authority amendment — tests follow distinct production logic\n\nJudge recheck: `.ak/dockets/issues/33/judgment/c8-legality-recheck/receipt.json` (`c0b45e52fa5dfcd8f8c8d4023841bbf5808ff9e1`). This section supersedes only the original C8 proof-technique and exhaustive-matrix language; C1–C7, C9, and the rejected-attempt correction remain controlling.\n\n- Completion is determined by distinct production invariants under ADR 0016, not restored suite count, line count, every syntax permutation, or every role × failure cross-product.\n- Keep one-core deletion, session identity, acceptance lifecycle, derivative redaction, child outcome truth, atomic publication/raw exclusion, bounded forwarding, and packaged-contract behavior oracles.\n- Counter-child proof is representative: parser/table tests own rule breadth; one invalid real invocation proves zero spawn, and one valid invocation proves exactly one spawn plus exact injected session id/directory, preserved argv, `PI_SESSION_DIR` removal, and environment precedence.\n- Active-read publication invariant remains, but deterministic mutation specifically while synchronous fd streaming is active is withdrawn. Deterministic fd metadata, pathname/inventory rebinding, mutation at observable snapshot/verify boundaries, and the pre-publication verify call are sufficient. Do not add a production callback/async redesign/test hook solely to synchronize a timing race.\n- Exact hard limits retain ordinary/equal/first-illegal branch tests; redundant just-below permutations and corruption cross-products are not mandatory.\n- Five terminating tools receive cheap leaf/dispatch coverage for their distinct contracts. Recorder end-to-end coverage uses a minimal representative worker + audited role + Collector set (or an equivalently strong set), not five duplicated full runs.\n- Package/schema/cold-install coverage proves shipped synchronization minimally; it does not duplicate schema/runtime validators exhaustively.\n\nEffect on the prior Code5 judgment: the public-v2-schema finding remains; counter-child narrows to the representative oracle above; active-read timing is no longer a completion gap; whole-ticket assessment may cite only absent minimal behavior oracles, not deleted v1 test mass.\n",
  "comments": [
    {
      "id": "IC_kwDOTklDoM8AAAABMp454w",
      "author": {
        "login": "Akagilnc"
      },
      "authorAssociation": "OWNER",
      "body": "## Judge design authority — converged\n\nLawful receipt:\n\n```text\n.ak/dockets/issues/33/judgment/design-authority/receipt.json\ncommit 8aa17eaa060835727defb708b0adec48cdf98bcc\njudgeStatus: converged\n```\n\nAuthority convergence means the native-session sealer contract is construction-ready; Coder may proceed directly with TDD and no Plan round.\n\nRatified design:\n\n- Recorder v1 is replaced, not kept as a compatibility core.\n- v2 is Pi-role-specific and injects/binds a typed UUIDv7 session id and fresh `.ak/work` session directory.\n- raw stdout/stderr become byte-exact pass-through with fixed 4096-byte diagnostic tail rings; no scratch files, full-stream scan, or `readFileSync`.\n- one streamed Pi v3 main-session JSONL is selected and inode/digest/inventory bound; Reviewer leg sessions remain nested raw evidence and are never main candidates.\n- accepted Receipt comes only from one final package-accepted assistant-toolCall/toolResult pair; promoted derivatives alone are scanned and revalidated.\n- declarations remain pre-spawn; child exit/signal truth and atomic no-replace publication remain.\n- config/manifest/failure schemas move to v2; v1 and old machine-envelope/dual-representation extraction are deleted.\n\nJudge correction to the candidate: complete earlier `isError:true` package submission attempts are lawful before the one final accepted result. They create no Receipt/audit fact. Rejections-only map to `acceptance-missing`; malformed/replayed/conflicting or multiple successful lifecycles map to `acceptance-invalid`. This reflects real Judge audit-revise behavior and does not import #13 retry topology.\n\nNo #12/#13/#22/#26 implementation is authorized by this ticket.\n",
      "createdAt": "2026-07-31T14:51:02Z",
      "includesCreatedEdit": false,
      "isMinimized": false,
      "minimizedReason": "",
      "reactionGroups": [],
      "url": "https://github.com/Akagilnc/ak-pi-workflow-roles/issues/33#issuecomment-5144197603",
      "viewerDidAuthor": true
    },
    {
      "id": "IC_kwDOTklDoM8AAAABMqX9wA",
      "author": {
        "login": "Akagilnc"
      },
      "authorAssociation": "OWNER",
      "body": "C8 legality recheck has been incorporated into the issue body. The amendment preserves distinct trust invariants while deleting exhaustive technique, timing-hook, legacy-suite-mass, and cross-product completion requirements. Authority receipt: `.ak/dockets/issues/33/judgment/c8-legality-recheck/receipt.json`.",
      "createdAt": "2026-07-31T15:41:19Z",
      "includesCreatedEdit": false,
      "isMinimized": false,
      "minimizedReason": "",
      "reactionGroups": [],
      "url": "https://github.com/Akagilnc/ak-pi-workflow-roles/issues/33#issuecomment-5144706496",
      "viewerDidAuthor": true
    }
  ],
  "number": 33,
  "state": "OPEN",
  "title": "Thin Recorder into a native-session sealer; eliminate unbounded Pi JSON-stream materialization",
  "updatedAt": "2026-07-31T15:41:19Z",
  "url": "https://github.com/Akagilnc/ak-pi-workflow-roles/issues/33"
}
```
