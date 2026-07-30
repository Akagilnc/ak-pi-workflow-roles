# Fixer plan 2 (revised) — Collector residual defects on `c7ee3b5`

**Phase:** plan only — no repo edits, tests, docs, or Git mutation.  
**Revised artifact:** `/tmp/ak-collector-fixer-plan-2.md`  
**Corrections applied from:** `/tmp/ak-collector-fixer-plan-2-corrections.md`

## What changed vs the prior plan draft

1. **Singular TypeBox schema owner (mandatory)**  
   - New leaf module `src/collector-tool-schemas.ts` owns observe/request/wait/output contracts.  
   - Output legs are a **strict status-discriminated union**: `unavailableScope` required only for `unavailable`, forbidden on `valid`/`missing`; nonblank rationale + array/key bounds in-schema.  
   - Same schemas used for Pi registration, finalized-batch `Value.Check`, and receipt parse/transform.  
   - Sole residual envelope rule: observe must actually carry `{}` (reject `undefined`/`null`).  
   - Explicitly bans parallel key lists, parity-guard dual validators, and fallback shape checkers. Deletes the three-way drift among `collector-role.ts:50-85`, `collector-ledger.ts:182-238`, and `collector-receipt.ts:94-160`.

2. **F1 real-Pi coverage is exact, not “and/or”**  
   - Mechanically inspect schemas registered by the in-process Pi extension.  
   - Isolated sole-invalid output rows: unknown leg field; missing/invalid unavailable scope; scope on valid; scope on missing; blank rationale; empty refs; unknown top-level field.  
   - Sibling rows: valid operational + invalid output.  
   - Controls: well-formed unavailable and missing (schema-allowed).  
   - Each → exit 1 and every GitHub counter zero where required.

3. **No independent request-marker parser**  
   - Join authenticated requester comments to `CollectorRequestAttempt` via exact recorded `attempt.marker` + `attempt.legId`.  
   - Auto-link only the latest relevant same-leg attempt proof.  
   - Explicit allowed same-leg ref classes; reject wrong-leg/non-qualifying model refs for **missing and unavailable**.  
   - Delete unavailable `boundRefs = proof ∪ remaining` decoy preservation.  
   - Full attempts stay at receipt root; leg/terminal-report refs never cross-contaminate.

4. **One decoy per counterexample**  
   - Missing: auto-link contamination case **plus** separate candidate-ref decoys (cross-leg comment, cross-leg snapshot/recovery, dangling id) and a clean success.  
   - Unavailable: separate U1–U5 decoys (cross-leg marker, cross-leg author, after-window, unrelated PR, unrelated snapshot) + clean success.  
   - Assert both leg and matching terminal-report refs every time.

5. **F3 rows are concrete constructions**  
   - Separate timestamp-less **state** vs **text**; separate review **edit** / **dismiss** / **disappearance**; separate duplicate evidenceId / duplicate snapshotId / cross-namespace collision.  
   - Required-tool **absence** and each ambient surface (skills, contextFiles, appendSystemPrompt, commands) via in-process Pi with provider/GitHub counters at zero — no production test hooks.

6. **Exact measured 8/32 MiB boundaries; 32 MiB escape hatch removed**  
   - 8 MiB: calibrate until `measureNormalizedBytes(...) === COLLECTOR_SNAPSHOT_MAX_BYTES` accepts; `=== MAX+1` observe `latchFatal`.  
   - 32 MiB: legal-field pad until `Buffer.byteLength(JSON.stringify(receipt),"utf8")` is exact `MAX` (accept) and `MAX+1`.  
   - max+1 must traverse `ak_collector_output` execute → `buildCollectorReceipt`/`ledger.latchFatal` → role `failInfrastructure` (nonzero, no receipt).  
   - Forbidden: constant-only asserts, observe-growth proxies, builder-only throws without the infrastructure path.

## Apply order (summary)

Red tests → schema owner + wire three consumers → leg-owned attempt join + decoy rejection → concrete F3 + measured boundaries → typecheck, hermetic full suite, focused real-Pi probes, `git diff --check` → one forward `fix(collector):` commit → fresh independent Reviewer over `c5f75b6...<new HEAD>`.

## Success bar

All three Judge probes flip green under the exact seams above; single forward commit; fresh full-range Reviewer receipt required before convergence.
