# Plan: Collector cancellation precedence residual

## Residual (reproduced at HEAD `f2c0614`)

In `createGhCollectorGitHubTransport().createIssueComment` catch (`src/collector-github.ts` ~536–556), **transport-failure tagging runs before AbortSignal state**:

```ts
} catch (error) {
  if (isRecord(error) && error["ambiguousGhFailure"] === true) {
    return { kind: "ambiguous_loss", ... };
  }
  if (
    input.signal?.aborted ||
    (isRecord(error) && error["name"] === "AbortError")
  ) {
    throw error;
  }
  return { kind: "rejected", ... };
}
```

When an in-flight hung POST is aborted with a reason that also carries the transport tag:

```ts
Object.assign(new Error("deadline exceeded"), { ambiguousGhFailure: true })
```

the runner rejects with that exact object while `input.signal.aborted === true`. Catch hits `ambiguousGhFailure` first and returns `{ kind: "ambiguous_loss" }`, violating the packet’s **signal-state-before-tag** / **arbitrary-reason identity** rule. Cancel must rethrow the exact caught value; ambiguous-loss is only for **non-aborted** failures.

Prior commit `f2c0614` already dropped reason-text matching and kept an `AbortError` name belt, but left tag-before-signal. Do not re-ship that order or any variant that folds `AbortError` into the signal branch ahead of the tag.

## Authority / scope

- **In scope only:** `src/collector-github.ts` (`createIssueComment` catch order) and `test/collector-github.test.ts` (red/green + control).
- **Out of scope:** ledger, runner spawn/kill, other transport methods, README, AC relaxation, new parallel cancel mechanisms.
- **Do not** combine `input.signal?.aborted || name === "AbortError"` ahead of ambiguous tagging. That would reclassify a **non-aborted** error with both `name: "AbortError"` and `ambiguousGhFailure: true` as cancel, contradicting “retain ambiguous-loss for non-aborted failures” and sole-residual scope.

## Root cause

Single catch with wrong precedence. `ambiguousGhFailure` is a **transport** tag (set when `gh` exits without parseable HTTP). AbortSignal state is the **cancel** authority. When both are present because abort reason was the tagged object (or the rejected value is that object under an aborted signal), signal must win and preserve exact identity. The non-signal `AbortError` name belt is a fallback only after the tag check, never merged with the signal branch.

## Behavior (sole ordering change)

Replace the catch body with **four separate branches, this exact order**:

1. **Signal state (authoritative cancel)**  
   `if (input.signal?.aborted) throw error;`  
   — rethrow **exact caught value** (identity), no reason-text matching, no wrapping.

2. **Non-aborted transport tag**  
   `if (isRecord(error) && error["ambiguousGhFailure"] === true) return { kind: "ambiguous_loss", diagnostics: ... };`  
   — only reachable when signal is not aborted.

3. **Non-signal `AbortError` belt**  
   `if (isRecord(error) && error["name"] === "AbortError") throw error;`  
   — belt only; does not consult signal (already handled).

4. **Otherwise**  
   `return { kind: "rejected", diagnostics: ... };`

### Green oracle (must match — do not collapse branches)

```ts
} catch (error) {
  if (input.signal?.aborted) {
    throw error;
  }
  if (isRecord(error) && error["ambiguousGhFailure"] === true) {
    return {
      kind: "ambiguous_loss",
      diagnostics: error instanceof Error ? error.message : String(error),
    };
  }
  // Non-signal AbortError belt only (after tag).
  if (isRecord(error) && error["name"] === "AbortError") {
    throw error;
  }
  return {
    kind: "rejected",
    diagnostics: error instanceof Error ? error.message : String(error),
  };
}
```

**Rejected green shape:** any form that tests `input.signal?.aborted || name === "AbortError"` before or instead of the separate tag branch (that is the correction target).

## Test plan

### A. Red/green — hung POST + tagged abort reason (packet primary)

Extend the existing hung-POST helper path (`assertHungPostRequestCancellation` / sibling test) with reason:

```ts
Object.assign(new Error("deadline exceeded"), { ambiguousGhFailure: true })
```

Assert **all** of:

| Check | Requirement |
| --- | --- |
| Strict reason identity | `assert.rejects` predicate uses `Object.is(error, abortReason)` (or `===`), not merely message substring |
| Child death | POST child PID dead (`ESRCH` / kill 0 fails) |
| Non-terminal attempt | `attempts.length === 1` and **`attempts[0].status === "started"`** (explicit; not only `notEqual` terminal statuses) |
| One-shot retained | second `ledger.request` at same HEAD rejects `/already used\|process-local/i` |
| Not ambiguous_loss / rejected | cancel must not settle the attempt as transport loss or rejection |

Keep existing arbitrary-reason cases (`"request canceled"`, plain `"deadline exceeded"`, non-Error `"stop now"`) if still useful; the tagged case is the residual lock.

### B. Control — non-aborted overlapping tag + `AbortError` name

Unit-level `createIssueComment` (mock runner that rejects; **no** aborted signal):

```ts
Object.assign(new Error("gh api failed without parseable HTTP"), {
  name: "AbortError",
  ambiguousGhFailure: true,
})
```

Assert result is **`{ kind: "ambiguous_loss" }`** (not throw). This locks branch order: without signal abort, tag wins over the `AbortError` belt. A wrong green that lifts `AbortError` before the tag would fail this control while maybe still passing the hung-POST abort case.

Optional tight sibling (same mock style, still non-aborted): plain `ambiguousGhFailure: true` without `AbortError` name → `ambiguous_loss`; plain `name: "AbortError"` without tag → rethrow. Not required if B alone plus A fully pin the four-way order.

## Apply steps (for apply phase only)

1. Reorder `createIssueComment` catch to the four-branch green oracle above; no other logic churn.
2. Add/adjust tests A + B in `test/collector-github.test.ts`.
3. Verify: `node --test test/collector-github.test.ts` (and repo typecheck if normally required for this package).
4. Confirm working tree is only those two files; new forward commit (no amend); title prefix per task contract; body cites signal-before-tag root cause, hung-POST tagged-reason identity, and non-aborted AbortError+tag control.

## Non-goals / refuse conditions

- No deleting or weakening ambiguous_loss for genuine non-aborted transport failures.
- No reason-text `/abort|cancel/i` restoration.
- No runner/ledger “fixes” to paper over catch order.
- If HEAD already matches the four-branch order and both tests pass, refuse with evidence rather than empty commit.

## Verification matrix (apply self-check)

| Case | signal.aborted | error shape | Expected |
| --- | --- | --- | --- |
| A hung POST tagged abort | true | `Error("deadline exceeded")` + `ambiguousGhFailure: true` (exact reason) | throw **same** value; child dead; attempt `started`; one-shot held |
| B control | false | `name: "AbortError"` + `ambiguousGhFailure: true` | `ambiguous_loss` |
| Existing plain abort reasons | true | untagged Error / string | throw exact reason (regression) |
| Existing 2xx parse loss | n/a | parse throw inside 2xx | `ambiguous_loss` (untouched path) |
