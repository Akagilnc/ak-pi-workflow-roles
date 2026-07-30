# Issue 15 Case-A final Review adjudication

Judge in Review posture. Decide whether the Case-A legacy migration can close or requires one further bounded forward repair.

## Fixed identities

- Baseline/default before migration: `10365aaa54d6c64a59c8aacc0304d32010d03b20`
- Original migration target: `ea64733e382c6dcf14906b3b52782ec3f1c07535`
- First repair target: `702e36f97caa92f012470bf5a890e656a5859800`
- Final repair target under review: `da250445d09ef2b9105a99590f2ccda0a8db29c4`
- Reviewed range: `702e36f97caa92f012470bf5a890e656a5859800..da250445d09ef2b9105a99590f2ccda0a8db29c4`
- Current archival HEAD contains only later closure evidence and does not redefine the target.

## Governing material

Read these exact repository artifacts:

1. `.ak/dockets/issues/15/authority/judge-004/task.md`
2. `.ak/dockets/issues/15/authority/judge-004/receipt.json`
3. `.ak/dockets/issues/15/repair/repair-002/packet.md`
4. `.ak/dockets/issues/15/repair/repair-002/plan/receipt.json`
5. `.ak/dockets/issues/15/repair/repair-002/plan/judge/receipt.json`
6. `.ak/dockets/issues/15/repair/repair-002/apply/receipt.json`
7. `.ak/dockets/issues/15/repair/repair-002/historical-nonconformance.json`
8. `.ak/dockets/issues/15/repair/repair-002/recorder-closure/manifest.json`
9. `.ak/dockets/issues/15/repair/repair-002/recorder-closure/exhibits/corroboration-scan-implementation`
10. `.ak/dockets/issues/15/review/final-fixed-target/task.md`
11. `.ak/dockets/issues/15/review/final-fixed-target/result/receipt.json`
12. `.ak/dockets/issues/15/review/final-fixed-target/result/manifest.json`
13. `.ak/dockets/issues/15/repair/repair-002/plan-attempt-001/owner-disposition.md`
14. `CLAUDE.md`
15. `test/legacy-case-a-migration-verifier.test.ts`

Do not inspect `.ak/work`, excluded payloads, or generic JSONL/session/tool-event content. Case B, issue #16, and issue #17 remain out of scope.

## Findings requiring separate adjudication

Preserve Standards and Spec dispositions separately. The accepted Reviewer Receipt reports:

### Standards

S1. Hard Probe-lifecycle violation: the independently executable Recorder exhibit remains while related behavior also exists in the regression verifier.

S2. Judgement-call Duplicated Code between that exhibit and verifier.

Relevant counterfact to evaluate, not assume: repair-002 R1 expressly required preservation of the exact independently executable corroboration implementation and result as durable Recorder evidence. Determine whether that evidence purpose is still live, and whether sharing/removing its implementation would defeat independent historical corroboration. Do not treat a value-bearing exhibit as routine scratch merely because it is executable.

### Spec

P1. R1 post-cutoff oracle allegedly hard-codes `{coder.ts}` instead of deriving classification from the sealed cutoff rule, so a pre-cutoff omission with that basename could pass.

P2. R2 historical execution allegedly fails to byte-identify the dynamically imported `dist/recorder/scanner.js`; its Recorder manifest has `package:null` and `verification:"unverified"`. Also determine whether selection from current disposition labels is adequately fixed to immutable inputs.

P3. R3 association oracle allegedly is not exhaustive over admitted non-generic bytes and its second-item red mutation only mutates a temporary expected map. The Reviewer gives nested-JSON examples absent from association metadata. Determine the actual Authority/repair burden: all associations derivable from admitted non-generic bytes versus only a narrower owner-defined set. If the broad burden governs, decide whether the current extractor and mutation can prove it.

P4. Recorder successor allegedly omits reproducible identities for claim inputs including discovery spec/walk/inventory, dispositions/reports, scanner dependency, and source metadata. Decide against Amendment 006’s actual input/exhibit identity requirement, distinguishing bytes already Git-resolvable from genuinely external source identities. Do not require raw source-byte retention if sealed identities suffice.

## Current positive evidence

The Reviewer independently confirmed: fixed 597 matched/0 missing/0 changed; all 277 source hashes, generated derivative hashes, and complete hit reports matched including both redactions; joins/counts reconcile; all five roles and issues #1–#3 are represented; seven probe/snippet copies are absent live with immutable references; both commit-message recoveries are sealed; historical nonconformance identities verify with no later mutation; no generic JSONL/session/tool-event path exists; no wrongly excluded value-bearing candidate was established. Focused verifier passed 17/17 and typecheck passed in the parent environment.

The Owner’s later R-ledger ruling is binding only on reconciliation format: exact key set, each key once, nonblank disposition, headers ignored, no historical rewrite. It does not adjudicate P1–P4.

## Required verdict shape

- Adjudicate S1, S2, and P1–P4 individually from current evidence.
- If every closure-affecting finding is rejected or already proved, return `converged` with the bounded closure basis.
- If any finding is sustained, return `continue` with the smallest exact stable repair set, explicit acceptance evidence, preserved historical identities, and no Case B/#16/#17/history rewrite/session retention/generic payload/parallel verifier.
- Escalate only if source volatility or an Owner-only contradiction makes bounded repair impossible.
