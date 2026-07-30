# Plan-Gate: Collector residual exact oracles (packet 4 @ 91a1a92)

## Summary

- **F1 (exact-oracle rows)**: fully plannable as test-only tightenings; production schema/batch already owns the laws.
- **F3 (ambient provider-unused)**: restoring `faux.state.callCount === 0` is correct; **honest prevention of model invocation is not achievable via current Pi lifecycle cancel APIs**. Plan is restore oracles + attempt only lifecycle-aligned fixes; if gate would require a new provider-proxy mechanism, **apply refuses F3 with owner decision** (packet explicitly authorizes this). Do **not** weaken the oracle.

HEAD: `91a1a92`. No code/git changes in plan.

---

## (1) F1 exact-oracle residuals

### Behavior
1. **`test/collector-receipt.test.ts`**
   - Remove `if (raw === null) continue` so **every** matrix malformed row, including `null raw`, runs through `classifyCollectorBatch` and asserts `allow === false`.
   - Pass observe args `{}` through `classifyCollectorBatch` (sole observe toolCall, `outputAccepted: false`, `hasCompletedOperationalOrSnapshot: false`) and assert the **legal** decision: `allow === true`, operational `ak_collector_observe`.
   - Keep existing `collectorToolArgumentsValid(OBSERVE, {}) === true` and illegal observe `undefined|null` batch rows.
2. **`test/collector-role.test.ts`**
   - Replace/extend the sole blank-rationale observe+output sibling with **two** mandated real-Pi sibling rows:
     - **unknown leg field** (`extra` on leg)
     - **unavailable-without-scope** (`status: "unavailable"` and no `unavailableScope`)
   - Each: valid `ak_collector_observe` + invalid `ak_collector_output` in one assistant message; assert `exitCode === 1` and **all six** GitHub counters zero via `assertZeroGitHub`.
   - Keep standalone invalid-output matrix rows (including blank rationale) as-is.

### Owner
- Tests only: `test/collector-receipt.test.ts`, `test/collector-role.test.ts`
- Production (`classifyCollectorBatch`, TypeBox output anyOf) already rejects these shapes — no schema fork unless a green assertion reveals a real gap (unexpected).

### Red
- `null` skipped in batch loop; observe `{}` never batch-asserted as legal.
- Only one sibling (blank rationale); missing mandated unknown-field and unavailable-without-scope siblings.

### Green
- Full invalid matrix → batch `allow: false` including null.
- Observe `{}` → batch legal operational allow.
- Two siblings → fatal/nonzero + six counters zero each.

### Scope
- Test edits only; no Soul/README/orchestrator; no AC relaxation.

---

## (2) F3 ambient provider-unused lifecycle

### Behavior
For **every** ambient row (`skills`, `contextFiles`, `appendSystemPrompt`, and already-correct `commands` / required-tool):
- seam-specific fatal text
- all six GitHub counters zero
- **`faux.state.callCount === 0`** and **`faux.getPendingResponseCount() === 1`**
Detection must **prevent model invocation**, not only latch fatal then allow a provider turn.

### Owner
- Oracles: `test/collector-role.test.ts` (`F3-ambient-skills|contextFiles|appendSystemPrompt`)
- Lifecycle: `src/collector-role.ts` ambient guards + fail-closed path that already works for activation-time defects (`session_start` → `activationInvalid` → `input` `{action:"handled"}`)

### Red (current)
- skills/contextFiles/appendSystemPrompt assert fatal + GH-zero only.
- skills explicitly relaxes provider obligation (“Pi swallows `before_agent_start` throws”).
- commands/required-tool already assert `callCount === 0` because they fail at **activation**, before first prompt.

### Green
- All ambient rows share the same provider-unused oracle as commands/required-tool, with real prevention (not oracle weakening).

### Scope
- Collector lifecycle/failure seam + F3 tests only.
- No oracle weakening; no “host may still enter provider” apology.

---

## Pi first-party feasibility (evidence)

| Mechanism | Location | Result |
| --- | --- | --- |
| `before_agent_start` throw | `ExtensionRunner.emitBeforeAgentStart` (`runner.js` ~842–870) | **Swallowed**; `emitError` only; loop continues |
| Cancel on before_agent_start | `BeforeAgentStartEventResult` (`types.d.ts` ~794–798) | **No** `cancel`/`block` (unlike `session_before_*` / `tool_call`) |
| `ctx.abort()` in before_agent_start | `Agent.abort` → `activeRun?.abortController` (`agent.js` ~200–201); `activeRun` created in `runWithLifecycle` **after** before_agent_start (`agent-session.js` ~882 then ~917) | **No-op** for upcoming turn |
| Abort at `agent_start`/`turn_start` | `runAgentLoop` emits start then `streamAssistantResponse` without pre-stream `signal.aborted` check; faux `callCount++` on stream entry (`faux.js` ~316) | Cannot keep **`callCount === 0`** |
| `before_provider_request` | throws swallowed; payload mutate only; runs inside stream path | Too late for callCount |
| Paths that **do** get callCount=0 | `session_start` failure → `activationInvalid` → `input` handled → `prompt()` returns (`agent-session.js` ~812–815) | Works for commands/required-tool |

Ambient **skills** test injects only into `event.systemPromptOptions.skills` at `before_agent_start` — not visible at `session_start`.  
`getSystemPromptOptions` exists on **command** context only, not `ExtensionContext` used by `session_start` / `before_agent_start`.

**Conclusion:** With current Pi APIs, an extension **cannot honestly cancel** the first provider turn once ambient is first observed on `before_agent_start`. A `registerNativeProvider` dispatch proxy could force `callCount===0` but is a **new parallel interception layer** (违背删压过加), not a lifecycle cancel seam Pi owns.

---

## Apply strategy

### A. F1 (do)
1. receipt: drop null skip; add legal observe `{}` batch assertion.
2. role: two mandated siblings with exitCode + `assertZeroGitHub`.
3. Run focused collector tests + typecheck.

### B. F3 oracles (do)
Add `callCount === 0` + pending `=== 1` to skills/contextFiles/appendSystemPrompt (remove relaxation comment).

### C. F3 production (try-minimal, else refuse)
1. **Do not** add provider-proxy / stream wrapper as default fix.
2. **Do not** move detection to filesystem rediscovery that bypasses `systemPromptOptions`.
3. Confirm no overlooked first-party cancel (re-check same Pi surfaces at apply time).
4. If still infeasible → **`refused` (partial OK if F1 committed)** with owner decision, not a green false completion.

### Owner decision (if F3 refused)
Need one of:
1. **Pi platform**: `BeforeAgentStartEventResult.cancel` (or equivalent) honored before `_runAgentPrompt`; or
2. **Product ruling**: ambient provider-unused is best-effort fatal+GH-zero until Pi cancel exists; or
3. **Explicit authority** for a Collector-owned provider dispatch gate (new mechanism, design review).

Evidence anchors: `runner.js` emitBeforeAgentStart try/catch; `types.d.ts` BeforeAgentStartEventResult; `agent-session.js` prompt order; `agent.js` abort/activeRun; `faux.js` callCount; collector activationInvalid input-handled path.

---

## Out of scope
- F2 decoys, overflow, Soul, dual-schema, weakening AC, amend of `91a1a92`, non-collector roles.

## Validation (apply)
- `node --import tsx --test test/collector-receipt.test.ts test/collector-role.test.ts`
- `npm run typecheck`
- Working tree = authorized edits only; one new forward commit if any adoption; title prefix per task contract.

## Plan status
**planned** — F1 concrete; F3 oracle restore + evidence-gated refuse/owner path rather than fake completion or weakened oracle.
