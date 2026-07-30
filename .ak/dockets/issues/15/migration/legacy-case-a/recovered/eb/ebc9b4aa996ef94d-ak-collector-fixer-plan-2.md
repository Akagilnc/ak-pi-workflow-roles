# Fixer plan 2 — Collector residual defects on `c7ee3b5` (revised)

**Phase:** plan only (no code, test, doc, or Git mutation)  
**HEAD:** `c7ee3b5`  
**Scope:** three Judge findings only. Do not reopen fixed six-defect work except where these findings force a shared owning-seam fix.

---

## Confirmed residual defects (live evidence)

### F1 — Three divergent argument contracts
Today there are three shapes for Collector tool args:

| Owner | Location | Behavior |
| --- | --- | --- |
| Registered TypeBox | `src/collector-role.ts:50-85` | `unavailableScope` optional on every status; rationale `minLength:1` (whitespace OK) |
| Batch classifier | `src/collector-ledger.ts:182-238` | observe `undefined` allowed; output ignores scope/unknown leg keys; hand-written key lists |
| Receipt parser | `src/collector-receipt.ts:94-160` | status-conditional scope; unknown keys rejected; nonblank rationale |

Live probes: sole output with extra leg field, invalid/misplaced scope, and related malformed output shapes return `allow:true` at finalized-batch. Schema-invalid never reaches receipt parse when the batch gate allows the call.

Real-Pi already covers sole schema-invalid **observe** and valid+schema-invalid **wait**. Sole/sibling **output** schema-invalid cases are absent.

### F2 — Receipt ref leg ownership broken
`CollectorRequestAttempt` already owns `marker`, `legId`, `commentEvidenceId`, `snapshotId`, `recoverySnapshotId` (`src/collector-ledger.ts:58-71`).

Live two-leg missing probe (request only `a` → both legs missing):

- leg `b` / terminal-report `b` contained leg `a`’s `commentEvidenceId` → **`bContaminated:true`**
- Root: `collectMissingProofRefs` (`src/collector-receipt.ts:330-375`) adds **every** requester body containing `ak-collector:v1` to **every** missing leg, ignoring attempt ownership.

Unavailable live probe (two legs; leg `b` cites own decline + decoys):

- wrong-leg requester marker preserved (`hasAReq:true`)
- after-window same-author noise preserved
- non-qualifying PR/snapshot ids preserved
- Root: wrong-author-only filter + `boundRefs = proof ∪ remaining evidenceRefs` (`src/collector-receipt.ts:497-541`) keeps mechanically non-qualifying extras instead of rejecting them.

### F3 — Binding tests are labels, not measured counterexamples
Confirmed absent or non-exercising:

- `test/collector-ledger.test.ts:761-763` title “max accept, max+1 fail” only builds oversized body; never measures exact `==8 MiB` accept via `measureNormalizedBytes`.
- `test/collector-receipt.test.ts:890-928` grows observe materialization; never hits receipt output path `src/collector-receipt.ts:748-753`, and never routes through `ak_collector_output` → role infrastructure-failure.
- No two-leg missing/unavailable ownership tests with one decoy per case.
- No real-Pi sole/sibling **output** schema-invalid rows (each malformation isolated).
- No concrete tests for: before-deadline comment edited terminal after deadline; separate timestamp-less **state** and **text** variants; separate review edit / dismiss / disappearance retention; required-tool **absence**; each ambient instruction-resource surface; separate duplicate evidenceId / duplicate snapshotId / cross-namespace collision.

Green 169/169 suite does **not** cover the above.

---

## Repair principles (mandatory)

1. **Tests first, then minimal owning-seam fix** — each finding gets red counterexamples before production edits.
2. **One shared TypeBox schema owner — mandatory, not preferred.** No second key list, no parallel marker parser, no parity-guard dual validator, no fallback shape checker.
3. **Leg ownership is an invariant** — join authenticated request comments to the recorded attempt by exact `attempt.marker`; auto-link only the latest relevant same-leg attempt proof; reject wrong-leg/non-qualifying model refs fail-closed for **both** missing and unavailable.
4. **Do not weaken AC** — no assertion relaxation, no “preserve decoys” soft paths, no raising byte limits.
5. **Avoid prior failed method family** — tighten the existing batch-classification and missing auto-link seams; do not add a parallel filter/allowlist beside them.
6. **Exact measured boundaries** — 8 MiB and 32 MiB cases construct and measure real payloads at `==MAX` and `==MAX+1`; no constant-only assertions, no oversized approximations, no truncation helpers that hide the law.

---

## Planned changes (apply phase)

### 1) Singular TypeBox schema owner

**New leaf module (schema owner):** `src/collector-tool-schemas.ts`

Export the **only** Collector tool argument contracts:

```ts
// observe — empty object, additionalProperties:false
export const collectorObserveArgsSchema = Type.Object({}, { additionalProperties: false });

// request / wait — same bounds as today’s registration
export const collectorRequestArgsSchema = Type.Object(
  { legId: Type.String({ minLength: 1 }), snapshotId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export const collectorWaitArgsSchema = Type.Object(
  { durationMs: Type.Integer({ minimum: 1, maximum: 900_000 }) },
  { additionalProperties: false },
);

// output leg — strict status-discriminated union (NOT optional scope on a shared object)
const nonBlankString = Type.String({ minLength: 1, pattern: "^.*\\S.*$" }); // non-whitespace-only
const evidenceRefsSchema = Type.Array(Type.String({ minLength: 1 }), { minItems: 1 });

const validLeg = Type.Object({
  legId: Type.String({ minLength: 1 }),
  status: Type.Literal("valid"),
  rationale: nonBlankString,
  evidenceRefs: evidenceRefsSchema,
}, { additionalProperties: false });

const missingLeg = Type.Object({
  legId: Type.String({ minLength: 1 }),
  status: Type.Literal("missing"),
  rationale: nonBlankString,
  evidenceRefs: evidenceRefsSchema,
}, { additionalProperties: false });

const unavailableLeg = Type.Object({
  legId: Type.String({ minLength: 1 }),
  status: Type.Literal("unavailable"),
  rationale: nonBlankString,
  evidenceRefs: evidenceRefsSchema,
  unavailableScope: Type.Union([Type.Literal("target"), Type.Literal("global")]),
}, { additionalProperties: false });

export const collectorOutputLegSchema = Type.Union([validLeg, missingLeg, unavailableLeg]);
export const collectorOutputArgsSchema = Type.Object(
  { legs: Type.Array(collectorOutputLegSchema, { minItems: 1 }) },
  { additionalProperties: false },
);

export type CollectorOutputArgs = Static<typeof collectorOutputArgsSchema>;
// + Static types for observe/request/wait as needed
```

**Single validation API from the same owner** (e.g. `collectorArgsValid(name, args): boolean` and/or `assertCollectorOutputArgs(raw): CollectorOutputArgs` using `Value.Check` / `Value.Errors` from `typebox/value` against the schemas above). No hand-written key allowlists anywhere else.

**Consumers — all import the owner; none redefine shape:**

| Consumer | Change |
| --- | --- |
| `src/collector-role.ts` | Delete local `observeSchema`/`requestSchema`/`waitSchema`/`outputLegSchema`/`outputSchema`. Register tools with the shared schemas. `Static<>` types come from the owner. |
| `src/collector-ledger.ts` `collectorToolArgumentsValid` | Replace hand-written shape checks with `Value.Check` against the shared schema for the tool name. **Sole residual envelope rule:** observe must actually carry `{}` — reject `args == null/undefined` (raw-call rule); then Check empty object. No other parallel validation. |
| `src/collector-receipt.ts` `parseCollectorOutputCandidate` | Validate via the shared output schema only; on success map `Static` result → `CollectorOutputCandidate` (trim rationale if needed only as pure presentation, not as a second acceptance rule). On failure throw the existing fail-closed path with a schema-invalid message. Delete the hand-rolled key/scope loops. |

**Delete / forbid:**

- any second key list in ledger or receipt
- any “parity guard” that compares two validators
- any fallback validator if TypeBox Check fails
- optional-scope-on-all-status object shape

**Latch behavior unchanged:** schema-invalid → `classifyRawToolCall` malformed → `evaluateBatch` deny → `latchFatal` at batch seam; `message_end` records rejection / `exitCode=1` without execute.

---

### 2) F1 tests — real Pi/schema seam, one malformation per row

**A. Mechanical registered-schema inspection (real in-process Pi)**  
In `test/collector-role.test.ts`, after extension registration, read the actual tool `parameters` objects registered on the in-process Pi extension (not a re-imported TS constant alone). Assert:

- each Collector tool’s registered schema is the shared owner schema (reference equality or deep structural equality with `collector*ArgsSchema`)
- output leg schema is a status-discriminated union: `unavailableScope` required only under `status:"unavailable"`; absent/forbidden under `valid` and `missing`
- `additionalProperties: false` on observe/request/wait/output and each leg variant

**B. Unit matrix via shared Check (no dual oracle)**  
In `test/collector-ledger.test.ts` (and receipt parse only as the same Check→throw path), table-drive:

| # | Fixture | Expect |
| --- | --- | --- |
| 1 | observe `arguments === undefined` | reject |
| 2 | observe `arguments === null` | reject |
| 3 | observe `{}` | allow |
| 4 | observe `{ extra: true }` | reject |
| 5 | output unknown top-level field | reject |
| 6 | output leg unknown field (`extra:true`) | reject |
| 7 | unavailable missing `unavailableScope` | reject |
| 8 | unavailable invalid scope | reject |
| 9 | valid + `unavailableScope` | reject |
| 10 | missing + `unavailableScope` | reject |
| 11 | blank / whitespace-only rationale | reject |
| 12 | empty `evidenceRefs` | reject |
| 13 | well-formed valid | allow |
| 14 | well-formed missing | allow |
| 15 | well-formed unavailable (`target`/`global`) | allow |

Use **only** the shared schema owner for expected allow/deny. Do not maintain a second expected-result oracle.

**C. Real-Pi assistant turns — each sole invalid output isolated**  
In `test/collector-role.test.ts`, ordered with existing batch matrix. **One assistant turn / one session per row** (not “extra field and/or missing scope”):

Sole invalid output (each → `exitCode=1`, **every** GitHub counter `=== 0`):

1. unknown leg field  
2. unavailable missing scope  
3. unavailable invalid scope  
4. scope on valid  
5. scope on missing  
6. blank rationale  
7. empty evidenceRefs  
8. unknown top-level field  

Valid operational + invalid output sibling (each → fatal, every GitHub counter `=== 0`):

9. good observe + output with unknown leg field  
10. good observe + output with unavailable missing scope  
(at least these two sibling shapes; more sibling rows optional if cheap)

**Controls** (prove registered schema is not merely over-rejecting):

11. sole well-formed unavailable output path reaches execute/receipt logic with valid shape (or batch-allow + downstream evidence failure is OK if no complete snapshot — but **arguments** must be schema-valid / not rejected at batch as schema-invalid)  
12. sole well-formed missing output likewise schema-allowed  

For schema-invalid sole/sibling rows: assert zero side effects (`pull/reviews/issueComments/reviewComments/createComment` all 0 as applicable) and nonzero exit.

---

### 3) Leg-owned receipt refs — attempt join only (no marker parser)

**Do not** add an independent `<!-- ak-collector:v1 … -->` parser or leg classifier. Marker format remains built only by `buildCollectorRequestMarker` in `src/collector-github.ts`. Ownership flows from ledger attempts.

#### 3a) Explicit allowed same-leg ref classes

For leg `L`, a ref qualifies only if it is one of:

| Class | Rule |
| --- | --- |
| Final snapshot | `finalSnapshot.snapshotId` |
| Final-snapshot transport facts | evidence ids on final snapshot with kind `pull_request` or `authenticated_user` |
| Expected-author material | `review` / `review_comment` / `issue_comment` whose `authorLogin ∈ expected(L)` |
| Same-leg attempt proof | from attempts with `attempt.legId === L` only: `commentEvidenceId`, `snapshotId`, `recoverySnapshotId` when present |
| Same-leg transport diagnostic | `failure.legId === L` (or explicit global diagnostic policy if already encoded) — never another leg’s marker/comment |

**Auto-link (missing only):** among attempts with `attempt.legId === L` that have authenticated proof, select the **latest relevant** same-leg attempt; auto-link only that attempt’s `commentEvidenceId` / `snapshotId` / `recoverySnapshotId` (plus final snapshot always). Do not union every historical same-leg attempt unless authority already requires full same-leg history for expected-author material (expected-author scan may still collect all same-author records; attempt proof auto-link is latest-only).

#### 3b) Join authenticated requester comments to attempts

Replace the body `.includes("ak-collector:v1")` broadcast with:

```
for each issue_comment record where authorLogin === requesterLogin:
  for each attempt where attempt.legId === L and record.body.includes(attempt.marker):
    associate record.evidenceId with that attempt / leg L
```

Only markers recorded on attempts participate. No regex/leg= parse. Wrong-leg markers never enter leg `L`’s auto-link set because `attempt.legId` filters first.

#### 3c) Missing path — reject model decoys (not only auto-link)

In `buildCollectorReceipt` missing branch (`src/collector-receipt.ts` ~555+):

1. Compute `proofRefs = collectMissingProofRefs(L)` under the classes above.  
2. For **every** model-cited `evidenceRefs` entry: if not in the allowed same-leg class set for `L`, **fail closed** (wrong-leg requester marker, other leg’s comment/snapshots/recovery, after/uncertain non-qualifying noise, dangling unrelated PR/snapshot ids, etc.).  
3. Bind leg + terminal-report `evidenceRefs` to `proofRefs ∪ qualifying model cites` (or proof-only if model cites are subset) — never emit another leg’s ids.  
4. Still require final complete snapshot citation.

#### 3d) Unavailable path — reject all decoys

In unavailable branch (`src/collector-receipt.ts:490-541`):

1. Every model-cited ref must **resolve and qualify** under declared scope (`qualifiesUnavailableEvidence`).  
2. Reject: wrong-leg requester markers, wrong-leg author evidence, after/uncertain/non-qualifying extras, dangling snapshot/PR ids that do not qualify, wrong-author.  
3. **Delete** `boundRefs = proof ∪ all remaining evidenceRefs` (“preserving any additional non-decoy refs”). Bind leg + terminal-report refs to **qualifying proof only**.  
4. Keep full attempts array at receipt root; **never** place another leg’s comment/snapshots/recovery/diagnostics into a leg or terminal report.

#### 3e) F2 tests — one decoy per counterexample

All in `test/collector-receipt.test.ts` (unit ledger fixtures). Each case asserts **both** the leg’s `evidenceRefs` **and** the matching terminal-report `evidenceRefs`.

**Missing — auto-link contamination (two-leg):**

- Configure legs `a`,`b`. Request only `a` (attempt recorded with marker/commentEvidenceId). Emit both legs `missing` with minimal model cites.  
- Assert: `a` leg+report contain `a.commentEvidenceId` and final snapshot; `b` leg+report **do not** contain `a.commentEvidenceId` / `a` attempt snapshot/recovery; `bContaminated === false`.

**Missing — candidate-ref decoys (two-leg), one decoy each:**

| Case | Model cites on leg `b` | Expect |
| --- | --- | --- |
| M1 | cross-leg `a` request `commentEvidenceId` | throw |
| M2 | cross-leg `a` attempt `snapshotId` / recovery id | throw |
| M3 | unrelated dangling evidence/snapshot id | throw |
| M-clean | only qualifying same-leg / final snapshot | accept; leg+report ⊆ allowed same-leg proof |

**Unavailable — decoys (two-leg), one decoy each:**

| Case | Model cites on leg `b` | Expect |
| --- | --- | --- |
| U1 | cross-leg `a` requester request marker/comment | throw |
| U2 | cross-leg `a` author decline/evidence | throw |
| U3 | after-window same-author evidence only / as extra | throw |
| U4 | unrelated PR id | throw |
| U5 | unrelated snapshot id | throw |
| U-clean | only qualifying same-leg before/within decline under declared scope | accept; leg+report refs === qualifying same-leg proof only |

Do **not** pack U1–U5 into one call. A single multi-decoy call does not prove which rule fired.

---

### 4) F3 — concrete binding counterexamples (not a checklist)

Each row is a named test that constructs the fixture and asserts the law. Production code changes only if a row exposes a true residual bug under existing authority; otherwise the test locks current correct behavior.

#### 4a) Evidence / window / version retention (`test/collector-receipt.test.ts` and/or `test/collector-ledger.test.ts`)

| Test name (exact intent) | Construction | Assertion |
| --- | --- | --- |
| v3 before-deadline comment edited terminal after deadline | issue_comment v1 body before deadline; later edit after deadline is terminal version | v1 before body retained in version history; after-edit terminal version window `after`/`uncertain` cannot sole-prove unavailable; missing/unavailable rules hold with correct version selection |
| timestamp-less **state** mutation | review/comment state changes across observes with null/missing timestamps | windowRelation `uncertain`; state forks retained; no backdating |
| timestamp-less **text** mutation | body/text changes across observes with null/missing timestamps | windowRelation `uncertain`; text forks retained; no backdating |
| review **edit** retention | qualifying review then edited content on later observe | prior substantive review variant remains available as evidence; terminal/valid rules use authoritative version policy already in code |
| review **dismiss** retention | valid/pending review then DISMISSED later version | DISMISSED later version cannot sole-qualify valid; prior report/variant retained in ledger history |
| review **disappearance** retention | review present on observe N; absent from observe N+1 (delete) | prior snapshot membership / historical record retained; absence does not erase prior evidence ids from history |

#### 4b) ID collisions (`test/collector-receipt.test.ts`)

| Test | Construction | Assertion |
| --- | --- | --- |
| duplicate evidenceId | two distinct records forced to same `evidenceId` (fixture/API abuse) | fail closed with collision error |
| duplicate snapshotId | two snapshots forced to same `snapshotId` | fail closed with collision error |
| cross-namespace ambiguous id | same string used as both evidenceId and snapshotId (or PR vs comment namespace clash) in refs | fail closed with ambiguous/collision error when cited or materialized |

#### 4c) Startup / ambient fail-closed via **in-process Pi only** (`test/collector-role.test.ts`)

No production test hooks. Provider call count and every GitHub counter must stay 0.

| Test | Construction | Assertion |
| --- | --- | --- |
| required-tool **absence** | register extension such that one of `COLLECTOR_REQUIRED_TOOLS` is missing from the tool table (not name collision — absence) | startup fail-closed; exit nonzero; provider unused; GitHub counters 0 |
| ambient **skills** failure | inject failing/invalid skills surface in host/runtime config used by Collector activation | fail-closed before collection; GitHub 0 |
| ambient **contextFiles** failure | invalid/unreadable contextFiles entry | fail-closed; GitHub 0 |
| ambient **appendSystemPrompt** failure | failing appendSystemPrompt path | fail-closed; GitHub 0 |
| ambient **commands** failure | failing ambient command resource | fail-closed; GitHub 0 |

(If a surface is not wired for Collector today, the test must still drive the real activation path that would load it and assert current fail-closed or document missing wiring as a production fix under this packet’s ambient-failure authority — do not skip with a label.)

#### 4d) Exact byte boundaries — measured, not labeled

**8 MiB snapshot (`test/collector-ledger.test.ts`) — replace the stub at :761-763:**

1. Build observe payload (review/comment body pad in **legal** evidence fields only).  
2. Calibrate with a loop/binary search on pad length until  
   `measureNormalizedBytes(pendingRecords) === COLLECTOR_SNAPSHOT_MAX_BYTES`.  
3. Assert that observe **accepts** (snapshot complete, `ledger.fatal === false`).  
4. Rebuild with one additional byte so `measureNormalizedBytes(...) === COLLECTOR_SNAPSHOT_MAX_BYTES + 1`.  
5. Assert observe throws, `ledger.fatal === true`, reason matches snapshot byte law (`src/collector-ledger.ts:721-724`).  
6. **Forbidden:** inferring pass/fail only from `COLLECTOR_SNAPSHOT_MAX_BYTES + 1` body string length; truncation helpers; asserting the constant alone.

**32 MiB receipt via real output infrastructure-failure path:**

Primary home: `test/collector-role.test.ts` (in-process Pi) and/or a receipt unit that still drives output execution. Requirements:

1. Legal-field padding only (rationale / evidence body fields already on the ledger — not harness backdoors, not stripping JSON keys).  
2. Calibrate so  
   `bytes = Buffer.byteLength(JSON.stringify(receipt), "utf8")`  
   is driven through the same serialization `buildCollectorReceipt` uses at `src/collector-receipt.ts:748-753`.  
3. **Exact max:** construct ledger + output args such that the serialized receipt is **exactly** `COLLECTOR_RECEIPT_MAX_BYTES` → accept (`fatal === false`, receipt returned / output accepted).  
4. **Exact max+1:** same construction + 1 UTF-8 byte → must pass through:  
   - `ak_collector_output` **execute** (not batch schema deny)  
   - `buildCollectorReceipt` size check → `ledger.latchFatal(...)`  
   - Collector role `hostActions.failInfrastructure` path  
   - session **nonzero exit**, **no accepted receipt**, GitHub side effects appropriate to fixture (no extra creates)  
5. **Forbidden:** only calling `buildCollectorReceipt` and catching throw without role infrastructure path; growing observe until some ledger label hits 32 MiB; asserting `COLLECTOR_RECEIPT_MAX_BYTES === 32*1024*1024` as the test body; escape hatches / “infeasible” skips.

Calibration approach (apply detail): pad a single legal string field on a minimal valid receipt fixture; measure `JSON.stringify` byte length; adjust pad to hit `MAX` and `MAX+1` exactly (account for JSON escaping: prefer ASCII safe pad chars). Keep fixture otherwise minimal so calibration is stable.

---

### Out of scope / non-goals

- Soul, orchestrator, manifest JSON schema package path, reviewer/judge roles  
- Raising limits, amending `c7ee3b5`, relaxing decoy policy  
- Broad embed-set redesign beyond leg/report ownership  
- Independent request-marker / `leg=` parser  
- Parallel validators or parity-guard dual oracles  
- SnapshotId stability under identical wall clock (only touch if a new test unavoidably collides; prefer clock advance in fixtures)

---

## Apply-phase execution order

1. Add `src/collector-tool-schemas.ts` owner + red tests for F1 matrix, registered-schema inspection, and each isolated real-Pi invalid output row (expect red on `c7ee3b5`).  
2. Wire role registration, `collectorToolArgumentsValid`, and `parseCollectorOutputCandidate` to the owner; delete divergent checkers. Turn F1 green.  
3. Add red two-leg missing contamination + per-decoy missing/unavailable tests.  
4. Fix `collectMissingProofRefs` + missing/unavailable bind paths via attempt-marker join and allowed-class rejection. Turn F2 green.  
5. Add every concrete F3 test (separate rows). Fix production only if a row reveals a true residual bug.  
6. Replace 8 MiB stub and implement measured 8/32 MiB exact boundaries through the real seams (32 MiB via output execute → latchFatal → failInfrastructure).  
7. Self-check working tree contains only authorized deltas.  
8. Gates:  
   - `npm run typecheck`  
   - hermetic full suite: `HOME=$(mktemp -d) npm test`  
   - focused real-Pi collector schema/batch probes (every sole invalid output row + sibling + controls)  
   - `git diff --check`  
9. Create **one new forward commit** (no amend), title `fix(collector): …`, body listing root causes and findings adopted/rejected.  
10. Confirm new HEAD is a strict descendant of start HEAD.  
11. Obtain **fresh independent Reviewer receipt** over full Collector range `c5f75b6...<new HEAD>` and return it with the apply report. Convergence remains barred until that review passes.

---

## Refusal triggers (apply)

- Packet/authority conflict (e.g. order to preserve non-qualifying unavailable extras) → `refused` with evidence; no empty commit.  
- Cannot hit exact `MAX`/`MAX+1` UTF-8 serialization through legal fields and the real output infrastructure path after documented calibration attempts → `refused` with measured evidence; do not fake boundaries from constants or builder-only throws.  
- Partial adoption only → `refused` (optionally with commitSha if a forward commit landed), listing what remains red.

---

## Success criteria

- **F1:** Shared TypeBox owner is the sole arg contract; registered Pi schemas, batch gate, and receipt parse all use it; every isolated malformed output row denies at finalized-batch with fatal latch and zero GitHub; valid missing/unavailable controls are schema-allowed.  
- **F2:** Two-leg missing shows no cross-leg contamination; each missing/unavailable decoy fails alone; clean same-leg cases bind leg+report refs to qualifying same-leg proof only; no parallel marker parser introduced.  
- **F3:** Every named concrete counterexample exists and passes; exact `measureNormalizedBytes == 8 MiB` accept and `+1` fatal; exact receipt JSON UTF-8 `== 32 MiB` accept and `+1` through `ak_collector_output` → `latchFatal` → role infrastructure-failure (nonzero, no receipt).  
- Typecheck + hermetic full suite pass; diff check clean; single forward commit; fresh full-range Reviewer receipt supplied.
