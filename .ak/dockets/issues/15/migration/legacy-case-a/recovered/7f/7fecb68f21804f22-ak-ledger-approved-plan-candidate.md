## Consolidated construction plan

### Baseline and scope

- Work from `380b20515a821d6200625d5cb22cead2b699c25e` on `feature/deepen-role-runtime`; the worktree is currently clean and `src/role-runtime.ts` is 1,216 lines.
- Add only the deep internal seam `src/reviewer-execution-ledger.ts`, then replace the corresponding closure state/helpers in `src/role-runtime.ts`. Make only necessary type-import changes in `src/reviewer-agent.ts` and focused test updates.
- Preserve every frozen role, CLI, schema, Soul, Skill, tool-surface, provider, audit, usage, fatal-action, package-lifecycle, and termination behavior. Do not introduce routing, retries, orchestration, a generic event bus/framework/repository, or any other decomposition.

### 1. Lock behavior with tests before extraction

Add `test/reviewer-execution-ledger.test.ts` against the proposed public ledger interface before moving implementation. Cover:

- one ordered shared batch for sibling calls from one assistant entry and distinct batches for later entries;
- duplicate IDs within one entry and across entries, conflicting repeated batch evidence, unavailable/non-assistant evidence, and a current ID not occurring exactly once—all rejected before a child-start sentinel;
- an identical repeated Pi start/execute observation being idempotent;
- exactly one attempt lifecycle per ID, valid running→successful/failed settlement, and illegal repeated or successful→failed settlement rejection;
- completion rejection for no calls, running calls, ordinary failed calls, and orphan/extra attempts; persisted missing/duplicate shapes made impossible by atomic reconciliation are tested at the earlier public operation that rejects them, not fabricated through state seeding;
- successful report, nested usage/cost, target snapshot/refs, and deleted/retained workspace disposition;
- fatal diagnostics and evidence, plus prior-fatal rejection for both `completed` and `refused`;
- parent bash call/result pairing by ID, including reverse result order and unknown results;
- an empty refusal remaining auditable without Skill or Agent evidence.

Prove defensive ownership explicitly: mutate every caller-owned Skill object, persisted call/arguments object, result usage/cost, snapshot refs, retained disposition, and error evidence after recording; then attempt top-level and nested mutation of an audit record and request a second record. Both records must retain original values, and frozen-output mutations must throw or have no effect.

Strengthen—never delete, rewrite, or weaken—`test/reviewer-role.test.ts` characterization through production handlers:

- retain same-message/separate-message batching, duplicate/conflicting/missing provenance, native Skill, malformed real-Pi sibling, refusal/resubmission, singleton output, and cleanup assertions;
- assert Agent `details` and successful audit input preserve report, usage/cost, snapshot/refs, and disposition;
- exercise bash call/result pairing through `tool_call`/`tool_result`;
- have the auditor attempt and locally handle nested mutation, return `revise`, then verify a resubmission receives a fresh unchanged immutable record;
- prove every representable invalid completion state stops before `auditReviewerCompliance`, and prove a refusal after prior fatal Agent/Skill/audit/cleanup state cannot produce a receipt;
- keep the real-Pi malformed-sibling case proving Pi validation can skip `Agent.execute` while `tool_execution_end` records that persisted sibling failed.

Keep `test/audit-failure-subprocess.test.ts` as the print/JSON fatal-channel gate. Update `test/reviewer-package-lifecycle.test.ts` only to require the new source module in the tarball while retaining all installation/lifecycle assertions and the no-`SKILL.md` assertion.

### 2. Build one deep Reviewer ledger

Create `createReviewerExecutionLedger()` in `src/reviewer-execution-ledger.ts`. Move all Reviewer evidence/result/record types there and re-export their existing names from `src/role-runtime.ts`; keep `ReviewerAuditInput` in the host because soul/task/candidate/audit dispatch are host policy. Import runner result/snapshot/disposition types directly from the ledger.

Expose no getters or mutable state bag. The small stateful interface will provide:

1. `recordSkillExpansion(evidence)`: defensively capture the host-validated canonical expansion exactly once; an identical repeat may be idempotent, but replacement/conflict is rejected.
2. `beginAgentCall(callId, rawArguments, persistedEvidence)`: accept a discriminated host DTO for either an assistant entry (`entryId` plus ordered Agent IDs/raw arguments) or unavailable/non-assistant evidence. Internally copy inputs, validate the current occurrence and within/across-batch uniqueness before child start, reconcile one immutable batch per assistant entry, make identical repeated start/execute observations idempotent, and create at most one invocation-ordered attempt per persisted ID.
3. `completeAgentCall(callId, result)`: allow only running→successful, reject a blank report, defensively capture report/usage/cost/snapshot/refs/disposition, and return a detached recursively frozen `ReviewerAgentAttempt` for the existing Pi Agent `details`. The host continues to return the original report as `content` and usage through Pi’s `usage` field.
4. `failAgentCall(callId, error)`: use only after valid reconciliation when child/result processing fails. Allow only running→failed, capture cloned diagnostics/snapshot/disposition, mark prior-fatal state, and return the original Error (or a wrapped Error for non-Errors) decorated with a detached frozen `reviewerAgentAttempt`.
5. `rejectAgentCall(callId, toolResult)`: record Pi schema/tool rejection as an ordinary failed attempt, creating an orphan/extra attempt if no start was observed, without setting fatal infrastructure state. A duplicate terminal observation must not create a second lifecycle or overwrite fatal evidence; an incompatible settled transition is rejected.
6. `recordBashCall` / `recordBashResult`: retain invocation order and pair results by call ID without exposing mutable entries.
7. `recordInfrastructureFailure(error)`: retain fatal diagnostics/evidence for Skill, audit, or cleanup failures while returning/preserving the original thrown failure for the host adapter.
8. `recordForAudit(status)`: first reject prior fatal infrastructure for both `completed` and `refused`. For `completed`, additionally require Skill evidence and prove a non-empty exact persisted-call/attempt bijection with unique IDs and every attempt settled successful. For `refused`, require neither Skill nor Agent completion evidence and permit ordinary rejection evidence, but never turn fatal infrastructure into a receipt. Return a fresh explicitly cloned and recursively frozen `ReviewerExecutionRecord` each time.

Keep all maps/order arrays, transition rules, batch reconciliation, completion proof, diagnostic construction, cloning, and freezing private. Preserve current ordering and diagnostic text relied on by tests, including top-level `targetSnapshot` selection from the first invocation-ordered attempt carrying one.

### 3. Make provenance failure ownership atomic

`beginAgentCall` owns provenance failure recording before throwing its evidence-bearing error. It may settle a current running attempt failed when valid, but must never mutate an already successful/failed attempt merely because later duplicate or conflicting evidence refers to that ID. It records the prior-fatal state itself.

Split the host Agent execution boundaries:

- first translate the current Pi persisted leaf into the small discriminated DTO and call `beginAgentCall` in its own try/catch; route any already-recorded provenance error directly through unchanged `failInfrastructure`;
- only after reconciliation succeeds, run `runReviewerAgent` in a second boundary; pass child/result failures to `failAgentCall`, then route its returned decorated error through `failInfrastructure`;
- on success, call `completeAgentCall` and use its returned frozen attempt snapshot as Agent `details`;
- never pass a `beginAgentCall` error to `failAgentCall`, avoiding illegal settled→failed transitions and masked provenance diagnostics.

Both `tool_execution_start` and direct `Agent.execute` use `beginAgentCall`; idempotent reconciliation handles Pi’s repeated observation. `tool_execution_end` uses `rejectAgentCall` so schema-invalid persisted siblings are settled even when Pi prevents `Agent.execute`.

### 4. Keep Pi policy and side effects in the host

`src/role-runtime.ts` remains the only adapter for persisted leaf translation, `ctx.abort()`, print/JSON `process.exitCode = 1`, tool registration/selection, native Skill capture, role/system-prompt logic, provider calls, audit dispatch, shutdown, usage, and termination.

- After `captureCanonicalReviewerSkillExpansion` validates the native expansion, pass its evidence to `recordSkillExpansion`; route capture/binding failures through `recordInfrastructureFailure` and then the existing fatal adapter.
- Before audit dispatch, call `recordForAudit(output.status)` and pass its immutable result in `ReviewerAuditInput`.
- On audit or cleanup exceptions, call `recordInfrastructureFailure` before the unchanged fatal adapter. Apply the same evidence recording when session-shutdown cleanup throws, while preserving that lifecycle’s existing throw behavior.
- Replace closure mutation with ledger calls in `tool_execution_start`, `tool_execution_end`, `tool_call`, and `tool_result`.
- Remove, rather than retain alongside the ledger, the old Reviewer arrays, infrastructure string, attempt/batch helpers, diagnostic helper, completion reconciliation, and audit-record assembly.

### 5. Verification and apply-phase commit

Run the exact unified gate:

```bash
npm run typecheck
EMPTY_HOME=$(mktemp -d)
HOME="$EMPTY_HOME" npm test
npm pack --dry-run
git diff --check
```

Also inspect the dry-run tarball list to confirm `src/reviewer-execution-ledger.ts` is present and no `SKILL.md` is packaged. Use focused `rg` checks to prove `src/role-runtime.ts` contains no second Reviewer attempt/batch/bash/infrastructure state machine or removed helper pattern. Review the diff for only the new module, host/type wiring, and focused tests; the complete suite remains the introduced-regression and Judge/Fixer/Coder/Reviewer lifecycle gate.

Only in the apply phase, after all gates pass, create one forward commit, then confirm a clean worktree. Do not amend, squash, rewrite, push, or make any plan-phase edit/commit.

No files were edited and no commit was created while producing this consolidated plan.
