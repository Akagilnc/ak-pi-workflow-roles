# Approved current-head six-root repair

# Revised plan: six current-head Collector seams at 6604a73

**HEAD (audited clean):** `6604a733886dfb5d074f558963e20e01e587aa6d`  
**Phase:** plan only — no code, test, doc, or Git mutation in this phase.  
**Constraints (hard):**
- Repair only at existing owners named below.
- **No Collector Soul diff.**
- **No** new binder / classifier / recovery / cancel state machine.
- **No** parallel validator or parallel recovery path.
- **No** AC weakening, assertion deletion, or soft-pass.
- One Apply wave → one new forward commit (no amend).
- Red-first: write failing tests for each seam, then implement owner fixes, then full gate.

---

## Exact preservation gate (Apply must keep these focused current-head behaviors/tests)

Do **not** delete, relax, rename away, or replace with mocks:

| ID | Keep |
|---|---|
| **R1** | Valid precedence: terminal `missing`/`unavailable` lose to final exact-head qualifying valid (`test/collector-receipt.test.ts` R1 cases). |
| **R2** | Same-leg valid citation/rebinding; cross-leg cites rejected (`test/collector-receipt.test.ts` R2). |
| **R3 (correct portion)** | Stale H1 evidence still present on H2 final snapshot **rejects** `unavailableScope: "target"`. Replace only the **faulty establishment-proof** positive path (`establishedHeadFor` / first-snapshot membership). |
| **R4** | Full transitive receipt embedding (every included snapshot evidence id resolved; recovery/comment proof embedding retained — `receipt full embed…`, recovery embed cases). |
| **R5** | Known-version null reuse + model-view consistency on third observe of unchanged edited review (`test/collector-ledger.test.ts` R5). |
| **R6** | Tombstoned-user handling through 6604a73 (`test/collector-github.test.ts` R6 null-user and non-null fail-closed). |
| **R7** | Outdated inline `originalLine` fallback in report location. |
| **R8** | Authenticated-user raw redaction to login+id only. |
| **R9** | PR `updatedAt` observation bracket/retry + repeated-drift fail-closed. |
| **R10** | Normalized observation-scoped pagination budget stop-before-oversize. |
| **R11** | Observe/GET abort-child cancellation (runner + ledger observe paths). |

Item 1 **preserves** the stale-H1 rejection half of R3 while **replacing** establishment-as-proof. Items 2 and 3 are **distinct** from R11 and R5 respectively.

---

## 1. Target-scope unavailability provenance

| | |
|---|---|
| **Behavior** | Delete `establishedHeadFor`. For `unavailableScope: "target"`, accept **only** `record.kind === "review"` or `"review_comment"` whose **non-null** `commitOid === targetHead`, plus existing author ∈ expectedAuthors and windowRelation ∈ {`before`,`within`}. **`issue_comment` never proves `target`** (no synthetic head binder). `global` remains author + before/within only (kind-agnostic; no HEAD check). Terminal `target` still stamps `targetSnapshotHead: targetHead` only when proof qualifies under the new rule. |
| **Owner** | `src/collector-receipt.ts` — `qualifiesUnavailableEvidence`; delete `establishedHeadFor` entirely; rewrite the headless positive case in `test/collector-receipt.test.ts` (`global unavailable covers new head; target rejects H1-established comment still on H2` ledger3 block) from accept → reject. |
| **Red** | (a) Activate/observe only on H2 with first-seen H1 `review` (`commitOid: "head-a"`, final HEAD `"head-b"`) → current `establishedHeadFor` returns H2 → `target` accepted and stamped H2. (b) Same for first-seen H1 `review_comment`. (c) Headless `issue_comment` first seen on final HEAD currently accepts `target` (ledger3). |
| **Green** | Stale `review` and stale `review_comment` (`commitOid !== targetHead`) → `target` throws. Exact-head `review` and exact-head `review_comment` (`commitOid === targetHead`) → `target` accepts. Headless `issue_comment` → `target` rejects; same evidence still accepts `global`. Prior H1-established-still-on-H2 rejection remains green under the stronger carried-HEAD rule. |
| **Scope** | Pure receipt qualification only. No Soul. No new binding framework. Do not use snapshot membership or first-observation snapshot HEAD as target proof. |

### Item 1 fixture syntax (Apply)

```ts
// Stale review first seen on H2 (targetHead = head-b)
sampleReview({
  id: 10,
  userLogin: "codexbot",
  state: "COMMENTED",
  body: "decline on old head",
  commitId: "head-a",
  submittedAt: "2024-01-01T00:11:00Z",
})

// Exact-head review
sampleReview({
  id: 11,
  userLogin: "codexbot",
  state: "COMMENTED",
  body: "decline on target head",
  commitId: "head-b",
  submittedAt: "2024-01-01T00:11:00Z",
})

// Stale review_comment
sampleReviewComment({
  id: 20,
  userLogin: "codexbot",
  body: "inline decline stale",
  commitId: "head-a",
  pullRequestReviewId: 10,
  updatedAt: "2024-01-01T00:11:00Z",
})

// Exact-head review_comment
sampleReviewComment({
  id: 21,
  userLogin: "codexbot",
  body: "inline decline target",
  commitId: "head-b",
  pullRequestReviewId: 11,
  updatedAt: "2024-01-01T00:11:00Z",
})

// Headless issue_comment — NO commitId field
sampleIssueComment({
  id: 3,
  userLogin: "codexbot",
  body: "decline on final head",
  updatedAt: "2024-01-01T00:11:00Z",
})
// target → reject; global → accept
```

Replace ledger3 positive headless-target acceptance with:

```ts
assert.throws(
  () => buildCollectorReceipt(ledger3, {
    legs: [{
      legId: "codex",
      status: "unavailable",
      rationale: "headless cannot prove target",
      evidenceRefs: [onFinal.evidenceId],
      unavailableScope: "target",
    }],
  }, clock3),
  /unavailable|scope|eligible|target/i,
);
// and keep a global acceptance assertion on the same evidence
```

---

## 2. Request-path AbortSignal / hung POST cancellation

| | |
|---|---|
| **Behavior** | Thread the **identical** tool `AbortSignal` through existing seams: role `ak_collector_request` `execute(..., signal, ...)` → `ledger.request(input, transport, clock, signal?)` → `transport.createIssueComment({ ..., signal })` → existing `createGhApiRunner` abort listener (`child.kill("SIGTERM")` + reject). Abort **throws**; leaves **no** attempt status of `rejected` / `ambiguous_loss` / success tool `details`; produces **no** late successful tool result; kills the owned POST child. Retain process-local one-shot `attemptKeys` behavior — **do not** invent retry, cancellation classification, or cancel-state fields. Existing abort rethrow in `createIssueComment` stays. |
| **Owner** | `src/collector-role.ts` (stop ignoring `_signal` on request tool) → `src/collector-ledger.ts` (`request` interface + implementation pass-through) → `src/collector-github.ts` (already accepts `signal`; wire only). Tests in `test/collector-github.test.ts` and/or `test/collector-ledger.test.ts` / role path as needed. |
| **Red** | Role binds `_signal` unused; `ledger.request` signature has no signal; POST never receives signal; hung real POST cannot cancel through request path. |
| **Green** | Abort rejects `/abort|cancel/i`; POST child PID dead; exactly one settlement; no success `details`; attempt not recorded as `rejected`/`ambiguous_loss` success path; process-local one-shot unchanged. R11 observe/GET tests remain green. |
| **Scope** | Pass-through only. No new result kinds. Do not map abort to `ambiguous_loss` or `rejected`. |

### Item 2 fixture syntax (Apply)

```ts
const script = `#!/usr/bin/env bash
set -euo pipefail
# Verify this is the POST path and record PID, then hang.
echo "$$" > "$PID_FILE"
for arg in "$@"; do
  if [[ "$arg" == "POST" ]]; then :; fi
done
# Require -X POST somewhere in argv (assert in wrapper or script):
printf '%s\n' "$@" | grep -q -- '-X' 
# simpler: scan argv
prev=""
for arg in "$@"; do
  if [[ "$prev" == "-X" && "$arg" == "POST" ]]; then
    sleep 30
    printf 'HTTP/1.1 201 Created\\r\\ncontent-type: application/json\\r\\n\\r\\n{"id":1}'
    exit 0
  fi
  prev="$arg"
done
# non-POST may serve minimal observe fixtures if going through full ledger path
exit 2
`;

const controller = new AbortController();
// pass controller.signal through registered request tool / ledger.request(..., controller.signal)
// after spawn:
controller.abort(new Error("request canceled"));
await assert.rejects(() => pending, /abort|cancel/i);
// assert PID dead; one settlement; no success details; no rejected attempt row classified from cancel
```

Concrete Apply obligations for the cancellation test:
- Use `AbortController`.
- PATH `gh` fixture verifies `-X POST`, records its PID, hangs.
- Pass `controller.signal` through the registered request tool **or** ledger `request` path that reaches `createIssueComment`.
- Assert: abort rejection; dead PID; one settlement; no success details; no `rejected` attempt from cancel.

---

## 3. After-deadline first observation must not backdate via `submitted_at`

| | |
|---|---|
| **Behavior** | Make `applyEvidenceVersionHistory(pending, prior, deadlineTime)` use **strict temporal semantics** for **new** review versions: if `firstObservedAt` is a valid ISO timestamp and `Date.parse(firstObservedAt) > deadlineTime.getTime()`, set `authoritativeTime = null` (do **not** inherit/backdate from `submittedAt`). If first observation is **equal to** or **earlier than** deadline, first-version may retain `submittedAt`. Invalid/unparseable `firstObservedAt` fails closed to `null`. **Known versions** first reuse the stored value **including null** (R5). Later distinct review versions remain `null` (existing rule). Comments keep `updated_at` rules unchanged. Ledger call site already has `deadlineTime` — pass it in. |
| **Owner** | `src/collector-evidence.ts` — `applyEvidenceVersionHistory`; update call in `src/collector-ledger.ts`; unit + receipt-path tests in `test/collector-ledger.test.ts` and `test/collector-receipt.test.ts`. |
| **Red** | Activation 00:10, deadline 00:25, first observe 00:26 of never-seen review with pre-cutoff `submittedAt` → currently `authoritativeTime = submittedAt` → before/within → can prove unavailable/valid. |
| **Green** | After-cutoff first observation → `authoritativeTime === null`, `windowRelation === "uncertain"`; receipt rejects `valid` and `unavailable` based only on that record. Exact boundary firstObservedAt `==` deadline 00:25 may retain `submittedAt`. R5 known-version null reuse still green. |
| **Scope** | Evidence history helper + call-site deadline argument only. No Soul. No comment rule change. |

### Item 3 fixture syntax (Apply)

```ts
const clock = clockAt("2024-01-01T00:10:00Z"); // activation
// deadline = activation + 15m = 2024-01-01T00:25:00Z
ledger.recordActivation(clock);
clock.advance(16 * 60 * 1000); // wall now 00:26 — first observe after cutoff

// pre-cutoff submittedAt, first seen only after deadline
sampleReview({
  id: 30,
  userLogin: "codexbot",
  state: "APPROVED",
  body: "late first sighting",
  commitId: "head-c",
  submittedAt: "2024-01-01T00:00:00Z", // pre-cutoff
})

// Evidence assertions after observe:
// authoritativeTime === null; windowRelation === "uncertain"

// Receipt-path rejection:
assert.throws(() => buildCollectorReceipt(ledger, {
  legs: [{
    legId: "codex",
    status: "unavailable",
    rationale: "late first seen cannot prove",
    evidenceRefs: [late.evidenceId],
    unavailableScope: "global",
  }],
}, clock), /unavailable|eligible|window|uncertain/i);

assert.throws(() => buildCollectorReceipt(ledger, {
  legs: [{
    legId: "codex",
    status: "valid",
    rationale: "late first seen cannot prove valid",
    evidenceRefs: [late.evidenceId],
  }],
}, clock), /valid|qualifying|window|head/i);

// Boundary equality case (separate clock run):
// activation 00:10, advance exactly 15m → firstObservedAt 00:25 == deadline
// first version may retain submittedAt
clockEq.advance(15 * 60 * 1000); // 00:25
```

Also keep a direct unit call:

```ts
applyEvidenceVersionHistory([review], [], deadlineTime);
// where review.firstObservedAt > deadline → authoritativeTime === null
// where review.firstObservedAt === deadline → authoritativeTime === submittedAt
// where firstObservedAt invalid → authoritativeTime === null
```

---

## 4. 2xx POST parse/normalization failure → ambiguous_loss + marker recovery

| | |
|---|---|
| **Behavior** | In `createIssueComment`, **only** the 2xx response parse/normalization block maps failures to existing `ambiguous_loss` (comment may already exist). Abort still throws. Non-2xx remains `rejected`. Ledger keeps existing marker recovery on later observe; POST count remains one (no repost). |
| **Owner** | `src/collector-github.ts` — `createIssueComment` 2xx branch (`parseJson` + `normalizeIssueComment` wrapped so throw → `{ kind: "ambiguous_loss", diagnostics }`). Reuse existing ledger recovery; tests in `test/collector-github.test.ts` / `test/collector-ledger.test.ts`. |
| **Red** | Malformed / truncated / required-field-missing HTTP 201 currently falls into outer catch → often `rejected` → blocks recovery / risks repost semantics. |
| **Green** | Three 2xx failure shapes → `ambiguous_loss`; 422 control → `rejected`; later observe with same-marker authenticated comment → `recovered`; POST invoked once. Abort path still throws (item 2). |
| **Scope** | Localize to 2xx parse/normalize only. Do not reclassify `ambiguousGhFailure` transport losses or abort. No parallel recovery mechanism. |

### Item 4 fixture syntax (Apply)

```ts
// Runner fixtures return:
{ status: 201, headers: {}, bodyText: "not-json{" }                    // malformed JSON
{ status: 201, headers: {}, bodyText: '{"id":1,"user":{"login":' }     // truncated JSON
{ status: 201, headers: {}, bodyText: JSON.stringify({
  // valid JSON missing required comment fields (e.g. no id / no created_at / no updated_at)
  user: { login: "collector-bot" },
  body: "x",
}) }
// non-2xx control:
{ status: 422, headers: {}, bodyText: '{"message":"validation failed"}' }

// Recovery: after ambiguous_loss, next observe surfaces marker comment; assert
// requestAttempts() status === "recovered"; createIssueComment/POST count === 1
```

---

## 5. Inline reply author ownership for report attachment

| | |
|---|---|
| **Behavior** | Filter **only report attachment** in `reviewInlineComments` with `record.authorLogin === review.authorLogin` (in addition to existing `pullRequestReviewId` match). Intruder rows remain in snapshots and `ledger.allEvidence()`. Do not drop raw ledger retention. |
| **Owner** | `src/collector-receipt.ts` — `reviewInlineComments` only. Test in `test/collector-receipt.test.ts`. |
| **Red** | `userLogin: "intruder"` sharing numeric `pullRequestReviewId` is rendered/cited in the configured reviewer’s report text and `evidenceRefs`. |
| **Green** | Intruder body absent from configured review report and refs; parent review body still present; intruder still in `allEvidence()` / snapshot `evidenceIds`. Same-author inline edit/removal variant tests stay green. R7 `originalLine` stays green. |
| **Scope** | Minimal author equality filter on report membership. No ledger deletion. No new kinds. |

### Item 5 fixture syntax (Apply)

```ts
sampleReview({
  id: 1,
  userLogin: "codexbot",
  state: "CHANGES_REQUESTED",
  body: "parent review body",
  commitId: "head-c",
  submittedAt: "2024-01-01T00:11:00Z",
})

sampleReviewComment({
  id: 50,
  userLogin: "intruder",                 // different author
  body: "intruder inline should not attach",
  pullRequestReviewId: 1,              // same numeric review id
  commitId: "head-c",
  path: "src/a.ts",
  line: 10,
  updatedAt: "2024-01-01T00:11:00Z",
})

// Assert report for codexbot review does not match /intruder inline/
// Assert evidenceRefs exclude intruder evidenceId
// Assert ledger.allEvidence() still includes intruder record
```

---

## 6. Published request-body schema ↔ runtime parity

| | |
|---|---|
| **Behavior** | Align published request-body contract with runtime trim-non-empty + 60_000 UTF-8-byte validation. **Exact extension key:** `x-maxUtf8Bytes`. **TS export** `COLLECTOR_LEGS_SCHEMA` body property: `minLength: 1`, `pattern: "\\S"`, `x-maxUtf8Bytes: COLLECTOR_REQUEST_BODY_MAX_BYTES` (value sourced from the constant). **JSON copy** `schemas/collector-legs-v1.schema.json`: same shape with literal `60000` and pattern string `"\\S"`. Runtime `loadCollectorManifest` remains byte-enforcement authority (no parallel validator). Deep-compare parsed JSON file with `COLLECTOR_LEGS_SCHEMA`. |
| **Owner** | `src/collector-config.ts` + `schemas/collector-legs-v1.schema.json`; strengthen `test/collector-config.test.ts`; package inclusion already asserted in `test/collector-package-lifecycle.test.ts` — keep/prove. |
| **Red** | Schema accepts whitespace-only `"   "` via `minLength: 1`; no byte metadata; shallow parity; >60_000-byte bodies not documented on schema surface. |
| **Green** | Deep equality file ↔ export; schema pattern rejects whitespace-only; runtime rejects whitespace-only; `"é".repeat(30_000)` (60_000 bytes) accepted; `` `${exact}!` `` (60_001) rejected; schema file remains in `npm pack`. |
| **Scope** | Schema annotation + parity tests. No Soul. No second enforcement engine. |

### Item 6 fixture / contract syntax (Apply)

```ts
// COLLECTOR_LEGS_SCHEMA body property (exact):
body: {
  type: "string",
  minLength: 1,
  pattern: "\\S",
  "x-maxUtf8Bytes": COLLECTOR_REQUEST_BODY_MAX_BYTES,
}

// schemas/collector-legs-v1.schema.json body (exact):
"body": {
  "type": "string",
  "minLength": 1,
  "pattern": "\\S",
  "x-maxUtf8Bytes": 60000
}

// Parity:
assert.deepEqual(
  JSON.parse(await readFile("schemas/collector-legs-v1.schema.json", "utf8")),
  JSON.parse(JSON.stringify(COLLECTOR_LEGS_SCHEMA)),
);

// Whitespace rejection (runtime + schema pattern intent):
request: { body: "   " }  // loadCollectorManifest rejects trim-non-empty

// Multibyte boundary (retain):
const exact = "é".repeat(30_000); // 60_000 UTF-8 bytes — OK
const over = `${exact}!`;         // 60_001 — reject
```

---

## Apply obligations — fixture syntax (canonical summary)

Use **normalized helper property names**, not raw API names:

| Helper | Required shapes in this Apply |
|---|---|
| `sampleReview({ commitId, submittedAt, ... })` | Items 1, 3, 5 |
| `sampleReviewComment({ commitId, updatedAt, pullRequestReviewId, ... })` | Items 1, 5 |
| `sampleIssueComment({ updatedAt, ... })` | Item 1 headless — **no** synthetic `commitId` |

| Issue | Concrete clocks / controls |
|---|---|
| **3** | Activation `2024-01-01T00:10:00Z`; advance 16 minutes before first observe (deadline `00:25`, first observation `00:26`); pre-cutoff `submittedAt`; also cover exactly `00:25`. |
| **2** | `AbortController`; PATH `gh` verifies `-X POST`, records PID, hangs; pass `controller.signal`; assert abort rejection, dead PID, one settlement, no success details, no rejected attempt from cancel. |
| **4** | Runner returns `{status: 201, headers: {}, bodyText}` for malformed JSON, truncated JSON, and valid JSON missing required comment fields; `422` non-2xx control; later observe recovery without second POST. |
| **5** | Same numeric `pullRequestReviewId`, `userLogin: "intruder"`. |
| **6** | Pattern exactly `"\\S"`; key exactly `x-maxUtf8Bytes`. |

---

## Apply order (single forward commit)

1. **Item 3** — `applyEvidenceVersionHistory(..., deadlineTime)` + evidence/receipt after-cutoff tests (honest clocks before receipt assertions).
2. **Items 1 + 5** — `collector-receipt.ts` provenance delete/`qualifiesUnavailableEvidence` rewrite + `reviewInlineComments` author filter + receipt tests (including headless-target rejection rewrite).
3. **Item 4** — 2xx parse → `ambiguous_loss` + recovery/POST-once tests.
4. **Item 2** — signal thread role → ledger → createIssueComment + hung POST cancel test.
5. **Item 6** — dual schema + deep parity + whitespace/multibyte tests.
6. **Self-verify gate** (all required, no weaker substitute):
   - targeted tests for the six seams
   - `npm run typecheck`
   - full `npm test` (must keep R1–R11 focused tests green)
   - `npm pack --dry-run` (schema path present)
   - `git diff --check`
   - confirm **zero** Collector Soul diff; no new binder/classifier/recovery/cancel state; no parallel validator
7. **Commit** one forward commit only (no amend). Title prefix per task contract; body maps each of the six findings → owner fix, and states R1–R11 preservation (including R4 and correct R3 half).

---

## Non-goals / refuse triggers

- Collector Soul edits; new scope/time/cancel classifiers; parallel recovery/validator paths.
- Softening tests/AC; treating abort as `rejected`/`ambiguous_loss`.
- Reintroducing snapshot-membership / first-observation HEAD as `target` proof.
- Synthetic `commitId` on `issue_comment`.
- Schema key other than `x-maxUtf8Bytes`; pattern other than `"\\S"`.
- Amending `6604a73` or rewriting history.
- If Apply discovers packet/authority conflict or unsafe overlap with disposed roots → `refused` with evidence; no empty commit.

---

## Plan status

**planned** — contract-closed for all six items with resolved target provenance, exact schema key `x-maxUtf8Bytes`, explicit R1–R11 preservation (including R4), and concrete Apply fixture syntax. No code or Git mutation performed in this plan phase.


## Binding Apply order

Plan is approved without further revision. Apply its six owner-local repairs in one red-first forward commit: exact carried-HEAD target provenance; identical request AbortSignal pass-through and POST-child cancellation; strict first-observed-vs-deadline review timing with known-null reuse; 2xx parse/normalization ambiguity through existing marker recovery; same-author-only inline report attachment with raw retention; and exact TS/JSON schema parity using pattern "\\S" and x-maxUtf8Bytes=60000. Then run targeted seam tests, typecheck, full tests, pack dry-run, and diff-check. Preserve explicitly R1 valid precedence, R2 same-leg citation/rebinding, the correct stale-H1 rejection half of R3 while removing establishment-as-proof, R4 full transitive embedding, R5 known-null/model-view consistency, R6 tombstoned users, R7 originalLine, R8 raw redaction, R9 updatedAt bracket/retry, R10 pagination budget, and R11 observe/GET cancellation. No Collector Soul diff, test weakening, new binder/classifier/recovery/cancel state, parallel validator, or parallel recovery path.
