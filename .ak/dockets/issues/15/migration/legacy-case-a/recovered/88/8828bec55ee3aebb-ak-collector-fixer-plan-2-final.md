# Fixer plan 2 (final) — Collector residual defects on `c7ee3b5`

**Phase:** plan only — no code, test, doc, or Git mutation.  
**HEAD:** `c7ee3b5` (`c7ee3b56597470b273603a214abcc65ced6c1182`)  
**Authority:** Collector v1 + v2 + v3 addendum; Judge repair packet 2; corrections in `/tmp/ak-collector-fixer-plan-2-corrections.md` and `/tmp/ak-collector-fixer-plan-2-corrections-final.md` are incorporated here as binding plan law.  
**Scope:** three residual findings only. Do not reopen completed six-defect work except where these findings force a shared owning-seam fix.  
**This document is the sole controlling apply plan.**

---

## Confirmed residual defects (live code + probes)

### F1 — Three divergent argument contracts

| Owner today | Location | Defect |
| --- | --- | --- |
| Registered TypeBox | `src/collector-role.ts:50-85` | `unavailableScope` optional on every status; rationale only `minLength:1` (whitespace-only passes) |
| Batch classifier | `src/collector-ledger.ts:169-236` | observe `arguments === undefined` allowed; output ignores unknown leg keys and does not validate `unavailableScope` |
| Receipt parser | `src/collector-receipt.ts:94-160` | status-conditional scope; unknown keys rejected; trim-nonblank rationale |

Live consequence: sole output calls with extra leg fields, invalid/misplaced scope, and related malformed shapes classify `allow:true` at finalized-batch / `message_end`, so receipt never sees them as schema-invalid.

Existing real-Pi coverage stops at sole schema-invalid **observe** and valid+schema-invalid **wait** (`test/collector-role.test.ts` ~699-753). Sole/sibling **output** schema-invalid rows are absent.

### F2 — Receipt ref leg ownership broken

`CollectorRequestAttempt` already owns `marker`, `legId`, `commentEvidenceId`, `snapshotId`, `recoverySnapshotId` (`src/collector-ledger.ts:58-71`).

- `collectMissingProofRefs` (`src/collector-receipt.ts:327-375`) adds **every** requester `issue_comment` whose body includes the substring `ak-collector:v1` to **every** missing leg. Two-leg probe (request only `a`, both legs missing) contaminated leg `b` with leg `a`'s `commentEvidenceId`.
- Unavailable path (`src/collector-receipt.ts:490-541`) only rejects wrong-author decoys, then does `boundRefs = proof ∪ remaining evidenceRefs`, preserving wrong-leg requester markers, after-window noise, and dangling PR/snapshot ids.

### F3 — Binding tests are labels, not measured counterexamples

| Claimed coverage | Actual |
| --- | --- |
| `test/collector-ledger.test.ts:761-763` “max accept, max+1 fail” | Only oversized body; never measures `measureNormalizedBytes === 8 MiB` or `=== 8 MiB+1` |
| `test/collector-receipt.test.ts:890-928` “receipt overflow” | Grows observe ledger materialization; never hits `src/collector-receipt.ts:748-753` or `ak_collector_output` → `latchFatal` → role `failInfrastructure` |
| Two-leg ownership, per-decoy missing/unavailable, real-Pi sole/sibling invalid **output**, v3 before-deadline→after-deadline terminal edit, separate timestamp-less state vs text, separate review edit/dismiss/disappearance, required-tool **absence**, each ambient surface, separate ID-collision rows | Absent |

Green 169/169 does **not** cover the above.

---

## Repair principles (mandatory)

1. **Red tests first**, then minimal owning-seam production fix.
2. **One shared TypeBox schema owner — mandatory.** No second key list, no parallel marker parser, no parity-guard dual validator, no fallback shape checker.
3. **Leg ownership is an invariant** at the receipt/attempt seam: join requester comments to recorded attempts by exact `attempt.marker`; auto-link only the latest relevant same-leg attempt proof; reject wrong-leg / status-non-qualifying model refs fail-closed for **both** missing and unavailable.
4. **Do not weaken AC** — no assertion relaxation, no decoy-preserving soft paths, no raising byte limits.
5. **Avoid the prior failed method family** — tighten batch-classification and missing auto-link seams; do not add a parallel filter beside them.
6. **Exact independently calibrated boundaries** — construct and **measure** real payloads at `== MAX` and `== MAX+1` for both 8 MiB and 32 MiB laws; never infer a boundary from source constants, single-byte body guesses, or oversized approximations.

---

## Finding 1 — Singular TypeBox schema owner + finalized-batch match

### 1.1 New leaf owner: `src/collector-tool-schemas.ts`

This module is the **only** Collector tool-argument contract. Export:

```ts
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { COLLECTOR_ELIGIBILITY_MS } from "./collector-evidence.ts";
import {
  COLLECTOR_OBSERVE_TOOL,
  COLLECTOR_OUTPUT_TOOL,
  COLLECTOR_REQUEST_TOOL,
  COLLECTOR_WAIT_TOOL,
} from "./collector-ledger.ts"; // or local name constants to avoid cycles — see note

// Nonblank = contains a non-whitespace character (multiline OK).
// FORBIDDEN: anchored "^.*\\S.*$" (rejects "line1\\nline2").
// REQUIRED: unanchored "\\S" (or equivalent TypeBox non-whitespace predicate).
const nonBlankString = Type.String({ minLength: 1, pattern: "\\S" });
const nonEmptyId = Type.String({ minLength: 1 });
const evidenceRefsSchema = Type.Array(nonEmptyId, { minItems: 1 });

export const collectorObserveArgsSchema = Type.Object(
  {},
  { additionalProperties: false },
);

export const collectorRequestArgsSchema = Type.Object(
  { legId: nonEmptyId, snapshotId: nonEmptyId },
  { additionalProperties: false },
);

export const collectorWaitArgsSchema = Type.Object(
  {
    durationMs: Type.Integer({
      minimum: 1,
      maximum: COLLECTOR_ELIGIBILITY_MS, // 900_000
    }),
  },
  { additionalProperties: false },
);

const validLegSchema = Type.Object(
  {
    legId: nonEmptyId,
    status: Type.Literal("valid"),
    rationale: nonBlankString,
    evidenceRefs: evidenceRefsSchema,
  },
  { additionalProperties: false },
);

const missingLegSchema = Type.Object(
  {
    legId: nonEmptyId,
    status: Type.Literal("missing"),
    rationale: nonBlankString,
    evidenceRefs: evidenceRefsSchema,
  },
  { additionalProperties: false },
);

const unavailableLegSchema = Type.Object(
  {
    legId: nonEmptyId,
    status: Type.Literal("unavailable"),
    rationale: nonBlankString,
    evidenceRefs: evidenceRefsSchema,
    unavailableScope: Type.Union([
      Type.Literal("target"),
      Type.Literal("global"),
    ]),
  },
  { additionalProperties: false },
);

export const collectorOutputLegSchema = Type.Union([
  validLegSchema,
  missingLegSchema,
  unavailableLegSchema,
]);

export const collectorOutputArgsSchema = Type.Object(
  { legs: Type.Array(collectorOutputLegSchema, { minItems: 1 }) },
  { additionalProperties: false },
);

export type CollectorObserveArgs = Static<typeof collectorObserveArgsSchema>;
export type CollectorRequestArgs = Static<typeof collectorRequestArgsSchema>;
export type CollectorWaitArgs = Static<typeof collectorWaitArgsSchema>;
export type CollectorOutputArgs = Static<typeof collectorOutputArgsSchema>;

/** Sole shared Check entry. No hand-written key lists. */
export function collectorToolArgumentsValid(
  name: string,
  args: unknown,
): boolean {
  if (name === COLLECTOR_OBSERVE_TOOL) {
    // Sole residual raw-envelope rule: observe must actually carry {}.
    // Reject undefined/null before Check (TypeBox empty-object may not).
    if (args === undefined || args === null) return false;
    return Value.Check(collectorObserveArgsSchema, args);
  }
  if (name === COLLECTOR_REQUEST_TOOL) {
    return Value.Check(collectorRequestArgsSchema, args);
  }
  if (name === COLLECTOR_WAIT_TOOL) {
    return Value.Check(collectorWaitArgsSchema, args);
  }
  if (name === COLLECTOR_OUTPUT_TOOL) {
    return Value.Check(collectorOutputArgsSchema, args);
  }
  return false;
}

export function parseCollectorOutputArgs(raw: unknown): CollectorOutputArgs {
  if (!Value.Check(collectorOutputArgsSchema, raw)) {
    throw new Error("Collector output arguments failed schema validation");
  }
  return raw as CollectorOutputArgs;
}
```

**Cycle note (apply detail):** if importing tool name constants from `collector-ledger.ts` creates a cycle, keep the four name string literals in the schema module (or a tiny `collector-tool-names.ts`) and have ledger re-export them. Do **not** split validators to break the cycle.

**Verified locally during planning:** TypeBox `pattern: "\\S"` accepts `"line1\nline2"` and rejects whitespace-only; `pattern: "^.*\\S.*$"` rejects multiline. Discriminated union rejects scope-on-valid, unavailable-without-scope, unknown fields, empty refs.

### 1.2 Wire three consumers — delete divergent checkers

| Consumer | Change |
| --- | --- |
| `src/collector-role.ts` | Delete local `observeSchema` / `requestSchema` / `waitSchema` / `outputLegSchema` / `outputSchema`. Register tools with the shared schemas. `Static<>` types come from the owner. |
| `src/collector-ledger.ts` | Replace hand-written `collectorToolArgumentsValid` body with a re-export or thin call into the schema owner. **No** residual key allowlists. Keep classify/evaluateBatch/latchFatal behavior: schema-invalid → illegal → `evaluateBatch` deny → `latchFatal`; `message_end` sets `exitCode=1` without execute. |
| `src/collector-receipt.ts` `parseCollectorOutputCandidate` | Call `parseCollectorOutputArgs` / `Value.Check` on the shared output schema only; map success → `CollectorOutputCandidate`. Delete hand-rolled key/scope loops. No second acceptance rule (trim is not a parallel gate; schema already enforces nonblank via `\\S`). |

**Forbidden after this change:**

- any second key list in ledger or receipt
- any parity guard comparing two validators
- any fallback validator if TypeBox Check fails
- optional-scope-on-all-status object shape
- anchored nonblank patterns that reject multiline rationales

### 1.3 F1 tests

#### A. Mechanical registered-schema inspection (real in-process Pi)

In `test/collector-role.test.ts`, after Collector activation via the real extension:

1. `const tools = session.extensionRunner` / `pi.getAllTools()` (same surface the role uses).
2. For each of `ak_collector_observe|request|wait|output`, read `tool.parameters`.
3. Assert structural equality with the shared owner schemas (deep equal on JSON-schema shape, or reference equality if the same object is registered).
4. Assert output leg schema is a status union: `unavailableScope` required only under `status:"unavailable"`; absent under `valid`/`missing`; `additionalProperties: false` on observe/request/wait/output and each leg variant.

#### B. Unit matrix via shared Check only (no dual oracle)

In `test/collector-ledger.test.ts` (and receipt parse as the same Check→throw path):

| # | Fixture | Expect |
| --- | --- | --- |
| 1 | observe `arguments === undefined` | reject |
| 2 | observe `arguments === null` | reject |
| 3 | observe `{}` | allow |
| 4 | observe `{ extra: true }` | reject |
| 5 | output unknown top-level field | reject |
| 6 | output leg unknown field | reject |
| 7 | unavailable missing `unavailableScope` | reject |
| 8 | unavailable invalid scope | reject |
| 9 | valid + `unavailableScope` | reject |
| 10 | missing + `unavailableScope` | reject |
| 11 | blank / whitespace-only rationale (`""`, `"   "`, `"\\n\\t"`) | reject |
| 12 | empty `evidenceRefs` | reject |
| 13 | well-formed valid | allow |
| 14 | well-formed missing | allow |
| 15 | well-formed unavailable (`target` and `global`) | allow |
| 16 | **multiline nonblank control** `rationale: "line1\\nline2 terminal"` | **allow** (registration, `Value.Check`, and receipt parse must all accept) |

Expected allow/deny comes **only** from the shared schema owner.

#### C. Real-Pi assistant turns — one malformation per session

In `test/collector-role.test.ts`, ordered with the existing batch matrix. **One session per row.**

**Sole invalid output** → `exitCode === 1`, provider may run the assistant turn, **every GitHub counter === 0** (`pull`, `reviews`, `issueComments`, `reviewComments`, `createComment` as exposed by fake transport):

1. unknown leg field  
2. unavailable missing scope  
3. unavailable invalid scope  
4. scope on valid  
5. scope on missing  
6. blank rationale  
7. empty evidenceRefs  
8. unknown top-level field  

**Valid operational + invalid output sibling** → fatal, every GitHub counter === 0:

9. good observe `{}` + output with unknown leg field  
10. good observe `{}` + output with unavailable missing scope  

**Controls** (schema is not merely over-rejecting):

11. well-formed unavailable output args are **not** rejected at batch as schema-invalid (batch-allow once a prior completed operational/snapshot exists; downstream evidence failure is OK)  
12. well-formed missing output args likewise schema-allowed  
13. multiline nonblank rationale control is schema-allowed at the registered-tool / batch seam  

Latch behavior unchanged: schema-invalid → `message_end` rejection + `latchFatal` + no tool execute side effects.

---

## Finding 2 — Leg-owned receipt refs (attempt join only)

### 2.1 No independent request-marker parser

**Do not** add a `<!-- ak-collector:v1 … -->` / `leg=` parser or parallel leg classifier. Marker bytes are created only by `buildCollectorRequestMarker` (`src/collector-github.ts:457-463`). Ownership flows exclusively from `CollectorRequestAttempt` fields already on the ledger.

### 2.2 Canonical “latest relevant” attempt (mechanical)

Define once at the receipt/attempt seam and use for missing auto-link:

```
attempts = ledger.requestAttempts()           // append-only chronological order
sameLeg  = attempts.filter(a => a.legId === L)

attemptIsAutoLinkEligible(a):
  a.status ∈ {"succeeded", "recovered"}
  AND (
    a.commentEvidenceId is string
    OR a.recoverySnapshotId is string
  )

latestRelevant(L) =
  the last element of sameLeg that satisfies attemptIsAutoLinkEligible
  (array order = canonical ledger ordering; no startedAt re-sort)
```

If none eligible → no attempt-proof auto-link (final snapshot / expected-author material may still apply).

**Auto-link set from latestRelevant (missing only):**

- `latest.commentEvidenceId` if present  
- `latest.snapshotId`  
- `latest.recoverySnapshotId` if present  

**Not auto-linked:** any older same-leg attempt’s comment/snapshot/recovery, any other leg’s attempt fields, any body that merely contains the substring `ak-collector:v1` without joining a same-leg attempt marker.

### 2.3 Join authenticated requester comments to attempts

Replace the broadcast `.includes("ak-collector:v1")` with:

```
for each issue_comment record where authorLogin === ledger.requesterLogin:
  for each attempt where attempt.legId === L
    and typeof record.body === "string"
    and record.body.includes(attempt.marker):   // exact recorded marker string
      record is same-leg attempt-associated proof for L
```

Only markers recorded on attempts participate. Wrong-leg markers never enter leg `L` because `attempt.legId` filters first.

### 2.4 Status-specific allowed-ref predicates (one policy, no ambiguity)

#### Missing — ref `R` is allowed for leg `L` iff one of:

| Class | Predicate |
| --- | --- |
| Final snapshot | `R === finalSnapshot.snapshotId` |
| Final transport facts | `R` is evidence on final snapshot with `kind ∈ {pull_request, authenticated_user}` |
| Expected-author material | evidence `kind ∈ {review, review_comment, issue_comment}` AND `authorLogin ∈ expected(L)` — **any** `windowRelation` (before/within/after/uncertain). Missing preserves late/uncertain same-author material; it does not treat it as unavailable proof. |
| Same-leg attempt-owned proof | exists attempt with `attempt.legId === L` AND `R ∈ {attempt.commentEvidenceId, attempt.snapshotId, attempt.recoverySnapshotId}` (model may cite any same-leg attempt-owned id; **auto-link** still adds only `latestRelevant`) |
| Same-leg marker-joined requester comment | issue_comment joined via §2.3 to an attempt with `legId === L` |

**Not allowed for missing:** other leg’s attempt comment/snapshot/recovery; requester comments that do not join any same-leg attempt marker; dangling ids absent from ledger; unrelated third-party authors.

**Transport policy (single choice):** transport failures never become leg or terminal-report refs. They remain on receipt-root `requestAttempts` / internal failure list only. No “explicit global diagnostic” leg-ref path.

#### Unavailable — every model-cited ref must independently qualify

Ref `R` is allowed for unavailable leg `L` with declared scope `S` iff:

```
record = ledger.getEvidence(R) is defined
AND qualifiesUnavailableEvidence({
      record,
      expected: expected(L),
      activationTime, deadlineTime,
      scope: S,
      finalSnapshot,
    }).ok === true
```

i.e. expected author, windowRelation ∈ `{before, within}`, and scope membership (global vs final-snapshot-resident).  

**Reject all of:** wrong-leg requester markers/comments, wrong-leg author evidence, after/uncertain material, dangling snapshot ids, dangling PR ids, wrong-author, any non-qualifying extra.  

**Delete** `boundRefs = proof ∪ remaining evidenceRefs`. Bind leg + terminal-report `evidenceRefs` to **qualifying proof only** (stable unique order: proof encounter order).

### 2.5 Production edits

**`collectMissingProofRefs` (`src/collector-receipt.ts:327-375`):**

1. Always include `finalSnapshot.snapshotId` and final-snapshot PR/user facts.  
2. Include all expected-author review/review_comment/issue_comment material for `L` (preservation).  
3. Join requester comments only via §2.3 (attempt.marker + attempt.legId).  
4. Auto-link **only** `latestRelevant(L)` attempt proof fields (§2.2).  
5. Remove the broadcast `body.includes("ak-collector:v1")` loop.

**Missing branch in `buildCollectorReceipt`:**

1. `proofRefs = collectMissingProofRefs(L)`.  
2. For every model-cited ref: if not allowed under missing predicate §2.4 → **fail closed**.  
3. Bind leg + matching terminal-report refs to `unique(proofRefs ∪ qualifying model cites)`.  
4. Still require final complete snapshot citation / observation law.

**Unavailable branch:**

1. Require scope (schema already guarantees; keep defensive check if desired).  
2. Every model-cited ref must pass unavailable predicate §2.4; else fail closed with a decoy/non-qualifying message.  
3. Bind leg + terminal-report refs to qualifying proof only.  
4. Keep full `requestAttempts` at receipt root; never place another leg’s comment/snapshots/recovery into a leg or terminal report.

### 2.6 F2 tests — one decoy per counterexample

All in `test/collector-receipt.test.ts` unless noted. Every case asserts **both** the leg’s `evidenceRefs` **and** the matching `terminal-fact` report’s `evidenceRefs`.

#### Missing — auto-link contamination (two-leg)

- Manifest legs `a`,`b` (both request-capable).  
- Observe → request only `a` → re-observe past cutoff → both legs `missing` with minimal model cites (final snapshot only).  
- Assert: `a` leg+report contain `a.commentEvidenceId` and final snapshot; `b` leg+report **do not** contain `a.commentEvidenceId` / `a.snapshotId` / `a.recoverySnapshotId`; `bContaminated === false`.

#### Missing — latestRelevant two-attempt same-leg counterexample

- Two succeeded requests on leg `a` at different HEADs (observe head A → request a → observe head B → request a).  
- Emit `a` missing after cutoff.  
- Assert auto-linked attempt proof includes **only** the later attempt’s `commentEvidenceId` / `snapshotId` / `recoverySnapshotId`; older attempt’s comment/snapshot/recovery are **not** present unless the model explicitly cited them (default fixture does not cite them).  
- This locks §2.2.

#### Missing — candidate-ref decoys (two-leg), **one decoy each**

| ID | Model cites on leg `b` (plus final snapshot if needed) | Expect |
| --- | --- | --- |
| M1 | cross-leg `a.commentEvidenceId` | throw |
| M2a | cross-leg `a.snapshotId` only | throw |
| M2b | cross-leg `a.recoverySnapshotId` only (fixture must create recovered attempt on `a`) | throw |
| M3a | dangling evidence id absent from ledger | throw |
| M3b | dangling snapshot id absent from ledger | throw |
| M-clean | only qualifying same-leg / final snapshot / expected-author material | accept; leg+report ⊆ allowed missing classes; no cross-leg ids |

Slash-separated “snapshot/recovery” or “evidence/snapshot” fixtures are **not** acceptable.

#### Unavailable — decoys (two-leg), **one decoy each**

Fixture baseline: leg `b` has a qualifying before/within same-author decline under declared scope.

| ID | Model cites on leg `b` | Expect |
| --- | --- | --- |
| U1 | cross-leg `a` requester request comment/marker evidence | throw |
| U2 | cross-leg `a` author decline/evidence | throw |
| U3 | after-window same-author evidence (sole or as extra beside good proof) | throw |
| U4 | unrelated PR evidence id | throw |
| U5 | unrelated snapshot id | throw |
| U-clean | only qualifying same-leg before/within proof under declared scope | accept; leg+report refs === qualifying proof only |

Do **not** pack U1–U5 into one call.

---

## Finding 3 — Concrete binding counterexamples

Each row is a named executable test. Production changes only if a row exposes a true residual bug under authority; otherwise the test locks current correct behavior.

### 3.1 Evidence / window / version retention

Homes: `test/collector-receipt.test.ts` and/or `test/collector-ledger.test.ts` using `createFakeGitHubTransport` + mutable `transport.state.*` across observes.

| Test | Exact construction | Assertion |
| --- | --- | --- |
| **v3 before-deadline comment → terminal edit after deadline** | (1) Activate at `T0`. (2) Observe: issue_comment stable id `C`, body `"still looking"`, `created_at=updated_at=T0+1m` (before deadline). (3) Advance mono/wall past deadline (`+16m`). (4) Observe again: same comment id `C`, body `"I will not review this PR"`, `updated_at=T0+16m` (after deadline), `created_at` unchanged. | Both immutable versions retained in ledger evidence; early version `windowRelation ∈ {before,within}`; terminal edited version `windowRelation === "after"` (or uncertain only if timestamps stripped — not in this row). Unavailable citing **only** the after-deadline terminal text fails. Missing after cutoff succeeds and may preserve both versions in proof refs. This is the authority-v3 case, not a single-edit label. |
| **timestamp-less state mutation** | Review stable id `R` observe1: `state=APPROVED`, `submitted_at` set. Observe2: same id, `state=DISMISSED`, **no** update/state timestamp field (`submittedAt` reused or cleared per normalizer so history step forces `authoritativeTime = null` on later version). | Later version `windowRelation === "uncertain"`; both state forks retained; uncertain cannot sole-prove valid; no backdate to first `submitted_at` for the later version. |
| **timestamp-less text mutation** | Issue or review comment stable id `C` observe1: body v1 with timestamps. Observe2: body v2 with `updated_at`/`created_at` null/missing so authoritativeTime null. | Later text version `windowRelation === "uncertain"`; both bodies retained; uncertain text cannot sole-prove unavailable. |
| **review edit retention** | Qualifying COMMENTED/APPROVED review on head H; later observe edits body (new version). | Prior substantive review variant remains in `allEvidence` / historical report variants (`collectSubstantiveReviewReports`); valid rules use final-snapshot current version policy already in code. |
| **review dismiss retention** | Observe1: `APPROVED` qualifying. Observe2: same review id `DISMISSED`. | DISMISSED cannot sole-qualify valid; prior APPROVED version retained in ledger history/report variants. |
| **review disappearance retention** | Observe1: review present with inline comments. Observe2: review absent from list (delete). | Prior snapshot membership and historical evidence ids retained; absence does not erase prior evidence records; report variants from earlier snapshot membership remain available. |

### 3.2 ID collisions at `buildCollectorReceipt`

Do **not** rely on SHA-256 accidents. Use a **ledger facade** implementing `CollectorLedger` by delegating to a real ledger, then overriding only the methods needed so collision is first visible inside `buildCollectorReceipt` (not at observe store):

| Test | Construction | Assertion |
| --- | --- | --- |
| duplicate evidenceId | After a normal observe, facade `allEvidence()` returns `[...real, { ...real[0], evidenceId: real[0].evidenceId, versionId: "forged-dup" }]` and `getEvidence` resolves that id; build receipt with refs that embed both | `buildCollectorReceipt` throws `/evidenceId collision/i` |
| duplicate snapshotId | Facade `allSnapshots()` returns two snapshots sharing `snapshotId` while `getSnapshot` / latest id still resolve; force both into embed set (e.g. both cited via attempt.snapshotId override or by including both in filtered embed path) | throws `/snapshotId collision/i` |
| cross-namespace ambiguous id | Facade makes one evidence record and one snapshot share the same string id; cite that id from a leg ref | throws `/ambiguous|namespaces/i` |

Facade is test-local (no production test hook, no `NODE_ENV` branch).

### 3.3 Startup / ambient fail-closed via real in-process Pi

Home: `test/collector-role.test.ts` (+ minimal harness option pass-through in `test/helpers/pi-test-harness.ts` if needed). **No production test hooks** in `src/`.

Extend `withInProcessPi` / `DefaultResourceLoader` options **only in the test helper** so tests can set real ResourceLoader knobs currently hard-coded off (`noSkills: true`, `noContextFiles: true`, no append override). That is harness surface, not Collector production code.

Every row asserts: **provider completion count === 0** (or provider never invoked for startup-time failures), **every GitHub counter === 0**, nonzero `process.exitCode` / session failure.

| Test | Exact executable mechanics | When it fires |
| --- | --- | --- |
| **required-tool absence** | Earlier inline `extensionFactories` entry monkey-patches the real `ExtensionAPI` **before** Collector `session_start`: save `const orig = pi.registerTool.bind(pi)`; replace `pi.registerTool` so that when `tool.name === COLLECTOR_WAIT_TOOL` (pick one required name), the registration is dropped (no-op); all other tools call `orig(tool)`. Collector activate still runs `registerTools()` then `getAllTools()` missing-check (`src/collector-role.ts:599-604`). | `session_start` / activate → `latchStartupFailure` → exit 1; no prompt; provider unused; GitHub 0. **Not** name-collision (collision test already exists). |
| **ambient skills** | Harness: `noSkills: false` + `additionalSkillPaths: [dir]` where `dir` contains a minimal valid skill (`SKILL.md` / Pi skill layout with nonempty body), **or** `skillsOverride: () => ({ skills: [{ name, description, filePath, baseDir, source, disableModelInvocation: false }] })` on `DefaultResourceLoader`. Prompt once so `before_agent_start` runs. Real event carries `systemPromptOptions.skills.length > 0` (`src/collector-role.ts:256-263`). | `failInfrastructure` via `ledger.latchFatal("…ambient skills…")`; exit 1; GitHub 0; provider request count 0 if abort precedes provider (assert the harness’s faux request counter). |
| **ambient contextFiles** | Harness: `noContextFiles: false`; write nonempty `AGENTS.md` (or `CLAUDE.md`) into session `cwd` so Pi’s real context-file loader populates `systemPromptOptions.contextFiles` with ≥1 `{path, content}` (`src/collector-role.ts:264-270`). Prompt once. | same fail-closed shape; GitHub 0 |
| **ambient appendSystemPrompt** | Harness: `appendSystemPromptOverride: () => ["AMBIENT_APPEND_BLOCK"]` (or `appendSystemPrompt: ["…"]` if loader option accepted). Real `before_agent_start` sees nonempty string `systemPromptOptions.appendSystemPrompt` (`src/collector-role.ts:271-280`). Prompt once. | same fail-closed shape; GitHub 0 |
| **ambient commands** | Earlier inline extension calls real `pi.registerCommand("skill-ambient", { …minimal RegisteredCommand fields… })` **before** Collector activate. Activate reads `pi.getCommands?.()` and filters name matching `/skill|prompt|^template/` (`src/collector-role.ts:575-588`). | startup fail-closed before tools/transport use; GitHub 0; provider unused |

If a harness knob is missing today, add it to `test/helpers/pi-test-harness.ts` as an optional pass-through to `DefaultResourceLoader` — still not a production hook.

### 3.4 Exact byte boundaries — independently calibrated

#### 8 MiB snapshot — replace stub at `test/collector-ledger.test.ts:761-763`

Law site: `src/collector-ledger.ts` (~721-724) via `measureNormalizedBytes` (`src/collector-evidence.ts:392-394` = `Buffer.byteLength(JSON.stringify(records), "utf8")`). Accept when `bytes <= MAX`; fatal when `bytes > MAX`.

**Procedure (do not assume 1 source byte ⇒ 1 normalized byte):**

1. Build a minimal observe fixture (user + OPEN PR + one review).  
2. Pad **only** a legal evidence field (`review.body`) with an ASCII pad char (e.g. `x`) to avoid JSON escape inflation.  
3. **Calibrate independently:** binary-search pad length; for each candidate, build the same normalized records the observe path would measure (either call a test-visible helper that runs normalize+measure, or call `ledger.observe` inside a try and adjust). Assert the measured value, not the pad length.  
4. Find padA where `measureNormalizedBytes(records) === COLLECTOR_SNAPSHOT_MAX_BYTES` (exactly `8 * 1024 * 1024`).  
5. `await ledger.observe(...)` with padA → accept; `ledger.fatal === false`; snapshot complete; `snapshot.normalizedByteLength === MAX`.  
6. Find padB where measured `=== MAX + 1` (re-calibrate; do not assume `padA + 1`).  
7. observe with padB → throws; `ledger.fatal === true`; message matches snapshot byte law.  

**Forbidden:** inferring from `COLLECTOR_SNAPSHOT_MAX_BYTES + 1` body string length alone; truncation helpers; constant-only asserts.

#### 32 MiB receipt — real output infrastructure-failure path

Law site: `src/collector-receipt.ts:748-753`  
`bytes = Buffer.byteLength(JSON.stringify(receipt), "utf8")`; `> MAX` → `ledger.latchFatal(...)`.

**Constraints (all mandatory):**

- Each snapshot remains `<= 8 MiB` normalized.  
- Ledger `materializationByteLength()` remains `<= 32 MiB` through observe/request (no observe-growth proxy for this test).  
- Pad **receipt-only legal fields** that are not fully counted in ledger materialization the same way — primary: output `rationale` (copied into leg rationale and, for missing/unavailable, terminal-report `report`). Prefer ASCII pad.  
- Calibrate with the **same** `JSON.stringify(receipt)` serialization the production checker uses.  
- Independently find pads where measured receipt bytes are **exactly** `COLLECTOR_RECEIPT_MAX_BYTES` and **exactly** `MAX+1`. Do not assume one added rationale character ⇒ one receipt byte (rationale may appear twice; JSON escaping may apply).

**Calibration home (builder allowed only as a measuring aid):**

1. Build minimal post-cutoff ledger: one leg, final snapshot, enough evidence for a legal `missing` or `unavailable` output.  
2. Function `measureReceipt(rationalePad: string): number` calling `buildCollectorReceipt` inside a cloned/fresh ledger state **or** computing the receipt object identically and measuring without latching when used purely as a pure measure helper. Prefer: binary-search pad on a non-fatal deep-copied construction path; final assertions use real builders/role.  
3. Lock `padMax` and `padMax1` with asserted measured sizes.

**Exact MAX accept:**

- `buildCollectorReceipt(..., { legs: [{ ..., rationale: padMax, ... }] })` returns; `ledger.fatal === false`;  
- Optionally also drive through in-process role and assert output accepted — allowed but not a substitute for the MAX+1 role path below.

**Exact MAX+1 — role path (non-substitutable):**

Home: `test/collector-role.test.ts` in-process Pi.

1. Activate Collector with fake transport + controllable clock; complete observe (and cutoff advance if using missing).  
2. Install a **spy** around host `failInfrastructure` **without** production hooks: wrap via a test-local `createRoleRuntimeExtension` dependency pattern is not available today for collector hostActions. **Executable approach:** pass a custom extension factory that constructs Collector through `createCollectorRoleRuntime(pi, deps, { failInfrastructure: spy })` **directly** (bypass or shadow the packaged role-runtime hostActions for this one test), where `spy` records the error then rethrows/`ctx.abort()`/`process.exitCode=1` like production (`src/role-runtime.ts:99-103`).  
3. Assistant turn: sole `ak_collector_output` with calibrated `rationale: padMax1` and otherwise schema-valid legs.  
4. Assert **all** of:  
   - output tool **execute** entered (not batch schema deny)  
   - receipt size check ran → error message matches `/receipt exceeded|32/i`  
   - `ledger.fatal === true` / error `collectorFatal === true`  
   - `failInfrastructure` spy **called once**  
   - session/`process.exitCode` nonzero  
   - **no** successful output toolResult with receipt details  
   - no extra GitHub creates  

**Forbidden:**

- builder-only throw as the sole MAX+1 proof  
- observe-growth until some ledger label exceeds 32 MiB  
- asserting `COLLECTOR_RECEIPT_MAX_BYTES === 32*1024*1024` as the test body  
- escape hatches / “infeasible” skips / `and/or` ambiguous test homes  

Primary MAX+1 home is **role path** (`test/collector-role.test.ts`). Builder is calibration/MAX-accept aid only.

---

## Out of scope / non-goals

- Soul text, orchestrator, manifest JSON schema package path, reviewer/judge roles  
- Raising 8/32 MiB limits; amending `c7ee3b5`; relaxing decoy policy  
- Broad embed-set redesign beyond leg/report ownership  
- Independent request-marker / `leg=` parser  
- Parallel validators or parity-guard dual oracles  
- SnapshotId stability under identical wall clock (prefer clock.advance in fixtures if needed)

---

## Apply-phase execution order

1. **Red F1:** schema unit matrix (incl. multiline control + observe undefined), registered-schema inspection test, each isolated real-Pi invalid output row + siblings + controls.  
2. **Add** `src/collector-tool-schemas.ts`; wire role registration, ledger `collectorToolArgumentsValid`, receipt `parseCollectorOutputCandidate`; delete divergent checkers. Turn F1 green.  
3. **Red F2:** two-leg missing contamination; latestRelevant two-attempt counterexample; M1/M2a/M2b/M3a/M3b/M-clean; U1–U5/U-clean.  
4. **Fix** `collectMissingProofRefs` + missing/unavailable bind paths per §2. Turn F2 green.  
5. **Red/green F3:** every concrete row in §3.1–3.3; production fix only if a row exposes a true residual bug.  
6. **Byte seams:** replace 8 MiB stub with independently calibrated `==MAX`/`==MAX+1` observe tests; implement calibrated 32 MiB MAX accept + MAX+1 role infrastructure path.  
7. Confirm working tree contains only authorized deltas.  
8. **Gates (all required):**  
   - `npm run typecheck`  
   - hermetic full suite: `HOME=$(mktemp -d) npm test`  
   - focused real-Pi collector schema/batch probes (every sole invalid output row + siblings + controls)  
   - `git diff --check`  
9. Create **one new forward commit** (no amend), title `fix(collector): …`, body listing root causes and findings adopted/rejected.  
10. Confirm new HEAD is a strict descendant of start HEAD `c7ee3b5`.  
11. Obtain **fresh independent Reviewer receipt** over full Collector range `c5f75b6...<new HEAD>` and return it with the apply report. **Convergence remains barred until that review passes.**

---

## Refusal triggers (apply)

- Packet/authority conflict (e.g. order to preserve non-qualifying unavailable extras) → `refused` with evidence; no empty commit.  
- Cannot hit exact independently measured `MAX`/`MAX+1` through legal fields and the real output infrastructure path after documented calibration attempts → `refused` with measured evidence; do not fake boundaries.  
- Partial adoption only → `refused` (optionally with commitSha if a forward commit landed), listing what remains red.

---

## Success criteria

- **F1:** Shared TypeBox owner is the sole arg contract; Pi registration, batch `Value.Check`, and receipt parse all use it; unanchored nonblank accepts multiline; every isolated malformed output row denies at finalized-batch with fatal latch and zero GitHub; valid missing/unavailable + multiline controls are schema-allowed.  
- **F2:** Two-leg missing shows no cross-leg contamination; latestRelevant excludes older same-leg auto-link; each missing/unavailable decoy fails alone; clean cases bind leg+report refs to status-qualifying same-leg proof only; no parallel marker parser.  
- **F3:** Every named concrete counterexample exists and passes with executable fixtures; exact `measureNormalizedBytes == 8 MiB` accept and `+1` fatal; exact receipt JSON UTF-8 `== 32 MiB` accept and `+1` through `ak_collector_output` execute → size check → `ledger.latchFatal` → role `failInfrastructure` (nonzero, no receipt).  
- Typecheck + hermetic full suite pass; diff check clean; single forward commit; fresh full-range Reviewer receipt supplied over `c5f75b6...<new HEAD>`.
