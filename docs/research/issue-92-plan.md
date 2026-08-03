# Issue 92 — r3 two-station campaign plan

## Authority and baseline

This plan implements the r3 amendment on issue #92 (2026-08-04): separate
pure logic, role contracts, Pi integration, and package lifecycle tests. The
durable ledger is [`issue-92-test-sweep-ledger.json`](./issue-92-test-sweep-ledger.json).
Its frozen population is 398 timed subtests, Σ765.9s individual time, and
293.7s wall time from the recorded timing run. The ledger, not this prose,
is the machine-readable work list.

## Station 1 — layering first

1. Add `test:fast`, `test:integration`, and `test:all` npm scripts.
2. Move the 46 files according to the ledger's mechanical `tierAssignments`:
   19 unit, 18 contract, 4 integration, and 5 package files.
3. The command composition is cumulative and normative: `test:fast` runs unit +
   contract tiers; `test:integration` runs `test:fast` plus the integration tiers
   (the cumulative pre-submit boundary); and `test:all` runs everything,
   including package lifecycle tiers, as the CI gate.
4. Delete the 16 frozen 盯文/Soul-wording dispositions while doing the moves.
   This is not a performance exemption: the ledger records that no runtime
   reject depends on them.
5. Verify suite membership by paths/configuration, not by test display text.

The regular development loop is `test:fast`; `test:integration` is the
cumulative pre-submit boundary; `test:all` is the CI gate. Coverage semantics
are not reduced: the tier changes only when a test runs, and every retained
contract remains represented in its assigned tier.

## Station 2 — rebuild and merge

1. Apply the 113 rebuild dispositions and no merge dispositions in the
   ledger; the remaining former merge rows are explicit rebuilds where their
   old oracle did not cover the absorbed contract.
2. For every merge, use its machine-checkable `mergeInto` target or shared
   oracle key; do not infer a target from prose.
3. Rebuild expensive package fixtures around one shared cold-install/pack
   fixture or an equivalent CI prebuilt artifact. The fixture-design ruling
   permits either architecture; choose one during implementation and measure
   it on the construction HEAD.
4. Rebuild integration tests at the smallest real Pi/process seam required by
   their contract. Preserve every gate-negative assertion.
5. Ensure the five ledger facts are carried into the implementation review:
   behavior, owning seam, pre-fix red counterexample, post-fix green result,
   and unchanged scope. The ledger marks absent red/green runs as evidence
   gaps rather than inventing outcomes.

## Acceptance

- A measured regular run of `test:fast` on the construction HEAD has wall time
  at most 100 seconds (the governing red line).
- Contract survival is demonstrated for all retained rebuild/merge contracts.
- Gate-negative preservation is demonstrated for every protected negative case.
- `test:integration` and `test:all` both run their declared tiers, and the
  full gate retains coverage rather than deleting tests outside the frozen
  16-entry delete list.
- The measured result and any remaining evidence gaps are recorded before
  closing the issue-92 campaign; ADR-0050 governs the honest unfinished
  terminal and is not closed by this campaign. If construction is not complete,
  leave it explicitly unfinished with a named remainder.
