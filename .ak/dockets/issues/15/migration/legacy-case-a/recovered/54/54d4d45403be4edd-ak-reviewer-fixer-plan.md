## Findings

- HEAD is clean at `98f36c0`; the Reviewer files have no repair history beyond that originating commit, so there is no prior failed repair family to repeat.
- `/tmp/ak-reviewer-self-review-2.jsonl` confirms both `Agent` calls are in the same finalized assistant message (line 171), start before either ends (172–175), and produce successful tool results (177/179).
- Pi guarantees the session manager is synchronized through the current assistant tool-calling message before tool execution; `getLeafEntry()` exposes the persisted session entry and its assistant `ToolCall` blocks. This is the correct provenance seam.
- `src/role-runtime.ts` currently records only flat attempts. `src/reviewer-auditor.ts` serializes only that record, explaining the valid refusal.
- `src/reviewer-agent.ts` manufactures a provider with the original prototype but without class private slots. A delegated adapter is required.
- `test/reviewer-package-lifecycle.test.ts` declares `fixture` but runs loader, session, and session manager from `packageRoot`. The fatal subprocess test covers only blank child output and malformed audit output, not the mandated matrix.

## Smallest repair plan

1. **Preserve persisted invocation batches in `src/role-runtime.ts`.**
   - Add a required `ReviewerAgentBatch` record containing the assistant session-entry ID, `executionMode: "parallel"`, and a readonly copy of all sibling `Agent` tool-call IDs from that assistant message; add `agentBatches` to `ReviewerExecutionRecord`.
   - At the start of `Agent.execute`, inspect only `ctx.sessionManager.getLeafEntry()`. Require a persisted assistant message containing the current call exactly once, derive its sibling `Agent` IDs, and deduplicate batches by assistant entry ID. If an existing batch disagrees, or the call cannot be tied to that entry, mark the attempt failed and use the existing infrastructure-fatal abort/nonzero path before starting a child.
   - Keep the registered tool’s `executionMode: "parallel"`; do not infer provenance from prompts, descriptions, timestamps, or prose and do not add a new orchestration surface.
   - Include copied batch records in every audit input (`[]` remains valid for a pre-Agent refusal). Attempts remain linked by their existing tool-call IDs, avoiding a second identity mechanism.

2. **Prove provenance through the existing real Pi seam.**
   - Extend `test/reviewer-role.test.ts` for fail-closed malformed/missing leaf entries and for distinct persisted assistant entry IDs producing distinct batches.
   - Extend the real lifecycle path in `test/reviewer-package-lifecycle.test.ts` so an actual Pi assistant message emits the two sibling axis calls, while a later actual assistant message emits a separate call. Assert the axis IDs share exactly one batch, the later call has another batch, and the assistant entry IDs match `SessionManager` entries.
   - Retain the existing child barrier but assert maximum active children is two, proving overlap rather than merely counting results.
   - Inspect the auditor request and allow a `completed` candidate to pass only after its structured record contains the sibling batch evidence. Update `test/reviewer-auditor.test.ts` to assert that complete batch evidence is serialized to the decision-only auditor context.

3. **Replace provider fabrication in `src/reviewer-agent.ts`.**
   - Introduce one Reviewer-local child-provider adapter object with the original provider’s identity/metadata, resolved auth and singleton resolved model exposure, and `stream`/`streamSimple` explicitly bound or delegated to the original provider instance. Do not clone prototypes or copy instance fields; do not introduce a generic provider/subagent framework.
   - Add a regression in `test/reviewer-agent.test.ts` using a real `Provider` class whose stream methods read a `#private` delegate. Run a child through the normal runner and assert the report and resolved auth/model dispatch succeed; this fails under the current `Object.create` implementation.

4. **Close only the mandated package/fatal gaps.**
   - In `test/reviewer-package-lifecycle.test.ts`, initialize `fixture` as an independent temporary consumer Git repository with the commits needed by the review task, install the packed tarball and peers there, load the installed entrypoint there, and use `fixture` for loader/session/session-manager `cwd`. Keep tarball-content and canonical-Skill assertions, and additionally assert the captured target root/HEAD belong to the consumer repository, not `packageRoot`.
   - Table-drive `test/audit-failure-subprocess.test.ts` across both print and JSON for child **preparation, provider, session, malformed output** and audit **auth, provider, malformed decision** failures. Use a narrow configurable Reviewer fixture (consolidating the two current Reviewer fixtures if smaller): non-Git cwd for preparation; armed auth/provider failure during Agent preparation; child error response for session; blank child report for malformed output; armed audit auth failure; provider removal after successful audit auth resolution for missing-provider dispatch; and non-tool audit output for malformed decision.
   - For every row assert exit code 1, abort/no later turn, no accepted receipt, no infrastructure refusal, and JSON aborted/error evidence. Leave Judge fatal tests unchanged.

5. **Validate and deliver in apply.**
   - Run focused Reviewer role/agent/auditor/lifecycle/subprocess tests, then `npm test`, `npm run typecheck`, `git diff --check`, and `npm pack --dry-run --json`.
   - Re-run the independent review against the new committed HEAD with the canonical external code-review Skill and `/tmp/ak-reviewer-self-review-task.md` authority updated to that HEAD; retain a `completed` receipt proving the repaired record passes audit rather than preserving the old refusal.
   - Confirm only Reviewer implementation/tests/fixtures changed; no Soul or documentation change is needed because the invariant belongs in runtime/schema and README already promises the parallel canonical method.
   - Create one new forward `fix:` commit without amend or history rewrite.

Explicitly excluded per the packet: symbolic-ref changes, role-map cleanup, CMR/panel/model selection/routing/chain behavior, and generic subagent or clone abstractions.
