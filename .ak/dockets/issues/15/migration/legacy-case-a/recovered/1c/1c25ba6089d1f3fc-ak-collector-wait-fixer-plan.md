# Plan-Gate: Collector wait cadence (5-minute single-wait cap)

**HEAD:** `a817975`  
**Authority:** v2 §6 (wait capping owned by `ak_collector_wait` runtime), §9 (boundary cadence), §13 (timer mechanics out of Soul). No addendum required.  
**Defect sustained:** On dogfood PR4, a valid `900_000` ms wait was truncated only to remaining `~762_388` ms, blocking re-observation for ~12m42s. Existing tests only prove remaining-deadline capping, so green does not close this gap.

## Behavior

- A single `ak_collector_wait` may sleep at most **five minutes** (`300_000` ms), even when the public request and remaining eligibility are larger.
- Effective duration becomes `Math.min(requestedMs, remainingMs, 300_000)`.
- Public schema maximum stays `900_000`; requested value is still recorded as submitted.
- When remaining eligibility is **below** five minutes, remaining still wins (existing near-cutoff law unchanged).
- Post-cutoff rejection, abort, ledger fields, cutoff flags, and all non-wait mechanics stay unchanged.
- Method/tool wait wording must truthfully mention both the five-minute runtime cap and the remaining-eligibility cap.

## Owner

| Concern | Owner seam |
| --- | --- |
| Single-wait duration cap | `src/collector-ledger.ts` → `createCollectorLedger().wait()` effective-duration calculation |
| Truthful wait wording only | `src/collector-role.ts` method line + tool description/guidelines |
| Behavioral proof | `test/collector-ledger.test.ts` through real `wait()` (no mock/duplicated cap helper) |

No scheduler, watcher, polling loop, Runner change, schema/Soul/README change, or parallel timer mechanism.

## Red

Add failing tests first on the real ledger seam:

1. **Five-minute single-wait cap (ample remaining)**  
   - Activate with ~15 minutes remaining.  
   - `wait({ durationMs: 900_000 })` → `requestedMs: 900_000`, `effectiveMs: 300_000` exactly, `remainingMsAfter: 600_000`, `cutoffReached: false`.  
   - Ledger wait record mirrors those fields.  
   - Control: a shorter request (e.g. `120_000`) is unchanged (`effectiveMs: 120_000`).

2. **PR4 shape + re-observe before deadline**  
   - Advance so remaining ≈ `762_388` ms.  
   - Request `900_000` → exact `effectiveMs: 300_000` (not ~762k).  
   - Then call real `ledger.observe(...)` with fake GitHub transport; assert observation completes with `completedMono < deadlineMono` (re-observation still possible inside the window).

3. **Retain existing coverage**  
   - Near-cutoff: remaining `< 300_000` still wins (`effectiveMs === remaining`).  
   - Post-cutoff wait still rejected.

**Current baseline that makes these red:**  
`src/collector-ledger.ts` L946: `const effectiveMs = Math.min(input.durationMs, remaining);` — no `300_000` term.  
Role L121/L429–L432 mention only remaining-eligibility capping.

## Green

Minimal apply (plan phase does not edit):

1. **`src/collector-ledger.ts`**  
   - Add one private constant at the wait seam, e.g. `const COLLECTOR_SINGLE_WAIT_MAX_MS = 300_000`.  
   - Change only:  
     `effectiveMs = Math.min(input.durationMs, remaining, COLLECTOR_SINGLE_WAIT_MAX_MS)`.  
   - Do not export the constant; do not touch schema max, cutoff law, records shape, or abort path.

2. **`src/collector-role.ts`**  
   - Update existing wait method line + tool description/`promptGuidelines` so they state the five-minute runtime cap **and** remaining-eligibility cap.  
   - No kickoff, schema, README, or other method-law edits.

3. **`test/collector-ledger.test.ts`**  
   - Implement the red cases above; keep the existing near-cutoff/post-cutoff test (extend in place or adjacent, without weakening assertions).

4. **Verify on new forward commit**  
   - `npm run typecheck`  
   - `HOME=$(mktemp -d) npm test`  
   - `npm pack --dry-run`  
   - `git diff --check`  
   - Commit is strict forward descendant of `a817975` (no amend).

## Scope

**In**
- Private 5-minute cap inside ledger `wait()` effective-duration math only  
- Truthful wait wording in collector role tool/method text  
- Red→green tests on real `wait()` / `observe()` seam  

**Out**
- Public tool schema `maximum` / `COLLECTOR_ELIGIBILITY_MS`  
- Soul, README, ADR, Runner, scheduler/polling/watcher  
- Any second timer mechanism or “helpful” cadence policy beyond `Math.min(..., 300_000)`  
- Relaxing assertions or deleting post-cutoff coverage  

## Risk / non-goals

- Cap is runtime-owned narrowing of an existing seam; schema may still accept up to 15m requests (recorded in `requestedMs`, truncated in `effectiveMs`) — intentional per packet.  
- Do not “fix” long waits by inventing auto-reobserve; model must call observe again after each capped wait.  
- Prior history shows wait has only ever had remaining-deadline capping; this is not a repeat of a failed same-family patch on HEAD.

## Apply checklist (for next phase only)

1. Confirm HEAD still `a817975` (or packet-equivalent) and no divergent wait edits.  
2. Land constant + `Math.min` one-liner.  
3. Align role wait wording.  
4. Add/adjust tests; run full verification suite above.  
5. One forward commit; report `commitSha` + evidence.
