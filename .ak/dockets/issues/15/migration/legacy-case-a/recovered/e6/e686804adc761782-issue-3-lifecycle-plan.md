## Residual (HEAD 27b037d)

`extractAcceptedJudgeOutputs()` in `test/judge-posture-recordings.test.ts` already requires a bound call→start→terminal *payload* chain, but still uses three global last-write maps:

- `issuedArgsById.set` (L312)
- `startArgsById.set` (L326)
- join-at-end over `terminalsById` with no row indices (L366–373)

So row order is discarded, and duplicate same-ID issuances/starts overwrite. Mechanical probes on current logic accept **1** for all four malformed streams:

1. terminal → call → start  
2. start → call → terminal  
3. two conflicting assistant calls, one ID (last call wins)  
4. two conflicting starts, one ID (last start wins)

Prior same-seam family (do not repeat): 27b037d closed orphan/mismatch/details-drift via maps + deep-equal, but left unordered last-write lifecycle. Fix must not be another map-only / last-write variant.

Real bundles already coherent and ordered (`call → start → end → toolResult` in both `r-block` and `r-ready`). No Soul/re-record.

---

## Behavior

Per non-empty `toolCallId`, accept only an **unambiguous ordered lifecycle**:

- **Exactly one** assistant-issued `ak_judge_output` toolCall (object args)
- **Exactly one** matching `tool_execution_start` (same id/name, object args)
- **≥1** successful terminal(s) (`tool_execution_end` and/or `toolResult`): `isError === false`, text contains `Judge verdict accepted`, object details
- Strict row order: **call index < start index < every terminal index**
- Args/details deep-equal across the single call, single start, and all terminals; terminals agree with each other (keep multi-representation merge)
- Reject replay/conflict: >1 issuance or >1 start for the same ID (even if args identical or last-write would match)
- Unrelated IDs stay independent (two fully ordered IDs → 2 accepted)

## Owner

- **Sole code owner:** `test/judge-posture-recordings.test.ts` — `extractAcceptedJudgeOutputs` + four new negatives beside existing acceptance tests
- **Doc (optional, oracle bind text only):** `test/fixtures/judge-postures/README.md` Offline CI bind bullet — add unique ordered lifecycle; no bundle bytes
- **Out of owner:** `souls/judge.md`, `src/**`, schemas/extensions, session/receipt/meta re-record

## Red (must fail today → pass after)

Add four negatives; each `extractAcceptedJudgeOutputs(...).length === 0`:

| Case | Stream sketch |
| --- | --- |
| out-of-order terminal-first | `end(id) → call(id) → start(id)` |
| out-of-order start-before-call | `start(id) → call(id) → end(id)` |
| conflicting/replayed calls | `call(id,A) → call(id,B) → start(id,B) → end(id,B)` |
| conflicting/replayed starts | `call(id,B) → start(id,A) → start(id,B) → end(id,B)` |

Reuse existing `syntheticAssistantCall` / `syntheticExecutionStart` / `syntheticAcceptedEnd` helpers.

## Green (must stay)

- Both real bundles: exactly one accepted bound output; receipt/neutrality/soul pins unchanged
- `acceptance parser binds full chain and merges agreeing terminals for one id`
- `acceptance parser keeps two distinct fully-bound ids with identical details` (length 2)
- Existing negatives: orphan end/message, missing `isError`, terminal details conflict, call/start mismatch, details drift

## Scope

| In | Out |
| --- | --- |
| Rewrite oracle to per-ID event lists **with row indices** (not last-write maps) | Soul / judgment kernel |
| Exactly-one call + exactly-one start; `call < start < terminal*` | Bundle re-record / fixture session bytes |
| Four new negatives | `src/**`, runtime, schemas |
| Keep payload deep-equal + multi-terminal agree rules | Weakening any existing assertion |
| Optional one-line README bind clarification | Issue #1/#2 or posture product behavior |

### Apply sketch (for later; not this phase)

1. In `extractAcceptedJudgeOutputs`, scan `for (let i = 0; i < rows.length; i++)` and push `{ index: i, args|terminal }` into per-ID `issued[]`, `starts[]`, `terminals[]` (stop using `.set` overwrite for call/start).
2. Accept an id only when `issued.length === 1 && starts.length === 1 && terminals.length >= 1`, indices satisfy `issued[0].index < starts[0].index && terminals.every(t => t.index > starts[0].index)`, and existing deep-equal gates hold.
3. Add the four named negative tests next to the current acceptance block (~L695+).
4. Optionally tighten fixture README bind rule with “exactly one call and one start; call < start < terminal; reject same-ID replay.”
5. Verify: `node --test test/judge-posture-recordings.test.ts` (and package typecheck if repo-standard).
6. Single forward commit; no amend; test-only tree.

### Non-goals / refuse conditions

- Do not “fix” by dropping real-bundle or two-ID greens, or by accepting last-write when duplicates agree.
- Do not re-record sessions or touch Soul for this residual.
- If apply discovers real bundles violate ordered unique lifecycle (unexpected), refuse rather than hand-edit JSONL.
