# Collector first online-order Fixer packet

## Fixer packet — Collector v1 at `9cc03df314f3014e9cbfa57f3c010a9e1658b8ac`

### Complete inline disposition map

No inline claim is rejected; prior-head relation was used only as provenance. Duplicate claims are grouped as roots R1–R11:

| Reviewed head / inline | Disposition on current HEAD |
|---|---|
| `a817975` receipt:287 target-scoped unavailability | **Sustain → R3** |
| `a817975` receipt:490 valid cross-leg refs | **Sustain → R2** |
| `a817975` receipt:560 missing despite qualifying review | **Sustain → R1** |
| `a817975` evidence:370 repeat observation loses edit uncertainty | **Sustain → R5** |
| `a817975` receipt:654 snapshot IDs not embedded | **Sustain → R4** |
| `6fc54e1` receipt:562 missing despite qualifying review | **Duplicate, sustain → R1** |
| `6fc54e1` github:357 pagination cap too late | **Sustain → R10** |
| `6fc54e1` receipt:490 valid cross-leg refs | **Duplicate, sustain → R2** |
| `6fc54e1` github:165 tombstoned author | **Sustain → R6** |
| `6fc54e1` receipt:149 original location lost | **Sustain → R7** |
| `6fc54e1` role:362 cancellation ignored | **Sustain → R11** |
| `9cc03df` receipt:562 contradictory missing/unavailable | **Duplicate/extension, sustain → R1** |
| `9cc03df` receipt:287 target-scoped unavailability | **Duplicate, sustain → R3** |
| `9cc03df` github:166 tombstoned author | **Duplicate, sustain → R6** |
| `9cc03df` ledger:692 pagination/materialization cap | **Duplicate, sustain → R10** |
| `9cc03df` ledger:429 evidence mutation outside bracket identity | **Sustain → R9** |
| `9cc03df` evidence:202 authenticated profile copied | **Sustain → R8** |

### Repair-surface audit

The range has 11,207 added lines, but history separates it materially: `ce5d2e4` is the 5,882-line initial Collector construction; later commits add about 5,807 lines net over it, overwhelmingly tests. `c7ee3b5` added the principal runtime repair mechanisms; `b43bf20`, `91a1a92`, and `3bec03f` are dominated by schema/test-oracle expansion; `a817975`, `6fc54e1`, and `9cc03df` are narrow repeated-drift, wait-cap, and model-content fixes.

- **Original construction defects still present from `ce5d2e4`: R1–R4, R6–R8, R10–R11.** Historical source confirms the original valid loop stopped at its first match, target scope used final membership, missing had no valid-evidence precedence, receipt intentionally embedded a subset, authenticated raw data was retained, original line was discarded, pagination accumulated without a budget, null users threw, and observe ignored its signal.
- **Repair-introduced/incomplete residuals: R5 and R9.** R5 comes from `c7ee3b5`’s review-version uncertainty mechanism: it handles a newly edited version but not re-observation of that same version; `9cc03df` then exposed the inconsistent pending projection to the provider. R9 is the incomplete `c7ee3b5` final-snapshot bracket: it added initial/terminal PR reads but defined identity as state+HEAD only.
- **No unsupported new mechanism is sustained.** The narrow fixes for repeated state/HEAD drift (`a817975`), five-minute waits (`6fc54e1`), and provider-visible modelView (`9cc03df`) have direct prior failure evidence and should remain. The excessive test growth does not justify another parallel framework. Repair the existing owning seams; simplify/delete the receipt subset mechanism for R4; reuse shared predicates and immutable records rather than adding duplicate classifiers. Nine original defects dominate this packet, so wholesale rollback is not warranted, but no new Soul/schema/transport layer should be introduced without necessity.

### Required repairs at the existing owners

**Receipt owner (`src/collector-receipt.ts`)**

- **R1 terminal precedence:** before accepting `missing` or `unavailable`, scan the final snapshot with `reviewQualifiesForValid`; reject a terminal classification when a same-leg exact-HEAD eligible review exists. Current probe accepted both statuses.
- **R2 valid ownership:** validate every model-supplied valid ref and fail closed on cross-leg/snapshot/nonqualifying refs; retain qualifying same-leg review proof only. Current two-leg probe retained B’s review on A.
- **R3 target scope:** final membership is not HEAD provenance. Require the evidence version’s established HEAD (or an explicit equivalent current-HEAD fact) to equal final HEAD; keep global scope separate. A persistent H1 declaration was accepted and relabeled with `targetSnapshotHead: H2`.
- **R4 closure:** remove/simplify the selective embedding root cause. Every `evidenceId` of every included snapshot must resolve in the receipt. The supplied receipt itself has six unresolved snapshot IDs: `08318e…`, `f3369c…`, `76a844…`, `299144…`, `8ee34b…`, `f85317…`.

**Evidence/transport owner (`src/collector-evidence.ts`, `src/collector-github.ts`)**

- **R5 immutable review time:** for an already-known review version, reuse its stored `authoritativeTime`, or build the model view from snapshot-resolved stored records. Probe v1→edited-v2→unchanged-v2 changed `null/uncertain` back to submitted-time/`before`.
- **R6 tombstones:** normalize `user: null` on reviews and both comment surfaces as unknown/deleted author, preserve the record, and ensure it cannot qualify any expected author. Current code throws `GitHub payload missing user.login`.
- **R7 original location:** preserve `originalLine` and use it when current `line` is null. Probe rendered `originalLine: 42` as `src/x.ts:?:`.
- **R8 authenticated-user minimization:** retain only normalized login and stable ID needed for correlation; do not store `/user`’s full raw profile. The dogfood receipt itself embeds unrelated profile/email fields.

**Observation owner (`src/collector-ledger.ts`, `src/collector-github.ts`, `src/collector-role.ts`)**

- **R9 complete bracket:** include evidence-changing PR metadata such as `updatedAt` in initial/terminal stability and retry full surfaces; repeated instability fails before commit. Probe changed `updatedAt` with stable state/HEAD, used only two PR reads, and certified `missing`.
- **R10 bounded accumulation:** enforce the existing 8 MiB snapshot invariant incrementally at the pagination/append seam, before retaining unbounded raw/normalized pages, while keeping the exact final measurement. A 90-page probe materialized 18,023,023 bytes before any ledger check. Pagination cannot be deleted because complete evidence is required; the accumulator owns this invariant.
- **R11 cancellation:** pass observe’s `AbortSignal` through ledger GETs and the gh runner; terminate the owned child, settle once, and clean listeners. A child aborted after 30 ms ignored cancellation and still returned after process exit. Do not invent a second cancellation controller.

### Acceptance tests

Add focused red/green real-path tests for all roots: terminal precedence for both statuses; valid A+A/B rejection; persistent H1 comment still present on H2; all included snapshot IDs resolving; third observation of unchanged edited review; null users on all three surfaces plus nonqualification; outdated inline fallback; sanitized `/user`; stable state/HEAD with changed `updatedAt` and review appearing on retry; multi-page overflow stopping before all pages; and a hung gh child canceled through the observe tool path with no certified snapshot. Replace the existing tests that intentionally omit unrelated snapshot evidence and that remove the stale target comment. Do not add Soul text for these runtime mechanics. Run `npm test`, `npm run typecheck`, and `git diff --check`.

## Judge note

Current-head verification: clean worktree and exact requested SHA; `npm test` passed 201/201, `npm run typecheck` passed, and `git diff --check` passed. The green suite does not dispose the defects: its cross-leg oracles cover missing/unavailable but not valid, stale-target removes the persistent comment, edit tests stop before the unchanged third observation, and receipt tests check direct leg/report refs rather than snapshot transitive closure. Direct leg/report refs in the dogfood receipt resolve and final snapshot HEAD matches current HEAD, but snapshot closure does not.
