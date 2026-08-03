# Issue 26 reconciliation closure

- Target HEAD: `370818f`
- Extraction method: `docs/research/issue-26-census-extraction.md`
- Extracted occurrences: **7,367** (deduplicated tracked UTF-8 line occurrences).

## Extraction counts

- `catch-rejection`: 226
- `cause-persistence`: 3159
- `continuation-fallback`: 1624
- `failure-barrier-dispatch`: 3118
- `failure-construction-emission`: 3043
- `process-outcome`: 651
- `resource-cleanup`: 185

## Verdict counts

- `conforming`: **7,356**
- `documented_exception`: **11**
- `violation`: **0**

## Residue verification

The 58 occurrences listed in `.ak/work/issues/26/runs/final-zero/residue-58.json` were re-read at CURRENT HEAD. All are resolved; the per-item ledger records the exact repair commit. No residue was repaired in this closing leg.

**ZERO-VIOLATION CLOSURE:** every one of the 7,367 reconciled occurrences is conforming or a cited documented exception.

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
