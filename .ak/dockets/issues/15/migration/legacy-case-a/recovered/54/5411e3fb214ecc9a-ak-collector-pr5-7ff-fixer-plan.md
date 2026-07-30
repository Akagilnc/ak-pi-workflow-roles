# Plan: PR5 three current-head repairs @ 7ffbd36

No code/docs/git changes in this phase. HEAD verified `7ffbd3684fe41dc63c28cb7cb79696f2f5e0c3ed`.

Prior history (do not re-ship wall-only / stamp-only variants):
- `25d0da2` added wall `firstObservedAt` vs wall `deadlineTime` first-sighting guard
- `f2c0614` moved stamp to post-fetch surface hand-off but left wall predicate
- body schema already has `pattern: "\\S"`; authors still `minLength: 1` only

---

## 1. Monotonic first-sighting eligibility

### Behavior
- **Red (reproduced at HEAD):** activation mono `0` / deadline mono `900000`; advance mono to `960000`; `setWall("2024-01-01T00:20:00Z")` (before wall deadline `00:25`); first-seen review with `submitted_at=00:05` → `authoritativeTime=00:05`, `windowRelation=before`, **`valid` receipt accepted**.
- Root cause: cutoff ownership is `deadlineMono`, but `applyEvidenceVersionHistory` still gates on wall `Date.parse(firstObservedAt)` vs wall `deadlineTime`.
- **Green:** first distinct review version may retain `submitted_at` iff surface-completion mono is **≤ `deadlineMono`** (`===` boundary keeps). Else `authoritativeTime = null` → uncertain; cannot prove `valid` or `unavailable`.
- Wall `firstObservedAt` stays receipt/metadata only (no trust predicate, no unparseable-wall special case once mono is finite).
- Preserve: known-version authoritative null reuse; later distinct versions → null; comments unchanged; conservative start-before/finish-after (stamp mono at same post-fetch hand-off as wall metadata).

### Owner
| Piece | File |
| --- | --- |
| Trust predicate | `src/collector-evidence.ts` `applyEvidenceVersionHistory` |
| Mono stamp + call | `src/collector-ledger.ts` `observe` (with existing post-fetch wall stamp) |

### API (minimal)
Replace third arg `deadlineTime: Date` with cutoff object:

```ts
applyEvidenceVersionHistory(pending, prior, {
  deadlineMono: number;
  firstObservedMono: number;
})
```

Predicate: non-finite mono or `firstObservedMono > deadlineMono` → null; else `submittedAt ?? null`.

Ledger (surface hand-off):
```ts
const firstObservedAt = clock.wallNow().toISOString(); // metadata
const firstObservedMono = clock.monoNow();            // trust
applyEvidenceVersionHistory(..., { deadlineMono: deadlineMono!, firstObservedMono });
```

Do **not** add `firstObservedMono` onto evidence records / Soul / parallel classifiers.

### Red → Green tests
1. **Unit boundary** (`test/collector-ledger.test.ts`): rewrite existing wall-based `applyEvidenceVersionHistory` tests to mono — `firstObservedMono === deadlineMono` keeps `submitted_at`; `>` nulls; known-version null reuse; drop wall-unparseable-as-trust-gate.
2. **Rollback integration** (`test/collector-receipt.test.ts`, extend local `clockAt` with `setWall`): packet reproduction → `authoritativeTime null`, not before/within; `buildCollectorReceipt` rejects both `valid` and `unavailable`.
3. Keep existing mid-observe start-before/finish-after coverage green (mono advances with wall there).

### Scope
- Touch: `collector-evidence.ts`, `collector-ledger.ts`, ledger + receipt tests, any other `applyEvidenceVersionHistory(...)` call sites (snapshot byte helper).
- Out: window-relation wall math for trusted clocks; Soul; new record fields.

---

## 2. Child stdin failures (`createGhApiRunner`)

### Behavior
- **Red (reproduced):** real child exits before reading; parent `stdin.write(32MiB)` with no handler → process **`uncaughtException` `write EPIPE`**; runner promise may not be the sole settlement path.
- **Green:** stdin `error` attached **before** `write`/`end`; routed through existing `settle()` so one resolve/reject; no process crash; abort still rejects **`signal.reason`**; non-abort stdin failure tagged like close’s non-HTTP path (`ambiguousGhFailure: true`) so POST stays `ambiguous_loss` (not flaky `rejected` via race with `close`).

### Owner
`src/collector-github.ts` `createGhApiRunner` only. No new cancel status / attempt state.

### Implementation sketch
```ts
child.stdin.on("error", (error) => {
  settle(() => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const err = error instanceof Error ? error : new Error(String(error));
    reject(Object.assign(err, { ambiguousGhFailure: true }));
  });
});
// then write/end
```

Preserve: `child.on("error")`, `close` HTTP parse / code-0 / ambiguous reject, abort listener + kill, POST success/rejected/ambiguous_loss mapping in `createIssueComment`.

### Red → Green tests
`test/collector-github.test.ts` via existing `withPathGhStub`:
1. Stub exits immediately (no stdin read); `runner(..., { stdin: "x".repeat(32<<20) })` **rejects once**; `uncaughtException` count `0`; no double settlement.
2. Optional transport path: same stub through `createIssueComment` → `ambiguous_loss` (not process death).
3. Existing abort / rejected / ambiguous PATH tests stay green.

### Scope
- Touch: `createGhApiRunner` + github tests.
- Out: spawnImpl-only mocks without real pipe; Soul; changing GET paths (no stdin).

---

## 3. Published author schema parity

### Behavior
- **Red:** `COLLECTOR_LEGS_SCHEMA` + `schemas/collector-legs-v1.schema.json` accept `expectedAuthors:["   "]` (`minLength: 1`); `loadCollectorManifest` rejects non-blank.
- **Green:** both schema owners use same non-whitespace item constraint as request body (`minLength: 1` + `pattern: "\\S"`); deep equality retained; nonblank authors with surrounding spaces still schema-valid and runtime trim-normalized.

### Owner
| Artifact | Path |
| --- | --- |
| TS export | `src/collector-config.ts` `COLLECTOR_LEGS_SCHEMA.properties.legs.items.properties.expectedAuthors.items` |
| Published JSON | `schemas/collector-legs-v1.schema.json` same node |

Runtime `parseExpectedAuthor` / trim-lowercase stays enforcement authority (unchanged).

### Red → Green tests (`test/collector-config.test.ts`)
1. Keep file↔`COLLECTOR_LEGS_SCHEMA` deep equality.
2. Assert author `items.pattern === "\\S"` (and minLength 1), mirror body oracle style.
3. **Behavioral schema validation** (not equality-only): `new RegExp(pattern)` rejects `"   "` / `""` path; accepts `"CodexBot"` and `" CodexBot "` (trim remains runtime).
4. Existing `blank-author` loadCollectorManifest rejection + trim-normalization tests stay green.

### Scope
- Schema pair + config tests only. No Soul. No second validator framework dependency unless already present (prefer RegExp from schema pattern / equality; typebox not required).

---

## Apply-phase order & verification

1. Finding 1 (predicate + ledger stamp + unit/rollback tests).
2. Finding 2 (stdin handler + real-child EPIPE test).
3. Finding 3 (dual schema + behavioral oracle).
4. `npm test -- test/collector-ledger.test.ts test/collector-receipt.test.ts test/collector-github.test.ts test/collector-config.test.ts` (and full `npm test` / `npm run typecheck` if clean).
5. Single forward `fix(collector): ...` commit (no amend); worktree only these owners.

## Explicit non-goals
- Collector Soul text; parallel binders/classifiers; weakening AC; rewriting window-relation wall semantics for trusted `submitted_at`; storing mono on evidence records; expanding beyond the three findings.
