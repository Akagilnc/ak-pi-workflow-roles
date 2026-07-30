## Evidence

- Start point is clean `6bb1eb6c10da4dcb5dd3132575298993346a085b`; `src/reviewer-execution-ledger.ts` has only that introducing commit. The predecessor used the same create/reconcile-before-validation family, so the repair must validate at the ledger seam rather than add another wrapper.
- Current probes reproduce all behavioral defects: persisted `persisted-A` plus runtime `runtime-B` audits as a successful `runtime-B` attempt; re-beginning a successful attempt returns normally; and string/object infrastructure throws are replaced with `Error` instances.
- `beginAgentCall` currently creates attempts from runtime arguments and later overwrites a running attempt without comparing the persisted current call. It also has no terminal re-entry rejection. `recordInfrastructureFailure` calls `captureError`, and line 1 imports Pi’s `Usage` type.
- The direct ledger suite passes 9/9 because it lacks these counterexamples; its defensive-copy test expressly begins persisted `persisted` evidence with runtime `runtime` arguments. Production tests also persist `{}` in their `context` helper while dispatching different Agent parameters.

## Smallest repair plan

1. **Repair only the ledger-owned invariants in `src/reviewer-execution-ledger.ts`.**
   - Capture the runtime current call and require its `description` and `prompt` to exactly equal the unique persisted current call before normal batch/attempt creation, mutation, or return to dispatch.
   - On first or repeated disagreement, use the existing provenance-failure path so the failed attempt and fatal infrastructure state are recorded together, then throw. Create normal attempts from the already-copied persisted calls and remove the final runtime overwrite.
   - After existing batch and cross-entry provenance checks, allow an existing attempt only when it is still `running` and the observation is identical. For a `successful` or `failed` attempt, record fatal provenance/lifecycle state and throw without settling over or otherwise modifying the terminal attempt.
   - Keep current cross-entry and conflicting-batch precedence and the operation-based frozen factory; add no handle, getter, target binding, state-machine object, or target-snapshot consistency guard.

2. **Remove the ledger’s Pi boundary import without changing runtime architecture.**
   - Define/export a local structural usage type containing the Pi-compatible token/cost shape, including optional `cacheWrite1h` and `reasoning`, and use it in result, attempt, clone, and freeze types.
   - Preserve optional usage fields during defensive copying. Re-export the local type beside the existing reviewer ledger types from `src/role-runtime.ts`; no handler decomposition is needed.

3. **Preserve exact infrastructure throw identity.**
   - Make `recordInfrastructureFailure` return its input unchanged (with a generic identity signature), while deriving diagnostics with `Error.message`/`String` and passing the original value separately to the existing snapshot/disposition copy routine.
   - Leave `failAgentCall` on `captureError`, preserving its expressly allowed wrapping and annotation of non-`Error` child failures.

4. **Add focused regression coverage without weakening existing acceptance criteria.**
   - In `test/reviewer-execution-ledger.test.ts`, cover first and repeated runtime/persisted argument conflicts, identical running re-observation, successful and failed terminal replay, preservation of terminal attempts, and fatal audit state. Correct the defensive-copy fixture so persisted and runtime values are identical before mutation.
   - Add string and sentinel-object identity assertions for `recordInfrastructureFailure`, with diagnostics/evidence mutated afterward to prove the ledger retained detached copies; retain a contrast assertion that non-`Error` child failure may still be wrapped by `failAgentCall`.
   - In `test/reviewer-role.test.ts`, let the persisted-message helper accept actual tool-call arguments and correct valid Agent fixtures. Add production-handler cases for first-observation conflict, start/execute repeated-observation conflict, and successful/failed terminal replay, asserting abort/fatal behavior and zero child starts beyond the first permitted dispatch. Add audit and cleanup adapters that throw a string or sentinel object and assert the exact value reaches the caller unchanged.

## Explicit non-scope

- Do not add a second snapshot consistency guard or alter first-invocation top-level snapshot selection; the rejected conflicting-snapshot disposition remains intact.
- Do not change `createReviewerAgentRunner`, target pinning, handles/getters, factory shape, tool contracts, Souls, README, schemas, or broader runtime decomposition.
- Do not alter `failAgentCall`’s non-`Error` child-failure behavior.

## Apply-phase verification and commit

1. Run `npm run typecheck`.
2. Run the complete suite with a fresh isolated `HOME` (`HOME=$(mktemp -d) npm test`, with cleanup) and the focused ledger/role tests separately if diagnosis is needed.
3. Run `npm pack --dry-run --json` from a temporary output location and assert the expected 14-file package still includes `src/reviewer-execution-ledger.ts` and contains no `SKILL.md`.
4. Run `git diff --check` and inspect the full diff against `6bb1eb6` for only the authorized ledger/type/test changes.
5. Create one new forward `fix:` commit (no amend/rewrite), then verify `6bb1eb6` is its strict ancestor, the commit count is one, and `git status --porcelain` is empty.

No files, tests, documentation, or Git history were modified during planning.
