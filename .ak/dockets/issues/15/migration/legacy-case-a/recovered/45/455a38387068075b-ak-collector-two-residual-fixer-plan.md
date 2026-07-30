# Plan-Gate: Collector two residuals @ 25d0da2

HEAD `25d0da2` (clean). Prior cancel fix used `/abort|cancel/i` text (same failed family). Prior after-deadline fix compares `firstObservedAt` to deadline but stamps it at observe-start (`collector-ledger.ts:700`) before surfaces return — guard correct, trust fact wrong when observe crosses cutoff.

No code/test/doc/git changes in this plan phase.

---

## Residual 1 — signal-state cancellation (not reason text)

### Behavior
Any in-flight `createIssueComment` failure while `input.signal.aborted === true` is **cancellation**: rethrow the original rejection reason (Error or non-Error). Must **not** map to `{kind:"rejected"}` / `{kind:"ambiguous_loss"}` / success. Ledger then keeps attempt non-terminal (`started`), retains process-local one-shot `attemptKeys`, does not latchFatal-as-rejected. Reasons without `abort|cancel` text (e.g. `Error("deadline exceeded")`, `"stop now"`) must cancel identically. Child POST still SIGTERM'd via existing runner abort listener.

### Owner
`src/collector-github.ts` — `createGhCollectorGitHubTransport().createIssueComment` catch path (~543–554).

**Knife:** In `catch`, if `input.signal?.aborted`, `throw error` (preserve runner’s `signal.reason`). Remove dependence on `/abort|cancel/i` message matching for this seam (optional keep `AbortError` name only as non-signal belt; primary authority is signal state). Do **not** add new cancel status enum, binder, or ledger cancel state.

No ledger/request API change required: throw already bypasses rejected/ambiguous handling; attempt stays `started`.

### Red
- Hung POST + `controller.abort(new Error("deadline exceeded"))` → today `{kind:"rejected"}` / fatal rejection path.
- Hung POST + `controller.abort("stop now")` → same (non-Error reason fails `instanceof Error`).

### Green
- Real hung-POST coverage (retain child-kill fixture) for both reasons above:
  - throw surfaces original reason (assert reason text, not `/abort|cancel/i`);
  - POST child killed;
  - `attempts[0].status` not in `rejected|ambiguous_loss|succeeded|recovered`;
  - process-local one-shot still blocks second request at same HEAD;
  - no late success path.
- Existing `request canceled` hung-POST test and R11 observe/GET cancel tests remain green.

### Scope
- Touch: `src/collector-github.ts`; `test/collector-github.test.ts` (extend/add hung-POST cases).
- Out: Soul, runner redesign, new attempt status, observe cancel rewrite, relaxing one-shot.

---

## Residual 2 — conservative first-sighting time when observe crosses cutoff

### Behavior
First-sighting trust for review `submitted_at` retention must use a wall time **no earlier than actual surface observation**. Observe-start-before / surface-after-deadline must **not** keep pre-deadline `submitted_at` or classify `before`/`valid` from that backdate. **Completion time is an acceptable** conservative stamp. Exact-deadline equality (`firstObservedAt == deadline`) still may retain `submitted_at` (existing unit oracle stays).

### Owner
`src/collector-ledger.ts` — `observe()` evidence stamping after surfaces are in hand (~700–750), feeding existing `applyEvidenceVersionHistory(…, deadlineTime)` in `src/collector-evidence.ts` (guard stays; do not re-implement classifier).

**Knife (minimal):** After successful `fetchObserveSurfaces` (and identity retry), set the time used for `normalize*Evidence` / `firstObservedAt` from `clock.wallNow()` at that point (or reuse the soon-following `completedAt` — same conservative fact). Do not stamp first-sighting trust from pre-fetch observe-start alone.

Prefer: keep snapshot start/complete distinction if already relied upon; only evidence `firstObservedAt` (and the normalize pass that commits records) must be conservative. Budget retain during fetch may keep a temporary stamp (byte budget only). No parallel validator; no change to R5 known-version null reuse; comments keep `updated_at` rules.

### Red
Receipt-path: activation 00:10 (deadline 00:25); observe starts 00:24:59 with empty reviews; mid-fetch clock → 00:25:01 and a new review appears (`submitted_at=00:00`, expected author, exact head); observe completes 00:25:01.
- Today: `firstObservedAt=00:24:59` → keeps `submitted_at` → `before` → can `valid`.
- Required: conservative first-sighting > deadline → `authoritativeTime=null` → cannot prove `valid` (and not false `unavailable` from backdate).

### Green
- New receipt/ledger integration test for start-before/finish-after newly appearing review (fake transport advances clock + injects review on list).
- Existing unit tests remain:
  - `applyEvidenceVersionHistory first review keeps submitted_at at/before deadline` (exact boundary);
  - `after-deadline first review nulls authoritativeTime` + known-null reuse;
  - `after-deadline first observation of review cannot prove valid or unavailable`.

### Scope
- Touch: `src/collector-ledger.ts` observe stamping; tests in `test/collector-receipt.test.ts` and/or `test/collector-ledger.test.ts`.
- Out: changing `applyEvidenceVersionHistory` predicate shape unless stamp wiring alone is insufficient; Soul; broadening window/relation redesign; weakening exact-deadline oracle.

---

## Preservation (do not regress)
R1 valid precedence · R2 same-leg citation · R3 stale-H1 rejection · R4 transitive embedding · R5 known-null reuse · R6 tombstoned users · R7 originalLine · R8 raw redaction · R9 updatedAt bracket · R10 pagination budget · R11 observe/GET cancel · prior six-root 25d0da2 seams (target unavailable provenance, 2xx parse→ambiguous_loss, inline author ownership, body schema parity, request signal threading, after-deadline guard existence).

## Anti-patterns (refused if proposed at apply)
- Extending `/abort|cancel|deadline|…/` regex instead of `signal.aborted`.
- Deleting/relaxing one-shot, child-kill, or exact-deadline tests.
- Stamping `firstObservedAt` earlier than surface observation “and compensating” with extra heuristics.
- Amend/rewrite of `25d0da2`; Soul edits; new cancel/recovery subsystem.

## Apply verification (when approved)
1. Targeted: `collector-github`, `collector-ledger`, `collector-receipt` tests.
2. Confirm worktree = only authorized residual fixes.
3. Single new forward commit (no amend); title prefix per task contract; body cites both residuals + preservations.
4. HEAD strict descendant of plan HEAD `25d0da2`.
