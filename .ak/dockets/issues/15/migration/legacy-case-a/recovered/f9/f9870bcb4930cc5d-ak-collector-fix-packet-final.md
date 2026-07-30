# Final Collector repair packet

Repair one sustained defect only on a forward commit from `3bec03f84b1bee6a5f7d7c7068028b3c2849116f`.

1. In `src/collector-ledger.ts` at the owning observe bracket (`fetchObserveSurfaces` / `prIdentity`), retain the existing single full retry after first-pass drift, but compare the retry's `prInitial` and `prTerminal` identities too. If they still differ, throw/latch Collector fatal before normalization, evidence storage, marker recovery, or snapshot commit. Do not certify either pass as complete and do not add another retry mechanism.
2. Add a focused regression in `test/collector-ledger.test.ts` using the real ledger seam and pull sequence `OPEN/A → OPEN/B`, then `OPEN/C → OPEN/D`, with evidence exposed during the second surface fetch. Assert four PR reads, observe rejection/fatal state, zero committed snapshots/evidence, no latest complete snapshot, and therefore no receipt. Preserve the existing control proving `A→B`, then `B→B` succeeds and binds `B`.
3. Do not change the manifest schema, manifest semantic validation, Soul, README, CLI, receipt shape, limits, or other role contracts. Rerun typecheck, empty-HOME full suite, pack dry-run, and diff-check.
