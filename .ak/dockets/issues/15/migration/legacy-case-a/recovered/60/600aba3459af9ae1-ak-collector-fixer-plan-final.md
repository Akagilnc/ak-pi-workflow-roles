# Plan-Gate: repeated observe-bracket drift after single retry

**Base HEAD:** `3bec03f84b1bee6a5f7d7c7068028b3c2849116f`  
**Phase:** plan only — no code, test, doc, or Git changes.

## Behavior

In `observe`, keep exactly one full-surface retry when first-pass `prInitial` ≠ `prTerminal` (`prIdentity` = `state|headOid`).

After that retry, **also** compare retry `prInitial` vs `prTerminal`. If they still differ:

- throw/latch Collector fatal (via the existing observe `try/catch` → `latchFatal("Collector observe failed: …")` path is fine);
- do it **before** normalization, evidence `store`, marker recovery, snapshot push, `latestCompleteSnapshotId` bind, or model-view return;
- do **not** certify either pass as complete;
- do **not** add a second retry or any parallel retry mechanism.

Stable first pass, or first-pass drift then stable retry (existing `A→B` then `B→B`), still binds **terminal** identity only.

## Owner

| Item | Location |
| --- | --- |
| Owning seam | `src/collector-ledger.ts` — `fetchObserveSurfaces` / `prIdentity` inside `observe` (~L429–656) |
| Current gap | After first-pass drift, retry result is accepted without re-comparing identities; code falls through to normalize/store/commit using `prTerminal` |
| Regression | `test/collector-ledger.test.ts` next to existing control `"terminal PR reread binds terminal HEAD and retries on drift"` |
| Out of scope | manifest schema/validation, Soul, README, CLI, receipt shape, limits, other role contracts |

**History note:** `c7ee3b5` introduced “terminal PR reread with one retry”; no later commit closed repeated-drift fail-closed. Do not re-ship “retry once and bind terminal” variants without the second-bracket identity check.

## Red

Focused ledger-seam test (real `createCollectorLedger` + `createFakeGitHubTransport`):

1. **Repeated drift (new):** `pullRequestSequence`  
   `OPEN/A → OPEN/B` (first bracket drifts), then `OPEN/C → OPEN/D` (retry still drifts).  
   Expose non-empty list evidence (e.g. review and/or issue comment) so a wrong commit path would store it.  
   Assert:
   - `transport.calls.pull === 4` (exactly one retry, two PR reads per pass);
   - `observe` rejects; `ledger.fatal === true` (and reason mentions observe failure / drift as implemented);
   - `ledger.allEvidence().length === 0`;
   - no committed snapshots / `latestCompleteSnapshotId === undefined`;
   - therefore receipt materialization cannot bind a complete final snapshot (no receipt).

2. **Control (preserve):** existing `A→B`, then `B→B` still succeeds, four pulls, binds `head-b` on snapshot and PR evidence.

## Green

Minimal production edit only in the observe bracket:

```text
fetch → if drift → fetch once more → if still drift → throw (latch via existing catch)
                                      else bind retry terminal
```

No new helpers/flags/retry counters unless a one-line local check is clearer; prefer extending the existing `if` block.

## Scope

**In**

- `src/collector-ledger.ts` — second identity compare + fatal before commit path  
- `test/collector-ledger.test.ts` — repeated-drift regression; keep control  

**Out**

- Schema, Soul, README, CLI, receipt types, limits, transport shape, marker/recovery redesign, extra retries  

**Apply-phase verification (not run in plan)**

1. `npm run typecheck`  
2. `HOME=$(mktemp -d) npm test`  
3. pack dry-run (repo’s declared pack/`npm pack --dry-run` path)  
4. `git diff --check`  
5. Forward commit only; no amend; title/body cite repeated-drift root cause and finding disposition  

## Residual risk

None for this packet if the throw sits before `pendingRecords` / `storeEvidence` / snapshot push. Reject any fix that only asserts in tests, soft-warns, or binds mixed-pass identities.
