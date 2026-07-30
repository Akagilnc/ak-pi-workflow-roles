# Collector repair plan (test-first, head `ce5d2e4`)

## Scope and constraints

- Phase: **plan only** — no code, test, doc, or Git mutation.
- Repair only the six Judge-sustained construction defects; preserve Collector authority, Soul thinness, and existing lawful role behavior (one-shot print/json, four tools, 15m cutoff, self-contained receipt, no `refused`).
- **Replace flawed mechanisms**, do not layer parallel guards beside unused fields or filter-only batch checks.
- Prior art to reuse, not clone: Reviewer sibling/batch provenance (`3e78957`, real-Pi malformed-sibling tests) and Reviewer installed-tarball consumer (`test/reviewer-package-lifecycle.test.ts`).
- Collector has a single introducing commit (`ce5d2e4`); no prior failed Collector fix family. Do **not** reintroduce the current filter-only batch pattern as a “variant guard.”

## Evidenced root causes (current head)

| # | Defect | Controlling seam | Broken mechanism |
|---|---|---|---|
| 1 | Batch provenance | `collector-ledger.ts:288-320`, `beginOperational` `327-345`; role `message_end`/`tool_call`/`execute` | `evaluateBatch` filters to Collector names, ignores non-Collector siblings; `lastAssistantBatchKey` is written and voided (`:727`); execute never cross-checks the sole permitted `(id,name)` |
| 2 | Cutoff / final snapshot | ledger `request`/`wait` clear only `finalObservationCompleted` (`:593,671`); receipt gate only if `finalObservationRequired` (`collector-receipt.ts:311`); observe stamps `observedAt` pre-fetch (`:371`); request precheck is a partial qualify (`:520-538`) | `missing` can accept at mono=0; post-POST stale snapshot can output; final time is pre-fetch; request precheck ≠ receipt law |
| 3 | Version time | `normalizeReviewEvidence` (`collector-evidence.ts:220-248`) | Every body/state version gets `authoritativeTime = submitted_at`, so post-deadline edits backdate as `before` |
| 4 | Historical reports | `collectSubstantiveReviewReports` / `buildReviewReport` (`collector-receipt.ts:163-294`) | Every historical review is rendered against **finalSnapshot** inlines only |
| 5 | Receipt invariants / overflow | unavailable window uses first arbitrary ref (`:430-441`); missing cite check only; overflow `fail()` not `latchFatal` (`:611-615`) | Wrong-leg refs slip; missing proof incomplete; 32 MiB is retriable model error |
| 6 | Seam depth | `createGhApiRunner` untested via spawn; lifecycle injects transport; package test packs but does not install/run | Production `gh`, startup collision, installed consumer unproven |

---

## Global implementation strategy

1. **Red first** for each defect: add failing tests that encode the probe cases; confirm they fail on current mechanisms.
2. **One mechanism per law** at the owning seam (ledger batch state, evidence versioning, receipt builder, gh runner). Role wiring only enforces ledger decisions.
3. **Shared helpers over forks**: request precheck and receipt `valid` both call `reviewQualifiesForValid` (or one extracted “eligible current review” helper with identical inputs, including authoritative window time).
4. **No Soul growth** for timers, MiB, schema, or transport; keep `souls/collector.md` principle-only (existing soul test already forbids `8 MiB|32 MiB|manifestDigest`).
5. **Apply-phase gates** (later): `npm run typecheck`, `HOME=$(mktemp -d) npm test`, `git diff --check`, and a fresh independent Reviewer on the new head.

---

## Defect 1 — Finalized-message batch provenance

### Replace

- Delete the “filter Collector calls, then count” legality rule and the unused `lastAssistantBatchKey` dead field.
- Persist **one** permitted finalized batch record per assistant message:

```ts
type PermittedBatch =
  | { kind: "operational"; callId: string; name: OperationalTool }
  | { kind: "output"; callId: string; name: typeof COLLECTOR_OUTPUT_TOOL };
```

### New legality (entire finalized tool-call list)

On `evaluateBatch(calls)`:

1. Latch fatal unless the **full** batch is exactly one permitted shape:
   - sole operational: exactly one part, name ∈ `{observe,request,wait}`, known Collector tool;
   - sole output: exactly one part, name = `ak_collector_output`, and prior completed operational / snapshot rule (keep existing early-output guard).
2. Any of the following latches fatal **before** execute and stores no permit:
   - empty Collector-relevant illegal mixes already covered;
   - **any non-Collector / unknown sibling** (e.g. `unknown_tool`, `read`, `bash`);
   - two operational, operational+output, dual-output;
   - schema-invalid Collector sibling (if it still appears as a toolCall part in the finalized message — treat extra Collector name/id as illegal batch; argument schema remains tool-layer rejection but batch with >1 call is already fatal);
   - second output after `outputAccepted`, or output while an operational call is active if observable;
   - later-turn batch that is not the single permitted form.
3. On allow: set `permittedBatch = {callId,name,kind}` and clear batch-fatal.
4. On deny: `permittedBatch = undefined`, `latchFatal(reason)`.

### Cross-check at `tool_call` and `execute`

`beginOperational(toolName, toolCallId)` (used by both hooks):

- require `permittedBatch` matches **exact** `toolCallId` and `toolName`;
- reject mismatched id/name, absent permit, or batch-fatal;
- keep idempotency for the same id across preflight+execute;
- after successful bind, do not allow a different call to claim the permit.

Role `message_end` keeps calling `evaluateBatch` only (no second policy). No transport/request work may run without a matching permit.

### Tests (must be real Pi for execution zero-side-effect cases)

Extend `test/collector-role.test.ts` (real `withInProcessPi` + faux provider), not only `evaluateBatch` unit tests:

| Case | Assistant batch | Assert |
|---|---|---|
| valid→invalid | observe alone (ok), then observe+wait | first observe may run; second batch fatal; second transport count unchanged after fatal |
| invalid→valid | unknown sibling first, then sole observe | first: `transport.calls.* === 0`, fatal/exit; if session cannot continue, separate session for valid path |
| invalid→invalid | mixed then dual-output | zero transport both times |
| operational↔output | observe+output same batch | zero transport; both toolResults error |
| dual-output | two `ak_collector_output` | fatal, no receipt |
| two-valid operational | observe+observe / request+wait | zero GitHub side effects |
| unknown-sibling | `ak_collector_observe` + `unknown_tool` | **observe must not execute** (`transport.calls.pull === 0`), fatal, nonzero |

Keep/adjust unit matrix in `collector-ledger.test.ts` so `evaluateBatch` itself rejects unknown siblings (today it allows them).

---

## Defect 2 — Mechanical cutoff / final-snapshot law

### Replace optional final-observation flags with monotonic observation law

**State machine (single mechanism):**

- `latestCompleteSnapshotId` / snapshot list as today.
- `observationGeneration` (or equivalent): increments on every successful complete observe.
- `dirtyAfterMutation`: set true on every successful `request` or `wait` completion (not only clearing a boolean used at cutoff).
- `finalObservationCompletedAt: string | undefined` — wall time when the observe that satisfied the current finality obligation **finished** (post-fetch), not pre-fetch.
- Cutoff: `monoNow >= deadlineMono` remains the gate for request/wait **entry**.

**Rules:**

1. **After every request/wait**: require a new complete observe before output (`dirtyAfterMutation` must be false at output). This closes “POST then output on stale pre-request snapshot.”
2. **`missing`**: allowed only when cutoff reached **and** a complete observe completed **at or after** the moment finality was required (post-cutoff final observe, or observe after the mutation that straddled cutoff). Encode as: `pastCutoff && !dirtyAfterMutation && latest complete snapshot exists && final observe completed after cutoff obligation`.
3. **`valid` / `unavailable`**: may still terminate early when receipt proof holds on the latest complete snapshot and `!dirtyAfterMutation` (no stale post-request snapshot). Early termination does **not** require cutoff.
4. **Observe boundary**: if `pastCutoff(clock)` at observe entry or exit, mark cutoff seen; on successful complete observe after cutoff (or after dirty), clear dirty and set `finalObservationCompletedAt = clock.wallNow().toISOString()` at **end** of observe.
5. **Snapshot authority**: re-read PR (OPEN/HEAD) as the **last** transport read before committing the snapshot (after reviews/comments). If re-read fails or surfaces were fetched under a different head, fail closed (latch) or restart the observe once inside the same call—prefer single terminal re-read and bind snapshot `prState`/`headOid` to that final PR payload so snapshot HEAD is authoritative.
6. **`observedAt` / receipt `finalObservationTime`**:
   - snapshot may keep observation identity time, but receipt `finalObservationTime` must use **completion** time (`finalObservationCompletedAt` or snapshot field set at end).
   - Do not stamp completion with the pre-fetch instant at ledger `:371`.
7. **Request precheck = receipt law**: replace the hand-rolled qualifying loop (`collector-ledger.ts:520-538`) with `reviewQualifiesForValid({ review, expectedAuthors, targetHead: snapshot.headOid, activationTime, deadlineTime })` so window/authoritative time match receipt validation. Same expected-author set and valid states.

Remove reliance on “clear `finalObservationCompleted` only” without requiring a new observe; remove receipt’s weak `finalObservationRequired && !finalObservationCompleted` as the sole missing gate—output path must call one ledger predicate, e.g. `assertOutputObservationLaw(candidateStatuses)`.

### Tests

`collector-ledger.test.ts` + `collector-receipt.test.ts` + at least one real-Pi path:

- **missing at mono=0**: activate, observe once, output `missing` → reject.
- **post-request stale snapshot**: observe → request success → output without re-observe → reject; after re-observe, valid/unavailable/missing follow law.
- **post-wait dirty**: wait → output without observe → reject.
- **cutoff missing**: advance past deadline → final observe → `missing` with final snapshot cite → accept; `finalObservationTime` ≥ observe completion, not pre-fetch if clock advances during observe (fake clock + fake transport delay via clock.advance in transport).
- **valid early**: exact-head qualifying review pre-cutoff → output valid without waiting for cutoff.
- **operations crossing cutoff**: request/wait entry at/after cutoff still latch; observe/output after cutoff allowed under law.
- **request precheck window**: review with `after`/`uncertain` window must not block request the way a true qualifying before/within review does; before/within exact-head blocks request (same as receipt).

---

## Defect 3 — Immutable version time provenance

### Replace backdated review versioning

In `collector-evidence.ts` / normalize path:

1. **Digest** all normalized version-significant fields for each kind (review: id/state/body/commitId/submittedAt plus any retained structural fields; comments already include body/updatedAt/path/line/… — audit completeness).
2. **Separate submission event from mutable content version**:
   - Keep submission timestamp as event metadata (`submittedAt` on the record or only via raw), **not** automatically as content `authoritativeTime` for every version.
   - `authoritativeTime` = GitHub-supplied **version** timestamp only:
     - issue/review comments: `updated_at` when present;
     - reviews: **no** fabricated update time. First observed content version may carry `submitted_at` only as the submission version clock; **any later distinct `versionId` for the same `stableGitHubId`** with no GitHub version timestamp gets `authoritativeTime = null` → `windowRelation = uncertain`.
   - Never assign `firstObservedAt` or observation wall time as `authoritativeTime`.
3. Ledger `storeEvidence` already keys by `versionId`; when a new version appears for the same stable id, prior versions remain. Ensure `assignWindowRelations` uses the per-version `authoritativeTime` only.
4. Qualification / unavailable:
   - `valid` continues to require before/within on the **version used as proof** under the new timestamps (submission-version approved still works).
   - content-based `unavailable` cannot treat an uncertain post-edit decline as before/within.

### Tests (`collector-ledger` / `collector-receipt`, label as v3 cases)

1. **Pre-activation review edited after deadline**: observe body A (`submitted_at` before activation) → edit body to decline after deadline without update timestamp → observe → new version `uncertain` (not `before`); cannot accept `unavailable` on the new version; old version retained.
2. **Before-deadline comment edited terminal after deadline**: comment `updated_at` within window with non-terminal text → later `updated_at` after deadline with decline → after version not eligible; prior within version retained for history; unavailable only if a before/within version truly supports it.
3. **Timestamp-less state/text change**: review `APPROVED`→`DISMISSED` or body flip across observes without version timestamp → new version `uncertain`, never backdated with `submitted_at`/`firstObservedAt`.
4. Regression: unchanged single-version pre-activation APPROVED still `before`/`valid`.

---

## Defect 4 — Prior inline findings keep their own versions

### Replace final-snapshot-only report assembly

`collectSubstantiveReviewReports` / `buildReviewReport`:

1. For each retained review **version** (`versionId` / `evidenceId`), select the **observation membership** that actually contained that evidence id (scan snapshots where `evidenceIds` includes the review version; prefer the snapshot that co-observed it, not always latest).
2. Build inline text and inline `evidenceRefs` only from **that snapshot’s** `review_comment` ids joined by `pullRequestReviewId`, and only comment **versions** present in that snapshot.
3. Do **not** attach final-snapshot inline text to older review versions.
4. When inlines are removed/edited, prior comment versions remain in ledger and in the historical report that referenced them; current report uses current co-observed versions.
5. Head/window tags still derived from that review version’s `commitOid` / `authoritativeTime` against final target head and activation window.

Optional small ledger aid (if needed): when storing a snapshot, no new parallel index required if reports can resolve membership by scanning `allSnapshots()` — prefer scan first to avoid extra mechanism.

### Tests

- **A→B→C HEAD moves** with distinct review versions each head: all substantive versions in `reports[]` with correct `prior`/`current` relative to final head C.
- **Inline removal**: snapshot1 review+inline “bug”; snapshot2 same review id, inline absent → receipt contains a report still showing prior inline text via prior version refs; final version report without that inline.
- **Inline edit**: two `review_comment` versions; both texts preserved on appropriate reports.
- **Review edit / dismiss / delete**: body/state versions and disappearance from final snapshot still leave prior substantive reports; no final inline leakage onto old review versions.

---

## Defect 5 — Self-contained receipt invariants and fatal overflow

### Receipt builder (`buildCollectorReceipt`)

1. **Unavailable**:
   - Resolve **the** qualifying evidence ref(s) under declared scope (author ∈ leg, before/within, target membership rules).
   - Bind terminal report `windowRelation` and proof refs to **those** qualifying records, not `evidenceRefs[0]`.
   - **Reject** refs that are wrong-leg/wrong-author / non-qualifying decoys (fail closed), not skip-silently while accepting.
2. **Missing**:
   - Must cite final complete snapshot id (keep).
   - **Automatically retain/embed** latest relevant pending/negative evidence for that leg (latest non-qualifying same-author reviews, dismissed/pending, after/uncertain attempts, authenticated request markers, transport loss/recovery facts tied to the leg). Model refs alone must not make proof unverifiable when unrelated records are omitted.
3. **Transport recovery**: embed ambiguous loss + recovered attempt fields and the **snapshot that established** authenticated-marker recovery (snapshot id where marker comment appeared), not only final snapshot.
4. **Unique resolve**: every embedded evidenceId/snapshotId appears once; every leg/report ref resolves inside the receipt; collision fails.
5. **Overflow**:
   - Receipt JSON `> COLLECTOR_RECEIPT_MAX_BYTES` → `ledger.latchFatal(...)` (or throw error with `collectorFatal`) so `ak_collector_output` takes infrastructure failure path (`failInfrastructure`), **not** a model-retriable throw.
   - Ledger materialization path already latches — align messages and ensure output path cannot swallow as ordinary validation.
6. **Boundaries**: exact **8 MiB** snapshot and **32 MiB** receipt/materialization:
   - `== max` accept (if law is `> max` fail — preserve inequality, test both `max` and `max+1`);
   - no truncation of bodies/refs;
   - fatal / nonzero, no receipt details on overflow.

### Tests

- unavailable with mixed good+wrong-author refs → reject.
- unavailable windowRelation matches qualifying evidence, not first ref.
- missing without auto-retained negative/pending material when such material exists in ledger → either auto-embed or reject incomplete proof (choose auto-embed as packet requires).
- recovery path receipt contains loss diagnostics + recovery snapshot + marker comment evidence.
- omit unrelated authors still OK; omit required missing-proof material not OK.
- 8 MiB and 32 MiB exact boundary tests (construct minimal records with precise byte lengths via `Buffer.byteLength(JSON.stringify(...))` helpers).

---

## Defect 6 — Operational / startup / package seams

### 6a. Hermetic fake `gh` through `createGhApiRunner`

Add `test/collector-github.test.ts` (or sibling) that:

- injects `spawnImpl` into `createGhApiRunner({ spawnImpl, env })`;
- child writes realistic `HTTP/1.1 ...\r\n...\r\n\r\nbody` on stdout / fails without parseable HTTP;
- drives `createGhCollectorGitHubTransport(runner)` **and** runner-only assertions.

Cover:

- fixed argv: `gh api --hostname github.com --include ...` (no shell join);
- GET pagination Link next across hosts/paths;
- POST comment success / HTTP rejected / ambiguous loss (`ambiguousGhFailure`);
- recovery remains ledger-level (existing) but transport must surface loss vs reject correctly through the real runner path.

Do **not** only mock `GhApiRunner` for this seam — packet requires executable fake `gh` via `createGhApiRunner`.

### 6b. Real Pi startup collisions / ambient resources

In `collector-role.test.ts` with `withInProcessPi`:

1. **Required tool missing**: factory that fails to register one Collector tool → activation fail, `process.exitCode === 1`, `transport.calls.* === 0`, provider unused.
2. **Required tool name collision**: pre-register duplicate name before role tools / inject second tool same name → fail closed, zero side effects.
3. **Ambient instruction resources**: expose skills/contextFiles/appendSystemPrompt/commands on the supported surfaces (mirror existing `before_agent_start` / `getCommands` checks) → fatal before provider/GitHub.

Use harness capabilities already used by Reviewer/Collector; extend harness only if collision cannot be simulated otherwise (minimal extension).

### 6c. Installed-tarball independent consumer

Mirror `test/reviewer-package-lifecycle.test.ts` pattern inside `collector-package-lifecycle.test.ts` (replace pack-only as sole package proof):

1. `npm pack` → consumer dir with `file:` dep on tarball + peer `file:` pi packages;
2. `npm install --ignore-scripts`;
3. run **installed** `extensions/role-runtime.ts` via `withInProcessPi` additional extension path;
4. print **and** json modes: observe → output valid receipt under empty HOME;
5. assert receipt host/repo/head/legs and that production entrypoint wires real soul/transport path (transport still injectable only if production entrypoint cannot be faked — prefer installed entrypoint with test dependency override **only** if production couples `gh`; if installed entrypoint always uses real `gh`, inject via env/spawn fake at runner level or test print/json through `createRoleRuntimeExtension` loaded from **installed path** with the package’s exported runtime factory).

Practical approach matching Reviewer: load installed package entrypoint; for Collector GitHub, either:

- set `createGhApiRunner` spawn via env not available — then test installed module import of `createRoleRuntimeExtension` from installed `dist/path` with test transport injection through the same export surface Reviewer uses, **or**
- run lifecycle against installed `role-runtime.ts` with a PATH-first fake `gh` executable written to hermetic HOME.

Prefer **PATH hermetic `gh` stub** so the installed default `createGhCollectorGitHubTransport()` is truly exercised end-to-end with zero network.

### Soul

No Soul edits unless a principle is actually missing (none required by these six defects). Keep mechanical laws in runtime/schema/tests.

---

## File touch map (expected apply)

| Area | Files |
|---|---|
| Batch + cutoff + observe completion | `src/collector-ledger.ts`, `src/collector-role.ts` (hook wiring only) |
| Version time | `src/collector-evidence.ts` (+ types if `submittedAt` split) |
| Reports + receipt invariants + fatal overflow | `src/collector-receipt.ts` |
| gh runner seam | `src/collector-github.ts` only if spawn/testability gaps; else tests only |
| Tests | `test/collector-ledger.test.ts`, `test/collector-receipt.test.ts`, `test/collector-role.test.ts`, `test/collector-github.test.ts`, `test/collector-package-lifecycle.test.ts`, helpers if needed |
| Not in scope | `souls/collector.md` (unless audit forces), orchestrator, README unless flag help already covered |

---

## Apply-phase verification checklist (for later)

1. New tests fail on `ce5d2e4` mechanisms (or equivalent assertions documented).
2. Implementation makes the six probe classes pass without weakening AC.
3. `npm run typecheck`
4. `HOME=$(mktemp -d) npm test`
5. `git diff --check`
6. Working tree only authorized repairs; one forward commit (no amend).
7. Judge note: obtain **fresh independent Reviewer** on new HEAD before convergence.

---

## Explicit non-goals / refusal triggers

- No relaxing receipt assertions, deleting failure paths, or “permit unknown siblings if Collector subset is size 1.”
- No parallel `lastAssistantBatchKey` decoration beside a still-filtered batch check.
- No Soul paragraphs for 15m/8MiB/32MiB/batch rules.
- If apply discovers GitHub cannot supply any version timestamp and making all review windows `uncertain` would destroy lawful `valid`, keep the **submission-version vs mutated-version** split above rather than inventing `firstObservedAt` clocks — escalate via refused report only if authority truly conflicts.

## Plan status

**planned** — ready for Judge approval before apply.
