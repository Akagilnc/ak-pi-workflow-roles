# Plan-Gate: R10 cross-surface snapshot budget residual

**HEAD:** `c86c2a2` (clean). Prior R10 in that commit added **per-`paginate()` raw `bodyText` `retainedBytes`**, which resets on every surface and does not match the owning 8 MiB invariant (`measureNormalizedBytes` on the full normalized snapshot). Production-shaped probe (≈2.2 MiB body × reviews / issue-comments / review-comments) keeps every page under the local cap, fetches all three surfaces + terminal PR, then fails only at ledger commit: `Collector snapshot exceeded 8388608 UTF-8 bytes (13202455)`.

Do **not** revive raw-body or per-surface caps (same failed method family as c86c2a2 R10).

---

## Behavior

One **observation-scoped** incremental retain budget over the **same normalized evidence-record shape** used by the final snapshot measure (`normalize*Evidence` → `measureNormalizedBytes` / `JSON.stringify(records)` UTF-8).

- Budget is created once per `fetchObserveSurfaces` attempt (reset on PR-identity retry).
- Charge **before** retaining page items: user + PR-shaped record + each paginated page’s normalized rows, shared across reviews → issue-comments → review-comments.
- On exceed: throw size failure immediately; **do not** append that page, **do not** fetch further pages/surfaces/terminal PR, **do not** commit a snapshot (`latchFatal` path as today).
- **Remove** `paginate()`’s per-call raw `retainedBytes` approximation (and its sole use of `COLLECTOR_SNAPSHOT_MAX_BYTES` if unused).
- **Keep** Link pagination and the **exact final** `applyEvidenceVersionHistory` → `assignWindowRelations` → `measureNormalizedBytes` gate before store/commit (defense in depth; incremental gate uses the same record builders + byte function, without requiring window/history byte-identity).

## Owner

| Piece | Owner |
| --- | --- |
| 8 MiB snapshot invariant + observation budget lifecycle | `src/collector-ledger.ts` (`fetchObserveSurfaces` / `observe`) |
| Page retain hook (call budget **before** `items.push` / next page) | `src/collector-github.ts` `paginate` + list* inputs |
| Byte function + normalizers (unchanged truth) | `src/collector-evidence.ts` (`measureNormalizedBytes`, `normalize*Evidence`) |
| Fake transport parity (honor per-page/`retainPage` so ledger path is testable without gh) | `test/helpers/fake-github-transport.ts` |
| Cross-surface real-path oracle | `test/collector-ledger.test.ts` and/or `test/collector-github.test.ts` |
| Existing single-surface multi-page R10 test | Retarget to normalized observation budget (ledger path or explicit retain hook); drop raw-payload assertion wording |

Minimal seam: optional `retainPage?: (items: T[]) => void` (or shared budget callback) on list* / `paginate`. Ledger closure normalizes page items with `observedAt` and `budget.retain(...)`. No parallel classifier, no AC relaxation, no Soul/schema churn.

## Red

Current (and must stay red until fixed):

1. **Cross-surface:** each surface’s raw/local size &lt; 8 MiB; cumulative normalized snapshot &gt; 8 MiB → today all three list* + terminal PR run; failure only post-fetch at commit measure; snapshot not committed but work/network already done.
2. **c86c2a2 transport-only R10** only proves **intra-surface** raw accumulation — misses the residual class.

## Green

1. **Real-path cross-surface test** (`createGhCollectorGitHubTransport` runner + `ledger.observe`):
   - ~body size chosen so **each** of reviews / issue-comments / review-comments alone normalizes &lt; 8 MiB, but **cumulative** normalized materialization &gt; 8 MiB (mirror probe scale, e.g. ~2.2 MiB bodies).
   - Assert observe rejects with snapshot/budget size error (`/snapshot exceeded|UTF-8 bytes|8/i` or structured size flag).
   - Assert **later** surface and/or **terminal PR** fetches **do not run** (call counters / path taps).
   - Assert **no** complete snapshot committed (`getSnapshots()` empty / no latest complete; `fatal` as today).
2. **Intra-surface multi-page:** still stops before retaining the page that would cross the **shared normalized** budget (update existing R10 test; no raw `retainedBytes` dependency).
3. **Regression:** existing MAX / MAX+1 snapshot boundary test and non-size observe paths stay green.
4. Run declared collector tests (at least `collector-ledger`, `collector-github`, related typecheck).

## Scope

**In**

- `src/collector-ledger.ts` — observation-scoped budget in surface fetch; wire normalizers at retain time; keep final measure.
- `src/collector-github.ts` — delete per-surface raw cap; page-level retain hook only.
- `test/helpers/fake-github-transport.ts` — invoke retain hook per page/flat list.
- Tests above; small helper only if it avoids duplicating budget arithmetic (optional `createSnapshotByteBudget` next to `measureNormalizedBytes`).

**Out**

- Receipt 32 MiB materialization bound; Soul/schema/README; changing `COLLECTOR_SNAPSHOT_MAX_BYTES`; weakening final measure; amend/rewrite history; unrelated R1–R9/R11 behavior.

**Apply notes (for next phase only):** forward commit; body cites cross-surface normalized budget root and that raw per-surface approximation was removed; no empty commit if facts diverge.
