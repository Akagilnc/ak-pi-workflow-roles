# Plan: Collector cancellation precedence residual

## Diagnosis

**HEAD:** `f2c0614`  
**Owner:** `src/collector-github.ts` → `createGhCollectorGitHubTransport().createIssueComment` catch  
**Behavior violated:** arbitrary-reason / original-reason cancellation — when the request signal is aborted, the failure must surface as a throw of the **exact caught value**, not as a terminal transport result.

### Root cause (ordering, not missing abort check)

Current catch (lines ~537–555):

```ts
} catch (error) {
  if (isRecord(error) && error["ambiguousGhFailure"] === true) {
    return { kind: "ambiguous_loss", diagnostics: ... };
  }
  if (input.signal?.aborted || (isRecord(error) && error["name"] === "AbortError")) {
    throw error;
  }
  return { kind: "rejected", ... };
}
```

`f2c0614` correctly switched cancel detection to **signal state** (dropped `/abort|cancel/i`), but left **`ambiguousGhFailure` ahead of `input.signal?.aborted`**.

Reproduced at HEAD:

| Case | Result today |
| --- | --- |
| `controller.abort(Object.assign(new Error("deadline exceeded"), { ambiguousGhFailure: true }))` then runner throws that same reason | resolves `{ kind: "ambiguous_loss" }` |
| Signal aborted; runner throws a *different* `{ ambiguousGhFailure: true }` error | resolves `{ kind: "ambiguous_loss" }` |

Both violate: signal state must be authoritative **before** transport-failure tagging. Ambiguous-loss remains valid only for **non-aborted** failures.

Ledger consequence (no ledger code change): `request()` records `status: "started"` then awaits POST; a thrown cancel leaves the attempt non-terminal `started` and keeps process-local one-shot. Returning `ambiguous_loss` wrongly terminalizes the attempt and dirties observation generation.

### Prior method family (do not repeat)

- `25d0da2`: broadened reason-text match to `/abort|cancel/i` — superseded.
- `f2c0614`: signal-state cancel, but **after** ambiguous tag — incomplete; this residual is the leftover ordering hole, not a new cancel status or message matcher.

---

## Repair plan (sole residual)

### Behavior
On `createIssueComment` catch: if `input.signal?.aborted`, **rethrow the exact caught `error`** (identity preserved). Only if not aborted, classify `ambiguousGhFailure` → `ambiguous_loss`; else `AbortError` name belt rethrow; else `rejected`. No new statuses, no reason-text matching, no runner/`onAbort` redesign.

### Owner
- **Code:** `src/collector-github.ts` only — reorder the catch branches in `createIssueComment`.
- **Proof:** `test/collector-github.test.ts` — extend hung-POST cancellation coverage.

### Red → Green

**Red (HEAD, reproducible):**
```ts
const reason = Object.assign(new Error("deadline exceeded"), { ambiguousGhFailure: true });
// in-flight hung POST + controller.abort(reason)
// → createIssueComment / ledger.request resolves { kind: "ambiguous_loss" }
//   instead of throwing `reason`
```

**Green:**
1. **Production catch order** (minimal diff):

```ts
} catch (error) {
  // AbortSignal state is authoritative before transport-failure tagging.
  if (
    input.signal?.aborted ||
    (isRecord(error) && error["name"] === "AbortError")
  ) {
    throw error; // exact caught value
  }
  if (isRecord(error) && error["ambiguousGhFailure"] === true) {
    return { kind: "ambiguous_loss", diagnostics: ... };
  }
  return { kind: "rejected", diagnostics: ... };
}
```

2. **Test:** extend `assertHungPostRequestCancellation` / add case:
   - Abort reason: `Object.assign(new Error("deadline exceeded"), { ambiguousGhFailure: true })`
   - Assert **strict reason identity** (`error === abortReason`)
   - Assert POST **child death**
   - Assert attempt **`status === "started"`** (non-terminal; not rejected/ambiguous_loss/succeeded/recovered)
   - Assert **process-local one-shot** retained on second request

   Prefer tightening the shared helper (identity + explicit `started`) so existing deadline/non-Error cases also lock the original-reason rule; add one dedicated call site for the ambiguous-tagged reason.

### Scope (hard bounds)

| In | Out |
| --- | --- |
| Catch branch order in `createIssueComment` | Runner settle/kill redesign |
| Hung-POST test extension + identity/`started` assertions | Ledger, receipt, soul, schemas, README |
| | New cancel/attempt kinds or parallel validators |
| | Softening AC / deleting ambiguous_loss for non-aborted paths |
| | Any file beyond the two above |

### Apply-phase verification (when approved)

1. Targeted: hung-POST / cancel tests in `test/collector-github.test.ts` (incl. new ambiguous-tagged reason).
2. Broader: `test/collector-github.test.ts` full file (preserve 2xx parse → ambiguous_loss, recovery one-shot POST, R11 GET cancel).
3. Confirm working tree = authorized files only; one forward commit; no amend.

### Commit intent (apply only)

`fix(collector): prefer AbortSignal over ambiguousGhFailure on POST cancel`  
Body: signal-aborted rethrows exact caught value before ambiguous tagging; hung-POST proves identity + started + child death + one-shot with ambiguous-tagged deadline reason.

---

## Refusal triggers (none now)

Plan is actionable at named owner; facts hold; no authority conflict. Apply should `refused` only if approved packet drifts or verification cannot pass without out-of-scope changes.
