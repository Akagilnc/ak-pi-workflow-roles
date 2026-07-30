## Baseline and authority findings

- `HEAD` is exactly the requested baseline `380b20515a821d6200625d5cb22cead2b699c25e` on `feature/deepen-role-runtime`; worktree is clean.
- `src/role-runtime.ts` is 1,216 lines. Reviewer ledger state and invariants are concentrated in its closure at roughly lines 380–612, with adapters at Agent/output registration and `tool_execution_start`, `tool_execution_end`, `tool_call`, `tool_result`, and `before_agent_start`.
- History confirms the required seam: `d979a87` added persisted assistant-message batch provenance; `3e78957` added sibling reconciliation, schema-validation failure settlement, and exact completion matching; `380b205` preserved opaque task bytes and audit boundaries.
- Applicable constraints: CONTEXT keeps Reviewer legs internal and forbids orchestration; ADR 0001 forbids speculative frameworks; ADR 0002 requires standalone/package behavior; ADR 0003 preserves named submission contracts; ADR 0004 forbids introducing target binding; ADRs 0005/0006 preserve Soul layering and same-model fresh audit; ADR 0007 forbids package retries; ADR 0008 preserves tool gating; ADR 0009 preserves git/tarball distribution. No Soul, README, CLI, schema, routing, retry, provider, or orchestration change is warranted.
- Baseline evidence is green: `npm run typecheck`; isolated-HOME `npm test` (71/71); `npm pack --dry-run --json` (13 entries, no `SKILL.md`); `git diff --check`.

## Proposed deep seam

Add `src/reviewer-execution-ledger.ts` and move the existing Reviewer evidence types there, while re-exporting those types from `src/role-runtime.ts` so current source consumers do not break. `reviewer-agent.ts` will import result/snapshot/disposition types from the new module; `ReviewerAuditInput` can remain in the runtime because soul/task/candidate dispatch is host policy, not ledger state.

Expose one factory, `createReviewerExecutionLedger()`, returning a narrow stateful interface:

1. `recordSkillExpansion(evidence)` — defensively captures host-validated canonical Skill evidence.
2. `beginAgentCall(callId, rawArguments, persistedBatch)` — accepts a small host DTO containing assistant entry ID plus persisted Agent sibling IDs/arguments. Internally it validates current-call occurrence and ID uniqueness, reconciles one immutable batch per assistant entry, detects conflicting/repeated cross-batch evidence, and creates exactly one attempt object per persisted call ID.
3. `completeAgentCall(callId, result)` — performs running→successful settlement, validates the nonblank report, and captures cloned report/usage/target snapshot/workspace disposition.
4. `failAgentCall(callId, error)` — performs fatal failed settlement, builds diagnostics, extracts cloned snapshot/disposition from the error, records infrastructure failure, and produces the existing evidence-bearing error (`reviewerAgentAttempt`).
5. `rejectAgentCall(callId, toolResult)` — settles Pi schema/tool-validation failures as failed without converting that ordinary persisted tool error into a host abort.
6. `recordBashCall(...)` / `recordBashResult(...)` — pairs parent bash evidence by call ID while preserving invocation order.
7. `recordInfrastructureFailure(error)` — records non-Agent Skill/audit/cleanup infrastructure evidence and returns a ledger-classified fatal error for the host.
8. `recordForAudit(status)` — for `completed`, first requires Skill evidence and proves a non-empty exact persisted-call/attempt bijection with every attempt successful and settled; for `refused`, imposes neither requirement. It returns a fresh recursively copied and frozen `ReviewerExecutionRecord`.

There will be no array getters, mutable state bag, generic event bus, Pi imports/side effects, provider calls, role logic, or audit dispatch in this module. Internal maps/order arrays, transition metadata, reconciliation, diagnostic text, cloning, and deep freezing remain hidden. Existing externally observed diagnostic wording will be retained where tests depend on it.

`src/role-runtime.ts` remains the Pi adapter:

- translate the current persisted leaf into the ledger’s small batch DTO (or absence/non-assistant evidence);
- call `beginAgentCall` both from the real Pi start event and direct tool execution, relying on idempotent reconciliation of the same persisted call;
- invoke `runReviewerAgent` only after reconciliation, then settle success/failure through the ledger;
- translate ledger-classified fatal failures through the unchanged `failInfrastructure` path (`ctx.abort()`, print/JSON `process.exitCode = 1`);
- keep tool registration, role selection, native Skill injection/capture, output validation, singleton final-call enforcement, audit invocation, shutdown, usage, and termination in the host;
- replace closure-built audit records with `ledger.recordForAudit(output.status)` before audit dispatch.

## Test-first sequence

1. **Add red direct-ledger tests** in `test/reviewer-execution-ledger.test.ts` before moving implementation. Exercise only the proposed public interface:
   - two calls from one assistant entry produce one shared ordered parallel batch;
   - later assistant entries produce separate batches;
   - duplicate IDs (within and across persisted evidence) and conflicting evidence are rejected before a provider-start sentinel;
   - one lifecycle per ID and valid running→successful/failed transitions;
   - completion proof rejects no calls, current-call missing/extra evidence, duplicate persisted IDs, running attempts, failed attempts with diagnostics, and every non-success/non-settled shape before an audit sentinel;
   - success preserves report, usage (including nested cost), target snapshot/refs, and deleted/retained workspace disposition;
   - fatal failure preserves diagnostics, snapshot, disposition, and prior-infrastructure state;
   - bash calls and out-of-order results pair by ID;
   - `recordForAudit` deep-copies and freezes the record: attempted mutation of top-level arrays and nested skill, batch IDs, usage/cost, snapshot refs, attempts, and bash entries cannot alter a later record;
   - refused produces an auditable empty record without Skill/Agent evidence.
2. **Strengthen existing runtime characterization without deleting or weakening assertions** in `test/reviewer-role.test.ts`:
   - retain current same-message/separate-message, duplicate/conflict, missing leaf, native Skill, malformed real-Pi sibling, refusal/resubmission, singleton output, and cleanup tests;
   - extend the successful Agent case to assert the audit record preserves report, usage, target snapshot, refs, and workspace disposition;
   - add parent `tool_call`/`tool_result` pairing coverage through the production event seam;
   - add an auditor that attempts nested record mutation, then resubmits, proving ledger state remains unchanged and audit input is immutable;
   - assert all invalid completion states stop before `auditReviewerCompliance`.
3. **Keep real production seams as regression gates**:
   - leave the real-Pi malformed-sibling test intact to prove Pi validation can bypass `Agent.execute` while `tool_execution_end` still settles the sibling failed;
   - leave `test/audit-failure-subprocess.test.ts` intact for all Reviewer print/JSON fatal stages, aborts, nonzero exits, provider-call counts, and no false receipt;
   - leave `test/reviewer-package-lifecycle.test.ts` behavior assertions intact; only add that the tarball contains `src/reviewer-execution-ledger.ts` and still contains no `SKILL.md`;
   - run all existing Judge/Fixer/Coder/Reviewer tests unchanged, including package entrypoint, schemas, role tools, canonical Skill invocation, audits, usage, and termination.
4. **Implement the ledger** until direct tests pass, using internal `Map`-based identity plus explicit ordered batch/bash collections, strict transition checks, explicit evidence cloning, and recursive freeze. Do not expose test-only seeding or mutable inspection hooks.
5. **Replace, do not layer**: remove `CapturedReviewerAgentInvocationBatch`, capture/reconciliation helpers, diagnostic helper, Reviewer arrays, infrastructure string, and audit-record assembly from `role-runtime.ts`; wire all existing lifecycle callbacks to the ledger. A same-pattern search must show no second Reviewer attempt/batch/bash/infra state machine remains in the runtime.
6. **Verify no introduced regression** with the unified gate:
   - `npm run typecheck`
   - `EMPTY_HOME=$(mktemp -d); HOME="$EMPTY_HOME" npm test`
   - `npm pack --dry-run`
   - `git diff --check`
   Also inspect the tarball list for no `SKILL.md`, use `rg` to confirm the old closure helpers/state are gone, and check the diff touches only the new internal module, runtime/type imports, and focused tests.
7. In the apply phase only, make one forward commit after all gates pass, then confirm `git status --short --branch` is clean. Do not amend, squash, or push.

No files were edited and no commit was created during this planning phase.
