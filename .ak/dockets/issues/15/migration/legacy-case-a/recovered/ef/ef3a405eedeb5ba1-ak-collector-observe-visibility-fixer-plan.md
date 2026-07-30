# Plan-Gate: Collector observe model-visibility

## Behavior
`ak_collector_observe` must put the single bounded `modelView` (from `ledger.observe`) into provider-visible tool-result **text content** as `JSON.stringify(modelView)`, and keep that **same object** in `details` unchanged. The model must be able to read `snapshotId`, review/comment `evidenceId`, author, state, body, and `commitOid` from `content` alone. Request refusal, filtering, bounds, ledger/receipt/schema/Soul stay as-is.

## Owner
`src/collector-role.ts` observe `execute` return only (presentation seam). Regression coverage in `test/collector-role.test.ts`. No ledger/receipt/schema/Soul/tool changes.

## Red (current at `6fc54e1`)
```ts
// src/collector-role.ts ~378-383
content: [{ type: "text", text: `Observed snapshot ${snapshot.snapshotId} at ${snapshot.headOid} (${snapshot.prState})` }],
details: modelView,
```
- Provider conversion (`convertResponsesMessages`) emits **only** `content`; `details` is host-only.
- Existing lifecycle tests read `prior?.details?.evidence` / `toolResultDetails(...)`, so they green-pass a model-invisible projection.
- Consequence: model sees summary only → issues `ak_collector_request` → runtime correctly refuses exact-head qualifying review / authenticated marker (refusal is not the bug).

## Green
1. **Production (one line-family change)** in observe `execute`:
   - `content: [{ type: "text", text: JSON.stringify(modelView) }]`
   - `details: modelView` (same reference; no second projection, no truncation, no raw GitHub JSON).
2. **Regression tests** (real-Pi lifecycle via existing harness/faux provider): parse decision data **only** from `toolResult.content` text (`JSON.parse` of joined text parts). Never use `details` for operational decisions in these new tests.
   - **Exact-head qualifying review**: content exposes `snapshotId`, review `evidenceId`, configured author, accepted review state, exact `commitOid`; use content-derived ID to submit `valid`; assert accepted output and `transport.calls.create === 0`.
   - **Authenticated same-head request-marker / pending**: seed issue comment with exact marker from `buildCollectorRequestMarker` + manifest digest/leg/HEAD; assert content exposes marker body/author/evidenceId plus snapshotId/HEAD; next op is `wait` (not `request`); finish cutoff → final observe → `missing`; assert zero comment creation.
   - **One-projection identity**: at least one test asserts `JSON.parse(contentText)` deep-equals JSON-normalized existing `details` view, and excludes unrelated-author/raw evidence (configured-author + authenticated-marker filter only).
3. **Gates** (apply phase): one forward commit; `npm run typecheck`; `HOME=$(mktemp -d) npm test`; `npm pack --dry-run`; `git diff --check`; clean worktree.

## Scope

| In | Out |
| --- | --- |
| Observe tool return `content` text = `JSON.stringify(modelView)` | New evidence source / parallel modelView builder |
| Keep same `details: modelView` | Soften/change request refusal or wait/output laws |
| New content-only lifecycle regressions | Expose raw GitHub JSON; classify valid/pending/missing in runtime |
| Preserve author/marker filter + 8 MiB snapshot / 32 MiB materialization fail-closed | Truncation; new tools; ledger/receipt/schema/Soul edits |
| Existing details/receipt/request/pagination/size/narrowing/singleton/package contracts stay green | Amend history; drive-by refactors; rewriting old tests beyond necessity |

## Non-goals / invariants
- Do not teach the model via a second payload shape; one `modelView`, two transports (`content` + `details`).
- Do not “fix” refusal by letting request succeed when evidence already qualifies—visibility is the fix.
- Existing tests that still read `details` for host/receipt paths may remain; new authority coverage must not.

## Apply sketch (for later phase only)
1. Edit observe return in `src/collector-role.ts` as above.
2. Add content-parse helper + 2–3 lifecycle tests in `test/collector-role.test.ts` (reuse `writeLegs`, fake transport samples, `buildCollectorRequestMarker`/`loadCollectorManifest` for exact marker).
3. Run authority gates; single forward commit; report SHA.
