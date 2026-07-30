# Issue 15 Case-A repair-005 — manifest/result count consistency

Authority and construction-ready repair: `.ak/dockets/issues/15/repair/repair-004/apply/judge/receipt.json`.

R1: At one new forward target, update `.ak/dockets/issues/15/repair/repair-003/recorder-closure/manifest.json` field `identityLedger.gitTupleCount` from its stale value to the sealed result’s mechanically derived unique Git tuple count. Extend only the existing `test/legacy-case-a-migration-verifier.test.ts` to assert manifest count equals result Git tuple count and independently required unique tuple-key count. Run `npm run typecheck` and the focused verifier. Do not rerun or alter the child, result, association/migration outputs, prior commits, or any other evidence unless this consistency-only operation proves the stated fixed inputs contradictory; if contradictory, return evidence-bearing refusal.

Reconciliation: exact key set `{R1}`, once, with a nonblank disposition. Header and status wording are not conformance requirements.

No Plan reinvocation is required: the accepted Apply-posture Judge fixed Behavior (remove the contradiction), Owner (repair-003 manifest plus sole verifier), Red (stale 553 versus sealed 561 passes today), Green (three mechanically equal counts and focused gates), and Scope (consistency-only forward edit). No Case B/#16/#17, generic payload, history rewrite, parallel mechanism, or unrelated change.
