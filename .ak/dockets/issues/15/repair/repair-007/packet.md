# Issue 15 Case-A repair-007 — child-seam red proof

Authority and construction-ready test-only repair: `.ak/dockets/issues/15/review/final-closure-003/judge/receipt.json`.

R1: Replace the synthetic dirty-byte assertions in the sole `test/legacy-case-a-migration-verifier.test.ts` with a table-driven execution of the existing repair-003 child. In an automatically cleaned isolated temporary clone/worktree of current HEAD, derive the disposition file plus one admitted report and one recovered derivative path from committed disposition bytes; dirty each live file separately while HEAD remains fixed; invoke the existing child with temporary root/output environment; assert nonzero exit, exact expected drift gate, and exact path. Reset between cases and clean the fixture in `finally`.

R2: In the same temporary fixture, select one required report or derivative from committed dispositions, commit its deletion while leaving the disposition reference intact, invoke the existing child, and assert nonzero `required-tuple-unresolvable` output naming the exact disposition-derived path and temporary commit. This must exercise the child required-universe path, not verifier-local tuple resolution.

R3: Remove the duplicated ineffective assertions while making R1/R2. Run typecheck and focused verifier. Test-only change: do not alter/reseal child, result, manifest, migration outputs, or durable evidence.

Exact reconciliation `{R1,R2,R3}`, each once, nonblank. Headings/status wording irrelevant. The accepted Review Judge fixed Behavior/Owner/Red/Green/Scope; no Plan reinvocation required. No production hook, helper module, successor mechanism, generic payload read, durable fixture/probe, Case B/#16/#17, amend, rewrite, or unrelated change.
