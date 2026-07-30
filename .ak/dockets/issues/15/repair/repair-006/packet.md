# Issue 15 Case-A repair-006 — immutable execution inputs

Authority and construction-ready repair: `.ak/dockets/issues/15/review/final-closure-002/judge/receipt.json`.

R1: In the existing repair-003 child/evidence seam, capture one full execution commit and load dispositions from that commit. Derive the complete required path set from those immutable bytes. Before any live byte affects selection or scanning, either use Git bytes directly or compare the exact used byte to its full resolved tuple and reject drift. Require immutable tuple resolution and exact-byte agreement for dispositions, every admitted reference, redaction report, and recovered derivative; compare generated scan output to immutable derivative/report bytes. Dirty disposition/report/derivative counterexamples must fail before affecting evidence.

R2: Remove fail-open worktree fallbacks and omission catches from required-universe construction. Any required tuple-resolution failure must exit nonzero naming the exact path, never shrink the denominator. In the sole existing verifier, derive dispositions from the child’s `executionHead` Git bytes, resolve every required path without catches, and compare that fail-closed universe exactly with the ledger. Add same-seam counterexamples proving one committed deletion/unresolvable required path fails rather than reducing the required set.

R3: Rerun only the existing child and reseal its existing result/manifest at a new forward target. Require typecheck and focused verifier green; 597/0/0, 277 scans, two redactions, all immutable source/derivative/report matches, complete tuple universe including seven references, 277 external seals, and manifest/result/required counts equal. Do not alter or rerun migration association/output files.

Exact reconciliation: `{R1,R2,R3}`, each once, nonblank disposition; headings/status wording irrelevant. The accepted Review Judge already fixed Behavior, Owner, Red, Green, and Scope, so no additional Plan invocation is required.

Preserve history and all earlier evidence commits. Existing child and sole verifier only; no new helper/verifier/successor mechanism, generic payload inspection/retention, raw-source copies, Case B/#16/#17, Soul/runtime/schema changes, amend, rewrite, or unrelated migration work. Refuse if source identity drift makes bounded repair impossible.
