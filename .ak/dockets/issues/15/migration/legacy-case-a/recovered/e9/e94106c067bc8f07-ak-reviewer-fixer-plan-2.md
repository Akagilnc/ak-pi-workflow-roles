# Consolidated Reviewer repair plan

## Established facts

- The worktree remains clean at `98f36c046d1bcd68cac155868d313c8cf00bc2d1`; planning made no edits or commits.
- Relevant Reviewer files have no repair history beyond their originating `98f36c0` commit, so there is no earlier failed repair family to repeat.
- `/tmp/ak-reviewer-self-review-2.jsonl` proves the two successful `Agent` calls were sibling tool calls in one persisted Pi assistant message and overlapped. The runtime currently flattens that provenance before audit.
- The Judge has disposed of symbolic-ref identity and repeated-switch cleanup. They are outside this repair.

## Repair sequence

### 1. Preserve immutable Pi invocation-batch evidence at `Agent.execute`

- In `src/role-runtime.ts`, add a Reviewer-local typed batch record containing:
  - the persisted assistant session-entry ID;
  - `executionMode: "parallel"`;
  - an immutable copied list of all sibling `Agent` tool-call IDs in that assistant message.
- Add the batch collection to `ReviewerExecutionRecord`. Keep attempts identified by their existing tool-call IDs; do not add another attempt identity or orchestration API.
- At the start of every `Agent.execute`, record the attempt and then inspect only `ctx.sessionManager.getLeafEntry()`. Require a message entry whose message is an assistant message, contains the current `Agent` call exactly once, and yields its sibling `Agent` IDs. Insert one batch per assistant entry ID and reject any conflicting duplicate. Do not infer provenance from descriptions, prose, prompts, timestamps, or transcript text.
- If the current call cannot be tied to that persisted assistant message, mark its already-recorded attempt `failed`, attach the stage diagnostic, call the existing infrastructure-fatal abort/nonzero path, and start no child. Keep the registered tool’s `executionMode: "parallel"`.
- Copy batch records into every audit input; a pre-Agent refusal may still carry an empty batch list.

### 2. Prove provenance, overlap, and audit acceptance through real Pi behavior

- Extend `test/reviewer-role.test.ts` with malformed and missing leaf-entry cases. Each case must mechanically assert:
  - one abort;
  - one recorded failed attempt with the expected provenance diagnostic;
  - zero `runReviewerAgent`/child starts;
  - no accepted receipt.
- Table/unit-test that calls tied to one assistant entry share exactly one batch, while calls tied to separate persisted assistant entry IDs produce separate batches.
- Extend `test/reviewer-package-lifecycle.test.ts` so an actual Pi assistant message emits the two sibling axis calls and a later actual assistant message emits a separate `Agent` call. Assert the axis IDs share one batch, the later ID belongs only to a different batch, and all recorded assistant IDs match real `SessionManager` entries.
- Make the real-Pi overlap proof deterministic: track active children and peak concurrency; the first axis waits for the second, but a bounded timeout rejects/releases with a unique parallelism failure instead of hanging if Pi regresses to sequential execution. Assert peak concurrency is exactly two.
- Inspect the structured auditor request. The lifecycle auditor should return `pass` for the completed candidate only after asserting that the two axis IDs occur in the same persisted batch with parallel mode; this turns missing provenance into a failing test rather than a permissive fake.
- Update `test/reviewer-auditor.test.ts` with a completed input containing real-shaped batch evidence. Assert the complete batch is serialized into the decision-only context and that the auditor can return `pass` for that receipt.

### 3. Replace private-slot-breaking provider fabrication

- In `src/reviewer-agent.ts`, remove the `Object.create`/`Object.assign` provider fabrication.
- Build one narrow Reviewer child-provider adapter that explicitly exposes the original provider’s identity/metadata, overrides only resolved auth and the singleton resolved model catalog, and delegates `stream` and `streamSimple` directly to the original provider instance. Preserve the original receiver when calling either stream method; do not clone prototypes or instance fields and do not create a generic provider/subagent framework.
- Add a regression in `test/reviewer-agent.test.ts` with an actual class-based `Provider` whose stream implementation reads a `#private` delegate. Register that instance in the normal parent runtime, run a child through `createReviewerAgentRunner`, and assert successful report production plus resolved auth/model/base URL dispatch. This must fail under the current fabricated receiver.

### 4. Run the installed tarball from an independent consumer Git repository

- In `test/reviewer-package-lifecycle.test.ts`, initialize the currently unused `fixture` as an independent temporary Git repository with base and reviewed commits suitable for the review task.
- Put the consumer `package.json`, installed tarball and peer dependencies, review task, loader, session manager, and agent session under/use `fixture`; load only the installed package entrypoint rather than source-checkout code. Retain explicit canonical external Skill loading and tarball assertions.
- Assert captured `repositoryRoot`, target `HEAD`, fixed-point behavior, and child snapshots belong to the consumer repository and its commits—not `packageRoot`. Retain native Skill expansion, real sibling calls, audit revise/resubmit, terminating completed receipt, and tarball absence of bundled `SKILL.md`/copied method content.

### 5. Make every mandated fatal row prove it reached its intended stage

- Replace or consolidate the two Reviewer failure fixtures into one narrow stage-configurable fixture if that is smaller. Table-drive both print and JSON for exactly these classes. Define “provider calls” as fixture stream invocations and assert the following per row:

| Failure row | Unique required stage diagnostic/marker | Expected provider calls | JSON errored tool |
| --- | --- | ---: | --- |
| child preparation | non-Git/preparation diagnostic unique to this row | 1 | `Agent` |
| child provider | `Reviewer Agent provider not found` (or equivalent injected provider marker) | 1 | `Agent` |
| child session | injected child session/error-response marker | 2 | `Agent` |
| child malformed output | blank/malformed child report diagnostic | 2 | `Agent` |
| audit auth | injected Reviewer audit authentication marker | 1 | `ak_reviewer_output` |
| audit provider | `Reviewer compliance audit provider not found` marker | 1 | `ak_reviewer_output` |
| audit malformed decision | `invalid reviewer audit decision` marker | 2 | `ak_reviewer_output` |

- Emit each marker only when its injected stage is actually reached, and log the fixture call count on shutdown. Do not accept a startup/provenance failure as evidence for a later matrix row.
- For every row and mode, assert exit code 1, the unique stage marker, the exact provider-call count, abort/no later successful turn, no accepted receipt, and no infrastructure refusal.
- In JSON, additionally assert the specific tool-result event has `isError: true`: `Agent` for all child rows and `ak_reviewer_output` for all audit rows. Retain the aborted stop assertion, but do not use a generic aborted stop as the sole proof.
- Leave existing Judge fatal fixtures and assertions unchanged.

### 6. Verification, completed re-review, and delivery during apply

- Run focused Reviewer role, agent, auditor, package lifecycle, and fatal subprocess tests first.
- Then run the repository’s full requirements: `npm test`, `npm run typecheck`, `git diff --check`, and `npm pack --dry-run --json` (plus the installed-tarball lifecycle as part of the required suite).
- Audit the final diff so only Reviewer-owned implementation/tests/fixtures changed. No Soul or documentation change is planned: provenance belongs in typed runtime evidence, and the existing public/canonical method requirements already state the invariant.
- Create one new forward `fix:` commit without amend or history rewrite, and verify new `HEAD` is a strict descendant of `98f36c0`.
- Update the independent-review authority to the new committed HEAD, rerun the canonical external code-review Skill against that fresh HEAD, and retain a `completed` audited receipt demonstrating that the repaired structured batch evidence is accepted. The current refusal is historical evidence only and must not remain the repair outcome.

## Explicit exclusions

No symbolic-ref work, role-map cleanup, CMR, panel/model selection, routing, chain behavior, generic subagent/clone framework, or changes to Judge/Fixer/Coder contracts.
