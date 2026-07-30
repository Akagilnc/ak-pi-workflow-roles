# Fixer plan — Collector R1–R11 at `9cc03df`

## Preconditions (verified)

- HEAD is exactly `9cc03df314f3014e9cbfa57f3c010a9e1658b8ac`; worktree clean.
- No authority gap: packet maps each root to an existing owner seam; no Soul/schema/transport layer addition required; no owner decision needed.
- **Preserve as-is (already converged):**
  - `6fc54e1` single-wait 5‑minute cap (`COLLECTOR_SINGLE_WAIT_MAX_MS` in `wait`)
  - `9cc03df` observe `modelView` projected into provider-visible `content`
  - `a817975` repeated PR identity drift fail-closed after one full-surface retry
- **Do not:** amend history; add Soul text; add parallel classifiers/frameworks; relax AC; delete pagination; invent a second AbortController.

## Historical testimony (avoid repeat)

| Commit | Lesson |
| --- | --- |
| `ce5d2e4` | Original construction left R1–R4, R6–R8, R10–R11 open (first-match valid, final-membership target scope, selective embed, throw-on-null user, drop `originalLine`, full `/user` raw, post-hoc size, ignore observe signal). |
| `c7ee3b5` | Added review-version uncertainty + initial/terminal PR bracket, but **incomplete**: uncertainty only on *new* version; bracket identity = `state\|headOid` only → residuals **R5, R9**. |
| `a817975` / `6fc54e1` / `9cc03df` | Narrow correct fixes; keep them; do not re-open. |

Green suite today does not dispose defects (cross-leg oracles skip `valid`; stale-target removes the comment; edit tests stop before unchanged third observe; receipt checks direct leg/report refs only).

---

## Owner group A — Receipt (`src/collector-receipt.ts`)

Shared helpers to add/reuse (no duplicate classifiers):

- Reuse `reviewQualifiesForValid` from `collector-evidence.ts` (already imported).
- Add small local helpers only where receipt owns the invariant:
  - `finalHasQualifyingValidReview(leg)` — scan **final snapshot** evidence via `reviewQualifiesForValid`.
  - `establishedHeadFor(evidenceId)` — first chronological snapshot in `ledger.allSnapshots()` whose `evidenceIds` contains the id → that snapshot’s `headOid` (establishment HEAD, not final membership).

### R1 — Terminal precedence over exact-HEAD valid

| Field | Plan |
| --- | --- |
| **Behavior** | Before accepting `missing` or `unavailable`, if final snapshot has a same-leg exact-HEAD eligible review (`reviewQualifiesForValid`), **reject** the terminal classification. Valid remains the only legal status when that proof exists. |
| **Owner** | `buildCollectorReceipt` leg loop, both `unavailable` and `missing` branches (currently none). Request path already uses the same predicate — reuse, do not fork. |
| **Red** | Final snapshot contains qualifying review for leg; model outputs `missing` **and** separately `unavailable` → both throw (e.g. `/qualifying\|valid\|exact-head/i`). |
| **Green** | Same fixture with `valid` + qualifying cite succeeds; terminal statuses still work when **no** qualifying final review exists. |
| **Scope** | Receipt only. No Soul. No change to eligibility cutoff law. |

### R2 — Valid ownership / fail-closed cites

| Field | Plan |
| --- | --- |
| **Behavior** | Delete first-match-and-ignore residual. For `valid`: **every** model `evidenceRef` must resolve to a final-snapshot review that `reviewQualifiesForValid` for **this** leg; fail closed on cross-leg, snapshot ids, non-reviews, non-qualifying. Replace leg `evidenceRefs` with **only** those qualifying review proof ids (mirror unavailable’s bind-proof pattern). |
| **Owner** | `buildCollectorReceipt` `status === "valid"` branch (`collector-receipt.ts` ~474–496). |
| **Red** | Two-leg A+B: model cites B’s qualifying review on leg A (alone or mixed with A’s) → reject; A must not retain B’s id. |
| **Green** | Leg A cites only A’s qualifying review → accept; proof refs ⊆ A’s review id(s). |
| **Scope** | Receipt validation/bind only. Do not weaken missing/unavailable cross-leg oracles already present. |

### R3 — Target scope uses establishment HEAD

| Field | Plan |
| --- | --- |
| **Behavior** | Replace `finalSnapshot.evidenceIds.includes(record)` as target-scope proof. Target scope requires `establishedHeadFor(record.evidenceId) === targetHead` (final HEAD). Global scope unchanged (no HEAD coupling). Keep emitting `targetSnapshotHead: targetHead` only after proof passes. |
| **Owner** | `qualifiesUnavailableEvidence` in `collector-receipt.ts` (~258–291). |
| **Red** | Decline comment first observed at H1, **still present** on H2 final snapshot; `unavailableScope: "target"` → reject (must not relabel as H2). |
| **Green** | Same evidence with `global` still accepts; comment first established on final HEAD accepts as target. |
| **Scope** | Replace the existing stale-target test that **clears** the comment on H2 (`global unavailable can cover a new head while target-scoped stale cannot` target half) with the persistent-H1-on-H2 probe. No parallel “stale” flag field. |

### R4 — Receipt closure (delete selective embed)

| Field | Plan |
| --- | --- |
| **Behavior** | **Delete** selective `embedEvidenceIds` / filtered snapshot subset mechanism (~641–688). Embed **all** ledger snapshots and **all** evidence records (invocation is already bounded by 8 MiB/snapshot + 32 MiB/receipt). Keep existing unique-id, namespace non-ambiguity, and `resolveRef` checks; extend resolution so every `snapshot.evidenceIds[]` entry of every **included** snapshot also resolves (transitive closure). |
| **Owner** | Receipt assembly tail in `buildCollectorReceipt`. |
| **Red** | Multi-observe ledger whose included snapshots reference ids not in today’s selective subset → fail or (after fix) assert all six-class unresolved ids cannot occur; assert `∀ snap ∈ receipt.snapshots, ∀ id ∈ snap.evidenceIds: resolves`. |
| **Green** | Dogfood-shaped multi-snapshot receipt: every snapshot evidence id resolves; unrelated non-author rows may now appear (by design of full embed). |
| **Scope** | **Replace** test `receipt embeds referenced subset and omits unrelated non-author records` with closure oracle. Do not keep a second “subset embed” path. |

---

## Owner group B — Evidence / transport (`src/collector-evidence.ts`, `src/collector-github.ts`)

### R5 — Immutable review time on re-observation

| Field | Plan |
| --- | --- |
| **Behavior** | Known `versionId` must not re-project `submittedAt` / `before` after an edited version already stored as `authoritativeTime: null` / `uncertain`. **Primary seam:** after `storeEvidence`, build observe `modelView` from **stored** snapshot records (not mutable `pendingRecords`). **Harden history step:** in `applyEvidenceVersionHistory`, when `!isNewVersion`, copy `authoritativeTime` from the prior stored record for that `versionId`. Do not invent edit clocks. |
| **Owner** | `applyEvidenceVersionHistory` (`collector-evidence.ts`); `observe` modelView assembly (`collector-ledger.ts` ~761–769) — ledger is the projection caller; evidence owns history immutability. |
| **Red** | Observe v1 → edited v2 (null/uncertain) → third observe unchanged v2: modelView (and stored) must stay `authoritativeTime: null`, `windowRelation: "uncertain"` (not back to submitted-time/`before`). |
| **Green** | Existing first-edit uncertainty tests remain green; first version still keeps `submitted_at`. |
| **Scope** | Fix incomplete `c7ee3b5` mechanism; no new uncertainty framework. Preserve `9cc03df` content = `JSON.stringify(modelView)`. |

### R6 — Tombstoned / null authors

| Field | Plan |
| --- | --- |
| **Behavior** | `user: null` on review, issue comment, and review comment **must not throw**. Normalize to unknown/deleted author (`userLogin`/`authorLogin` absent or null), **preserve** the record, and ensure it **cannot** satisfy `expectedAuthors` / `reviewQualifiesForValid` / unavailable author checks (existing `authorLogin` guards already fail closed on undefined — keep that). |
| **Owner** | `userLoginOf` + three normalizers in `collector-github.ts`; evidence normalizers must accept null author without `.toLowerCase()` throw; digest may key tombstone distinctly. |
| **Red** | Each of three surfaces with `user: null` currently throws `GitHub payload missing user.login`; after fix, observe stores record and qualification/nonqualification holds. |
| **Green** | Normal non-null authors unchanged; tombstone never counts as expected author. |
| **Scope** | Transport normalize only + minimal evidence field nullability. No Soul. |

### R7 — Original inline location

| Field | Plan |
| --- | --- |
| **Behavior** | Persist `originalLine` on `CollectorEvidenceRecord` from `GitHubReviewComment.originalLine`. Receipt inline renderer uses `line ?? originalLine ?? "?"` (fixes `src/x.ts:?:` when current line is null). Optionally expose on modelView `line` fallback the same way **or** add `originalLine` to the view — prefer single display fallback to avoid dual fields in prompts unless tests need both. |
| **Owner** | `normalizeReviewCommentEvidence`; `reviewInlineText` in `collector-receipt.ts`; modelView mapping if needed for observe parity. |
| **Red** | Outdated inline `line: null`, `originalLine: 42` → report location `path:42`, not `path:?`. |
| **Green** | Current `line` still preferred when present. |
| **Scope** | Field already parsed in github types — wire through; do not re-parse raw in receipt. |

### R8 — Authenticated-user minimization

| Field | Plan |
| --- | --- |
| **Behavior** | `normalizeAuthenticatedUserEvidence` stores only correlation-needed identity: normalized login + stable numeric/string `id` when present. **`raw` must not be the full `/user` profile** (no email, plan, etc.). Digest already keys login+id — keep. |
| **Owner** | `normalizeAuthenticatedUserEvidence` (`collector-evidence.ts`); transport may still parse full JSON transiently but must not hand the full object into retained evidence. |
| **Red** | `/user` payload with email/extra fields → receipt/ledger `authenticated_user.raw` must not contain them. |
| **Green** | Login + id correlation still works for request-marker authorship. |
| **Scope** | Evidence normalize only; no schema/Soul. |

---

## Owner group C — Observation (`src/collector-ledger.ts`, `src/collector-github.ts`, `src/collector-role.ts`)

### R9 — Complete bracket identity (`updatedAt`)

| Field | Plan |
| --- | --- |
| **Behavior** | Extend `prIdentity` from `state\|headOid` to include evidence-changing PR metadata: at least `updatedAt` (canonical string or empty). Initial≠terminal → one full-surface retry (existing); still unequal → fail closed **before commit** (keep `a817975` posture). No certified snapshot on failure. |
| **Owner** | `prIdentity` + `fetchObserveSurfaces` / `observe` in `collector-ledger.ts` (~429–457, 635–657). |
| **Red** | Stable state/HEAD, `updatedAt` changes across bracket, only two PR reads today → wrongly certifies; after fix must retry; if review only appears on retry, receipt/observe sees it; repeated `updatedAt` churn fails without snapshot. |
| **Green** | Stable full identity (state+HEAD+updatedAt) still single pass (2 PR reads). |
| **Scope** | Complete the incomplete `c7ee3b5` bracket; do not add a third PR-read pattern or separate “metadata poll” tool. |

### R10 — Bounded pagination accumulation

| Field | Plan |
| --- | --- |
| **Behavior** | Enforce existing `COLLECTOR_SNAPSHOT_MAX_BYTES` (8 MiB) **incrementally inside `paginate` append loop** (running byte budget on retained page/item payload) **before** unbounded page retention. Keep **exact** post-normalize `measureNormalizedBytes` check in ledger observe. Fail closed / latch as size failure; do not delete pagination. |
| **Owner** | `paginate` in `createGhCollectorGitHubTransport` (`collector-github.ts`); ledger final measure stays. Import shared constant from `collector-evidence.ts` (single source). |
| **Red** | Multi-page probe that would materialize ≫8 MiB must stop before all pages retained (page counter / items length bound); no 18 MB complete materialization then ledger throw-only. |
| **Green** | Existing MAX accept / MAX+1 final measure tests remain; exact final measurement unchanged. |
| **Scope** | Accumulator seam only; fake transport unit tests for ledger size may stay, but add **real-path** gh-runner pagination budget test in `collector-github.test.ts`. |

### R11 — Observe cancellation

| Field | Plan |
| --- | --- |
| **Behavior** | Thread observe tool’s `AbortSignal` (today `_signal`) through `ledger.observe` → transport GETs → `createGhApiRunner`. On abort: terminate owned `gh` child, **settle once**, remove listeners. Wait already passes `signal` — do not dual-controller. Cancelled observe must not certify a snapshot. |
| **Owner** | `collector-role.ts` observe `execute`; `CollectorLedger.observe` signature; `GhApiRunner` / `createGhApiRunner`; transport `apiGet`/`paginate` options. |
| **Red** | Hung `gh` child + abort ~30 ms via observe tool path: must reject/fail without `latestCompleteSnapshotId`; child not left running. |
| **Green** | Normal observe without abort unchanged; wait cancellation path untouched. |
| **Scope** | One signal plumbing path; no new cancellation subsystem. |

---

## Acceptance tests (packet checklist → placement)

| Root | Test focus | File(s) |
| --- | --- | --- |
| R1 | Terminal precedence for **both** `missing` and `unavailable` when final has qualifying review | `test/collector-receipt.test.ts` |
| R2 | Valid A+A/B rejection; clean A-only valid | `test/collector-receipt.test.ts` |
| R3 | Persistent H1 comment still on H2 → target reject; global ok | `test/collector-receipt.test.ts` (**replace** clear-on-H2 stale test) |
| R4 | All included snapshot `evidenceIds` resolve; **replace** omit-unrelated embed test | `test/collector-receipt.test.ts` |
| R5 | Third observation of unchanged edited review keeps null/uncertain in modelView + store | `test/collector-ledger.test.ts` (+ role content assert if needed) |
| R6 | Null user on review, issue comment, review comment + nonqualification | `test/collector-github.test.ts` + ledger/receipt qualification |
| R7 | Outdated inline `originalLine` fallback in report text | `test/collector-receipt.test.ts` |
| R8 | Sanitized `/user` retained raw | `test/collector-evidence`/`ledger`/`receipt` assert |
| R9 | Stable state/HEAD + changed `updatedAt` forces retry; review on retry visible; no certify on repeated churn | `test/collector-ledger.test.ts` |
| R10 | Multi-page overflow stops before all pages | `test/collector-github.test.ts` (runner mock) |
| R11 | Hung gh canceled through observe tool; no certified snapshot | `test/collector-role.test.ts` or `collector-github.test.ts` + role wiring |

Helpers: extend `test/helpers/fake-github-transport.ts` only as needed (`updatedAt` sequences already via `pullRequestSequence`; tombstone fixtures; no second fake stack).

## Apply-phase construction order (for next phase; not executed now)

1. **Evidence/transport foundations:** R6, R7, R8, R5 history reuse, R10 paginate budget, R11 gh runner signal.
2. **Ledger observation:** R5 modelView-from-stored, R9 `prIdentity`, observe(signal) plumbing, role `_signal` → signal.
3. **Receipt:** R1, R2, R3, R4 (delete selective embed).
4. **Tests:** red/green per table; delete/replace contradictory tests.
5. **Gates:** `npm test`, `npm run typecheck`, `git diff --check`.
6. **Commit:** single forward commit (or minimal coherent forward commits if judge prefers one — default **one** forward commit), title prefix per repo convention e.g. `fix(collector): …`, body lists roots R1–R11 fixed and preserved waits/modelView/drift. No amend.

## Explicit non-goals

- No Soul/README/schema churn for these runtime mechanics.
- No rollback of `ce5d2e4` wholesale; no removal of wait cap / modelView projection / drift fail-closed.
- No parallel “classifier framework” or duplicate `reviewQualifiesForValid`.
- No AC relaxation.

## Plan status

**planned** — all eleven sustained roots have identified Behavior / Owner / Red / Green / Scope; repairs are deletions or completions at existing seams; no unresolved authority decision.
