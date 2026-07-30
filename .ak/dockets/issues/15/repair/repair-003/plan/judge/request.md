# Judge repair-003 Plan readiness

Judge in Plan posture. Read:

- `.ak/dockets/issues/15/repair/repair-003/packet.md`
- `.ak/dockets/issues/15/repair/repair-003/plan/receipt.json`
- `.ak/dockets/issues/15/repair/repair-003/plan/manual-reconciliation.md`
- `.ak/dockets/issues/15/review/final-fixed-target/judge/receipt.json`
- `.ak/dockets/issues/15/repair/repair-002/recorder-closure/manifest.json`
- `.ak/dockets/issues/15/migration/legacy-case-a/dispositions.json`
- `.ak/dockets/issues/15/migration/legacy-case-a/recovered-index.json`
- `test/legacy-case-a-migration-verifier.test.ts`

Decide whether the Plan is construction-ready for exact R1-R4. Require Behavior, deepest Owner, meaningful Red, Green, and bounded Scope for every key. Table headings are not a conformance condition; reconcile only exact keys once each and nonblank dispositions.

Freshness checks are permitted only against Git/tree/stat/JSON/SHA, current `/tmp` names/lstat, and the 277 admitted non-generic source bytes needed by this repair. Do not inspect generic JSONL/session/tool-event payloads or `.ak/work` other than this request. If any required historical/external identity is now missing or changed, do not converge.

Pay particular attention to whether:

1. R1 defines an actual sealed cutoff/identity classification rather than renaming the hard-coded basename allowlist;
2. R2 has deterministic, bounded recognition rules for issue/PR/commit associations across admitted Markdown/text, nested JSON, recovered bytes, and Git references without treating arbitrary prose/hex as associations or reading excluded generic payloads;
3. R2’s red mutation changes an actual parsed input/metadata field and passes through the same comparator;
4. R3 can attribute every execution input, including exact scanner bytes and 277 external source seals, without retaining raw source duplicates;
5. one append-only Recorder successor and the existing verifier own all new machinery;
6. all immutable migration/repair evidence remains unchanged.

Return `converged` only if Apply can proceed without inventing an owner decision. Otherwise return the smallest Plan correction, not implementation proof. Submit only through `ak_judge_output`.
