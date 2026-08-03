# Issue 26 reconciliation closure

- Extraction ref: `docs/research/issue-26-census-extraction.md` (target `96c4ee7`).
- Occurrence total: **7,367**; classes: catch-rejection 226, cause-persistence 3159, continuation-fallback 1624, failure-barrier-dispatch 3118, failure-construction-emission 3043, process-outcome 651, resource-cleanup 185.
- Verdicts: **7,298** conforming recon + **58** conforming residue overrides = **7,356** conforming; **11** documented_exception; **0** violation.

## Occurrence-specific residue adjudication

All 58 itemKeys were read at their current occurrence and recorded in `.ak/work/issues/26/runs/final-zero-b/residue-verdicts.json`, including current line, one-line code quote, matched ruleSet outcome, and resolved-in-commit SHA.

## Documented-exception citations

- `occ-5e82106745f2b18c` — `docs/adr/0016-tests-follow-logic-not-format.md#Tests-follow-logic-not-format` (test/collector-role.test.ts:2627)
- `occ-2b87789eccb42835` — `typed terminal error / cause retained` (src/navigator-attendance.ts:869)
- `occ-3d4e4c4af351a284` — `typed terminal error / cause retained` (src/navigator-attendance.ts:899)
- `occ-7846324d3c4050d0` — `README.md#Doctor` (src/doctor-evidence.ts:18)
- `occ-ea606cda91203bce` — `README.md#Navigator-attendance` (src/navigator-attendance.ts:633)
- `occ-f05673acd21fd062` — `README.md#Navigator-attendance` (src/navigator-attendance.ts:641)
- `occ-a64aa46033c3ccd3` — `README.md#Navigator-attendance` (src/navigator-attendance.ts:661)
- `occ-90c27a6ababf315c` — `README.md#Navigator-attendance` (src/navigator-attendance.ts:664)
- `occ-c5a5d2602f3c15c4` — `README.md#Navigator-attendance` (src/navigator-attendance.ts:677)
- `occ-ee41214cc9534323` — `README.md#Navigator-attendance` (src/navigator-attendance.ts:680)
- `occ-1d0266e957876306` — `README.md#Navigator-attendance` (src/role-runtime.ts:671)

**ZERO-VIOLATION CLOSURE:** all 7,367 reconciled occurrences are conforming or one of the 11 cited documented exceptions; no violations remain.
