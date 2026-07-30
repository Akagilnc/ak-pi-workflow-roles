# Collector repair plan (consolidated, test-first, head `ce5d2e4`)

## Scope and constraints

- Phase: **plan only** — no code, test, doc, or Git mutation in this phase.
- Repair only the six Judge-sustained construction defects; preserve Collector authority, Soul thinness, and existing lawful role behavior (one-shot print/json, four tools, 15m cutoff, self-contained receipt, no `refused`).
- **Replace flawed mechanisms**; do not layer parallel guards beside unused fields or filter-only batch checks.
- Prior art to reuse, not clone: Reviewer sibling/batch provenance (`3e78957`) and Reviewer installed-tarball consumer (`test/reviewer-package-lifecycle.test.ts`).
- Collector has a single introducing commit (`ce5d2e4`); no prior failed Collector fix family. Do **not** reintroduce filter-only batch legality as a “variant guard.”
- **Do not** replace required real seams with injected alternatives (`spawnImpl` mocks, source-tree `createRoleRuntimeExtension` + fake transport, or separate “valid session” stand-ins for ordered matrix cases).

## Apply order (binding)

1. **Write all new/extended failing tests first** against current head mechanisms.
2. **Run them on `ce5d2e4` and record actual outcomes** (fail/assert message) in the apply commit body or an adjacent test-log note the Judge can check.  
   - Forbidden escape hatch: “equivalent assertions documented” without a real red run on the reproducible behavioral defects.
3. Implement one owning mechanism per law.
4. Re-run full gates; one forward commit (no amend).

---

## Evidenced root causes (current head)

| # | Defect | Controlling seam | Broken mechanism |
|---|---|---|---|
| 1 | Batch provenance | `collector-role.ts:toolCallPartsFromMessage` drops non-`id`/`name` string parts; `evaluateBatch` (`collector-ledger.ts:288-320`) filters to Collector names; `lastAssistantBatchKey` written then voided (`:727`); `beginOperational` never matches a sole permitted `(id,name[,args])` | Unknown/malformed siblings never poison the batch; sole/schema-invalid never classified; observe can execute beside `unknown_tool` |
| 2 | Cutoff / final snapshot | `request`/`wait` only clear `finalObservationCompleted` (`:593,671`); receipt checks it only if `finalObservationRequired` (`collector-receipt.ts:311`); observe stamps `observedAt` pre-fetch (`:371`) and never records completion mono; output path has no clock; single PR read, no terminal reread; request precheck is a partial qualify (`:520-538`) | `missing` at mono=0; post-POST stale output; provider turn can cross cutoff unnoticed; valid/unavailable treated as always-early; final time is pre-fetch; HEAD/state not terminal-authoritative |
| 3 | Version time | `normalizeReviewEvidence` sets `authoritativeTime = submitted_at` for every body/state version (`collector-evidence.ts:243`); no ledger history step before window assignment | Post-deadline edits backdate as `before` / `unavailable` |
| 4 | Historical reports | `collectSubstantiveReviewReports` dedupes by `versionId` only and always builds against `finalSnapshot` (`collector-receipt.ts:283-294`) | Prior inlines vanish; one snapshot per review version cannot express removal/edit membership |
| 5 | Receipt invariants / overflow | unavailable window uses first arbitrary ref (`:430-441`); missing cite-only; auto-embed not linked into leg/report refs; recovery snapshot ID not represented; overflow `fail()` not `latchFatal` (`:611-615`); resolve is “at least one namespace” not exactly-once across both | Wrong-leg refs; unverifiable missing proof; 32 MiB retriable model error |
| 6 | Seam depth | `createGhApiRunner` tested only via injected `GhApiRunner`; lifecycle injects in-memory transport through source factory; package test packs / source-loads, does not install+run packaged entrypoint with real default transport | Production `gh` spawn, installed consumer, and startup collision seams unproven |

---

## Global implementation strategy

1. **Red first** for every case below; record `ce5d2e4` failure evidence before green.
2. **One mechanism per law** at the owning seam. Role wiring only enforces ledger/receipt decisions.
3. **Shared helpers over forks**: request precheck and receipt `valid` both call `reviewQualifiesForValid` (identical inputs, including authoritative window time).
4. **No Soul growth** for timers, MiB, schema, batch, or transport; keep `souls/collector.md` principle-only.
5. **Apply-phase gates**: `npm run typecheck`, `HOME=$(mktemp -d) npm test`, `git diff --check`, then a **fresh independent Reviewer** on the new head (Judge note).

---

## Defect 1 — Finalized-message batch provenance

### Replace

Delete:

- filter-to-Collector-names legality in `evaluateBatch`;
- dead `lastAssistantBatchKey`;
- `toolCallPartsFromMessage` as the sole classifier that **drops** malformed parts.

### Authoritative finalized-call classifier (single mechanism)

Own the law in the ledger (or a pure helper used only by ledger+role message_end), with role supplying the **raw** assistant `content` array:

1. Walk **every** content part. Any part with `type === "toolCall"` (or host-equivalent tool-call marker) is a raw finalized tool-call candidate — **including** parts missing/non-string `id`/`name`, missing/non-object `arguments`, unknown names, or schema-invalid Collector arguments.
2. Malformed raw parts (no string id, no string name, non-object/unparseable arguments where a toolCall claims to be one) **poison the batch** before execute. They must not be dropped silently.
3. For each well-formed candidate, classify:
   - known operational name ∈ `{ak_collector_observe, ak_collector_request, ak_collector_wait}` with arguments satisfying that tool’s schema;
   - known output name `ak_collector_output` with schema-valid arguments shape at batch time (full receipt validation still at execute);
   - known Collector name with **schema-invalid** arguments → illegal;
   - any other name (e.g. `unknown_tool`, `read`, `bash`) → illegal sibling.
4. Legal batch shapes (entire list, order-independent count but order preserved for permit identity):
   - exactly one schema-valid operational call and zero other tool-call parts;
   - exactly one schema-valid output call, zero other tool-call parts, and prior completed operational / existing snapshot rule (keep early-output guard).
5. Any of the following latches fatal, stores **no** permit, and must run **before** any tool execute:
   - empty illegal mixes already covered;
   - sole schema-invalid Collector call;
   - valid + schema-invalid sibling;
   - valid + unknown/non-Collector sibling;
   - two operational; operational+output; dual-output;
   - second output after `outputAccepted`;
   - later-turn batch that is not a single permitted form after fatal already latched stays fatal.
6. On allow, persist **one** permit:

```ts
type PermittedBatch =
  | { kind: "operational"; callId: string; name: OperationalTool }
  | { kind: "output"; callId: string; name: typeof COLLECTOR_OUTPUT_TOOL };
```

7. `beginOperational(toolName, toolCallId)` (tool_call **and** execute):
   - require `permittedBatch` exact match on `callId` + `name`;
   - reject mismatched id/name, absent permit, or batch-fatal;
   - keep same-id idempotency across preflight+execute;
   - after bind, no other call may claim the permit.
8. After the first fatal batch in a session: **no** further transport/POST/observe side effects (assert call counters frozen).

Role `message_end` calls the classifier once; no second policy. Tool-layer schema rejection alone is insufficient if batch classification never saw the raw sibling.

### Tests — must be real Pi, **one continuous session per ordered matrix**

Extend `test/collector-role.test.ts` with `withInProcessPi` + faux provider + injectable transport counters.  
**Forbidden:** separate session for the “valid” half of invalid→valid; unit-only `evaluateBatch` as sole proof of execution zero-side-effect.

| Case | Same-session assistant turns | Assert |
|---|---|---|
| valid→invalid | T1 sole observe (ok) → T2 observe+wait | T1 may pull once; after T2 fatal, `transport.calls.*` unchanged; no POST |
| invalid→valid | T1 unknown sibling / mixed → T2 sole observe | T1 zero transport; fatal latched; T2 still zero transport (no additional side effects after first fatal) |
| invalid→invalid | T1 mixed → T2 dual-output | zero transport both turns |
| operational↔output | observe+output same batch | zero transport; both results error/blocked |
| dual-output | two `ak_collector_output` | fatal, no receipt |
| two-valid operational | observe+observe / request+wait | zero GitHub side effects |
| unknown-sibling | `ak_collector_observe` + `unknown_tool` | observe **must not** execute (`pull === 0`), fatal, nonzero exit |
| sole schema-invalid | sole observe/request/wait/output with bad args | poison before execute; zero transport |
| valid+schema-invalid sibling | valid observe + second Collector call with bad args | poison; zero transport |
| post-fatal freeze | after any first fatal batch, further assistant batches | counters remain frozen |

Also keep/adjust `collector-ledger.test.ts` unit matrix so the classifier rejects unknown/malformed/schema-invalid without role, but **do not** treat that as substitute for real-Pi matrix.

**ce5d2e4 expected red (record actual):** unknown-sibling observe executes; malformed parts dropped; `evaluateBatch` allows non-Collector siblings; no permit cross-check.

---

## Defect 2 — Mechanical cutoff / final-snapshot law

### Replace optional final-observation flags with monotonic observation law

**State (single mechanism):**

- Snapshot list + `latestCompleteSnapshotId` as today.
- Every complete snapshot records:
  - `observedAt` / start wall if useful for diagnostics;
  - **`completedAt` wall** (ISO) set only when observe finishes successfully;
  - **`completedMono`** internal monotonic time at completion.
- `mutationGeneration` (or `dirtyAfterMutation`): incremented on every successful `request` or `wait` completion.
- `observedGeneration`: set to current `mutationGeneration` only when a complete observe finishes after that mutation.
- `cutoffMono` / `deadlineMono` unchanged as entry gate for request/wait.
- Receipt/output path receives **`clock` (or mono+wall now)** — output predicate must observe current time.

**Rules:**

1. **Dirty after request/wait:** output requires `observedGeneration === mutationGeneration` (a complete observe finished **after** the latest mutation). Closes “POST then output on stale pre-request snapshot.”
2. **Provider-turn / mono crossing:** `assertOutputObservationLaw(candidate, clock)` uses `clock.monoNow()`:
   - If `monoNow < deadlineMono` (**before cutoff**): `valid` / `unavailable` may terminate early iff dirty-clear and receipt proof on latest complete snapshot; `missing` **forbidden**.
   - If `monoNow >= deadlineMono` (**at/after cutoff**): **every** status (`valid` / `unavailable` / `missing`) requires a complete observation whose **`completedMono >= deadlineMono`** (finished at/after the cutoff obligation) and dirty-clear. Early valid/unavailable **only before cutoff**.
3. **`missing`:** only at/after cutoff, dirty-clear, latest complete snapshot exists, and that final observe completed at/after cutoff obligation.
4. **Observe boundary:**
   - Entry may note cutoff; completion always stamps `completedAt`/`completedMono`.
   - **Observe start-before / finish-after cutoff:** completion mono ≥ deadline ⇒ this observe satisfies the cutoff final-observation obligation.
5. **Terminal PR reread (final transport read):**
   - Order: user → initial PR → reviews → issue comments → review comments → **terminal `getPullRequest`**.
   - Terminal PR payload **supplies** stored PR evidence fields and snapshot `prState` / `headOid`.
   - If initial and terminal HEAD or state **differ**: reject closed or **retry the full observe surfaces once** inside the same call, then bind only the consistent terminal read; do not commit a snapshot whose HEAD/state is the non-terminal read.
6. **`finalObservationTime`:** receipt uses the final snapshot’s **`completedAt`**, never the pre-fetch stamp currently at ledger `:371`.
7. **Request precheck = receipt law:** replace hand-rolled loop (`collector-ledger.ts:520-538`) with `reviewQualifiesForValid({ review, expectedAuthors, targetHead: snapshot.headOid, activationTime, deadlineTime })`.

Remove sole reliance on `finalObservationRequired && !finalObservationCompleted` as the missing/output gate; one ledger predicate drives output.

### Tests

Ledger + receipt unit tests **and** real-Pi / fake-clock paths:

| Case | Assert |
|---|---|
| missing at mono=0 | activate → observe → output `missing` → reject |
| post-request stale | observe → request ok → output w/o re-observe → reject; after re-observe, law applies |
| post-wait dirty | wait → output w/o observe → reject |
| valid early only before cutoff | exact-head qualifying review, mono before deadline → valid ok without cutoff observe |
| valid/unavailable at/after cutoff without post-cutoff complete observe | reject even if pre-cutoff snapshot had proof |
| cutoff missing | advance past deadline → final observe completes after cutoff → `missing` ok; `finalObservationTime === completedAt` |
| provider turn crosses deadline | fake clock: before-cutoff assistant turn starts; mono advances past deadline before output tool runs → output predicate sees past cutoff and demands post-cutoff complete observe |
| observe-start-before / finish-after | transport/clock advances past deadline during observe → completion mono after cutoff satisfies obligation; `completedAt` after advance |
| terminal PR reread | initial HEAD A, terminal HEAD B (or state change) → no commit on A / fail or retry; stored PR evidence and snapshot HEAD are terminal |
| request precheck window | `after`/`uncertain` does not block like true before/within exact-head; before/within exact-head blocks request (same as receipt) |

**ce5d2e4 expected red (record actual):** missing accepted pre-cutoff; stale post-request output accepted; `finalObservationTime` equals pre-fetch; no completion mono; output ignores clock; single PR read.

---

## Defect 3 — Immutable version time provenance

### Stateful owning mechanism (ledger, not normalize alone)

Normalization **cannot** know “later version.” Split:

**A. Pure normalize (per surface fetch row):**

- Build `contentDigest` / `versionId` from the **enumerated version-significant fields** below.
- Set provisional time fields only from GitHub-supplied version clocks:
  - issue/review comments: `updated_at` when present, else `null`;
  - reviews: do **not** invent an update clock; pass `submittedAt` as submission metadata only.
- Never set `authoritativeTime` from `firstObservedAt` or observe wall time.

**B. Ledger history step before `assignWindowRelations` / `storeEvidence`:**

- Index retained evidence by `stableGitHubId`.
- **First** distinct review body/state version for a `stableGitHubId` may use `submitted_at` as `authoritativeTime` (submission version).
- **Every later** distinct review `versionId` for that same `stableGitHubId` **without** a GitHub-supplied version timestamp ⇒ force `authoritativeTime = null` ⇒ `windowRelation = uncertain` after assignment.
- Comments: each distinct version uses its own `updated_at`; if a changed version lacks timestamp ⇒ `null` / `uncertain` (never backdate with first version’s time or `firstObservedAt`).
- Prior versions remain stored; window relations are per-version.

**C. Digest field enumeration (normative — implement and test, not “audit later”):**

| Kind | Version-significant fields in digest |
|---|---|
| `review` | `id`, `state`, `body`, `commitId`, `submittedAt`, `htmlUrl`, `userLogin` (normalized author), plus any other retained reporting field that can change identity of the version (`author_association` if retained in raw/report path — if normalized onto the record, include it) |
| `issue_comment` | `id`, `body`, `updatedAt`, `userLogin`, `htmlUrl` |
| `review_comment` | `id`, `body`, `path`, `line`, `side`, `position`, `updatedAt`, `commitId`, `pullRequestReviewId`, `userLogin`, `htmlUrl` |
| `pull_request` | `number`, `state`, `headOid`, `updatedAt`, `htmlUrl`, title/body if retained on record |
| `authenticated_user` | `login` (+ id if retained) |

If a field is stored on `CollectorEvidenceRecord` or rendered into reports/qualification, it **must** be in the digest. Add an explicit **mutation test** that flips each currently omitted-but-stored field (at minimum review `htmlUrl` / author normalization edge, review_comment `position`/`htmlUrl`, issue_comment `htmlUrl`) and expects a new `versionId` / non-collision with the old version.

Qualification:

- `valid` still requires before/within on the **proof version** under corrected timestamps.
- Content `unavailable` cannot treat uncertain post-edit decline as before/within.

### Tests (v3 cases)

1. **Pre-activation review edited after deadline:** body A with `submitted_at` before activation → later body decline, no update timestamp → new version `uncertain` (not `before`); cannot accept `unavailable` on new version; old version retained.
2. **Before-deadline comment edited terminal after deadline:** within `updated_at` non-terminal → after-deadline `updated_at` decline → after version ineligible; prior within retained; unavailable only if a true before/within version supports it.
3. **Timestamp-less state/text change:** `APPROVED`→`DISMISSED` or body flip across observes without version timestamp → new version `uncertain`, never backdated with `submitted_at`/`firstObservedAt`.
4. **Digest mutation:** change each enumerated field in isolation → new `versionId`; unchanged fields keep identity.
5. Regression: single-version pre-activation APPROVED still `before` / `valid`.

**ce5d2e4 expected red (record actual):** edited review keeps `authoritativeTime = submitted_at` and can accept `unavailable`; omitted fields do not change `versionId`.

---

## Defect 4 — Prior inline findings keep their own report variants

### Replace final-snapshot-only / one-snapshot-per-review-version assembly

`collectSubstantiveReviewReports` must **not** dedupe solely by `review.versionId` against `finalSnapshot`.

**Single mechanism:** emit/dedupe immutable report variants by:

```text
(reviewVersionId, coObservedInlineVersionMembershipKey)
```

where `coObservedInlineVersionMembershipKey` is the ordered (or canonical sorted) set of `review_comment` **version/evidence ids** co-present in a given snapshot and joined by `pullRequestReviewId` to that review version.

Algorithm:

1. For each snapshot (chronological), for each review **version** id present in that snapshot’s `evidenceIds`, compute the co-observed inline-version set from **that same snapshot only**.
2. Variant key = `(review.versionId, membershipKey)`. First time a key appears → emit one `buildReviewReport` bound to **that** snapshot’s inline text/refs only.
3. Consequences:
   - **Inline removal:** snapshot1 review+inline A → snapshot2 same review version, no inline ⇒ **two** reports: prior with old inline ref, later with no inline.
   - **Inline edit:** two comment versions across snapshots ⇒ both texts on their variants; no cross-snapshot leakage of final inline onto older membership.
   - **Review edit/dismiss/delete:** each distinct review version keeps its variants; absence from final snapshot does not delete prior variants.
4. Head/window tags still from that review version’s `commitOid` / `authoritativeTime` vs final target head and activation window.
5. Prefer scanning `allSnapshots()` + ledger evidence; no parallel side index unless scan is proven insufficient.

### Tests

- **A→B→C HEAD moves** with distinct review versions: all substantive versions in `reports[]` with correct `prior`/`current` vs final head C.
- **Inline removal:** both membership variants present; final inline text **not** attached to the earlier membership-less-or-different claim incorrectly; prior inline text retained on the prior variant via prior version refs.
- **Inline edit:** both inline versions preserved on appropriate variants; no leakage.
- **Review edit / dismiss / delete:** body/state versions and disappearance from final snapshot still leave prior substantive reports.

**ce5d2e4 expected red (record actual):** prior inline remains in `evidenceRecords` but disappears from every report once absent from final snapshot; single report per review version.

---

## Defect 5 — Self-contained receipt invariants and fatal overflow

### Receipt builder (`buildCollectorReceipt`)

1. **Unavailable**
   - Resolve **the** qualifying evidence under declared scope (author ∈ leg, before/within, target membership).
   - Bind terminal report `windowRelation` and proof refs to **those** qualifying records, not `evidenceRefs[0]`.
   - **Reject** wrong-leg / wrong-author / non-qualifying decoy refs (fail closed).

2. **Missing**
   - Must cite final complete snapshot id (keep).
   - **Automatically retain and link** into that leg’s `evidenceRefs` **and** the missing terminal report’s `evidenceRefs` (not merely copy into `evidenceRecords`):
     - latest relevant pending/negative same-leg author reviews;
     - dismissed/pending/after/uncertain attempts;
     - authenticated request markers for the leg;
     - transport loss/recovery facts for the leg.
   - Model-omitted required proof ⇒ still present via auto-link so completeness is verifiable.

3. **Concrete recovery representation**
   - Preserve each ambiguous-loss attempt’s transport diagnostics (`ambiguous_loss` fields, marker, legId, observedHead, startedAt, stderr/code if already modeled).
   - When recovery succeeds, retain:
     - attempt status `recovered`;
     - `commentEvidenceId` of marker;
     - **`recoverySnapshotId`**: exact snapshot id whose observation first established the authenticated marker (the snapshot where the marker comment evidence id appears / recovery was latched).
   - Embed loss diagnostics + recovery snapshot + marker comment; receipt schema/attempt type gains `recoverySnapshotId` (or equivalent single field) rather than an informal comment.

4. **Exactly-one resolution**
   - Every embedded `evidenceId` unique in `evidenceRecords`; every `snapshotId` unique in `snapshots`.
   - Fail on evidenceId or snapshotId **collisions** within the receipt.
   - Every leg/report ref resolves in **exactly one** of the two namespaces (no ambiguous id that is both, no missing).

5. **Overflow**
   - Receipt JSON `> COLLECTOR_RECEIPT_MAX_BYTES` → `ledger.latchFatal(...)` / `collectorFatal` so `ak_collector_output` takes **infrastructure** failure (`failInfrastructure`), **not** model-retriable `fail()`.
   - Ledger materialization already latches — align messages; output path must not swallow as ordinary validation.

6. **Boundaries (no truncation)**
   - Exact **8 MiB** snapshot and **32 MiB** receipt/materialization:
     - law remains `> max` fail → accept `== max`, reject `max+1`;
     - construct via `Buffer.byteLength(JSON.stringify(...), "utf8")` helpers;
     - fatal/nonzero; bodies/refs not truncated.

### Tests

- unavailable mixed good+wrong-author refs → reject.
- unavailable `windowRelation` matches qualifying evidence, not first ref.
- missing auto-links pending/negative/request/recovery into **leg and report refs**; omitting them from model input still yields resolvable proof; stripping required material fails verification.
- recovery receipt contains ambiguous-loss diagnostics + **`recoverySnapshotId`** + marker comment evidence.
- omit unrelated authors OK; omit required missing-proof material not OK.
- evidenceId/snapshotId collision → fail.
- 8 MiB and 32 MiB exact boundary tests (`max` accept, `max+1` latchFatal infrastructure).

**ce5d2e4 expected red (record actual):** first-ref windowRelation; overflow via `fail()`; no `recoverySnapshotId`; missing proof not forced into leg/report refs.

---

## Defect 6 — Operational / startup / package seams (real only)

### 6a. Hermetic **executable** `gh` on PATH (not `spawnImpl` mock)

`test/collector-github.test.ts` (extend/replace mock-runner-as-sole-seam proofs):

1. Under hermetic HOME, write an executable `gh` stub script onto a temp `bin/` (shebang + argv logging + scripted HTTP/`--include` responses / nonzero ambiguous failures).
2. `chmod +x`; prepend that `bin` to `PATH`.
3. Invoke **`createGhApiRunner()` with default real `spawn`** (no `spawnImpl` injection in these cases) and/or `createGhCollectorGitHubTransport(createGhApiRunner())`.
4. Cover through that real spawn path:
   - fixed argv: `gh api --hostname github.com --include ...` (no shell join);
   - GET pagination `Link` next across hosts/paths;
   - POST comment success;
   - HTTP rejected POST;
   - ambiguous loss (`ambiguousGhFailure` when no parseable HTTP).
5. **Recovery through ledger observe on the same seam:** drive `createCollectorLedger(...).request` → ambiguous loss via PATH `gh`, then `observe` where stub returns the authenticated marker comment → attempt `recovered` + `recoverySnapshotId` set. Do not re-mock transport for this recovery proof.

### 6b. Real Pi startup collisions / ambient resources

In `collector-role.test.ts` with `withInProcessPi`:

1. **Required tool missing** → activation fail, `process.exitCode === 1`, provider unused, **zero** GitHub/`gh` calls (PATH stub counters stay 0 or no transport constructed successfully).
2. **Required tool name collision** → fail closed, zero provider/GitHub side effects.
3. **Ambient instruction resources** (skills / contextFiles / appendSystemPrompt / commands on supported surfaces) → fatal before provider/GitHub.

No production-only test hooks; extend harness only if collision cannot be simulated through existing registration surfaces (minimal).

### 6c. Installed-tarball independent consumer (definitive)

Replace pack-only / source-factory lifecycle as the package proof. Mirror Reviewer’s install pattern inside `test/collector-package-lifecycle.test.ts`:

1. `npm pack` → consumer dir with `file:` dep on tarball + peer `file:` pi packages.
2. `npm install --ignore-scripts`.
3. Resolve **installed** `node_modules/@ak/pi-workflow-roles/extensions/role-runtime.ts` (not `packageRoot` source).
4. PATH hermetic executable `gh` stub implementing the observe surfaces + optional POST for the lifecycle scenario.
5. `withInProcessPi` loads **only** that installed entrypoint (`-e` / extension path = installed file); **print and json** modes.
6. Exercise packaged **default** transport (`createGhCollectorGitHubTransport` / default runner) end-to-end with zero network.
7. Assert receipt host/repo/head/legs.

**Remove** from this proof:

- source-tree `createRoleRuntimeExtension({ createCollectorTransport: () => fake })` fallback;
- injected in-memory transport as substitute for the installed default path.

Inventory pack contents may remain as a secondary assert, not the lifecycle proof.

### Soul

No Soul edits unless a principle is actually missing (none required by these six defects).

---

## File touch map (expected apply)

| Area | Files |
|---|---|
| Raw batch classifier + permit cross-check + cutoff/dirty/completion mono + terminal PR reread + version history step + request precheck | `src/collector-ledger.ts`, `src/collector-role.ts` (raw message parts + output clock plumbing only) |
| Digest field sets; normalize provisional times | `src/collector-evidence.ts` (+ attempt/snapshot types for `completedAt`/`completedMono`/`recoverySnapshotId` as needed) |
| Report variants; unavailable/missing linking; unique resolve; fatal overflow | `src/collector-receipt.ts` |
| gh runner | prefer **tests only** via PATH stub; touch `src/collector-github.ts` only if real default spawn/env PATH handling cannot see hermetic `gh` |
| Tests | `test/collector-ledger.test.ts`, `test/collector-receipt.test.ts`, `test/collector-role.test.ts`, `test/collector-github.test.ts`, `test/collector-package-lifecycle.test.ts`, helpers only if required for PATH `gh` stub / byte-boundary builders |
| Out of scope | `souls/collector.md` (unless audit forces), orchestrator, README unless already-covered flag help |

---

## Apply-phase verification checklist

1. **All new tests added and run on `ce5d2e4` first**; record real fail outcomes for the behavioral defects above (no documentation-only stand-in).
2. Implementation turns those tests green **without** weakening AC, deleting failure paths, or permitting unknown siblings when Collector subset size is 1.
3. `npm run typecheck`
4. `HOME=$(mktemp -d) npm test`
5. `git diff --check`
6. Working tree only authorized repairs; **one forward commit** (no amend); body lists root causes fixed, findings adopted/not adopted, and red-run evidence summary.
7. New HEAD is strict forward descendant of start HEAD.
8. Judge note: obtain **fresh independent Reviewer** on new HEAD before convergence.

---

## Explicit non-goals / refusal triggers

- No relaxing receipt assertions or “permit unknown siblings if Collector subset is size 1.”
- No parallel `lastAssistantBatchKey` decoration beside a still-filtered batch check.
- No `spawnImpl`-only stand-in for the packet’s executable `gh` seam.
- No source-factory + injected transport stand-in for the installed-tarball consumer proof.
- No separate session substituting for same-session invalid→valid.
- No Soul paragraphs for 15m/8MiB/32MiB/batch rules.
- No inventing `firstObservedAt` as `authoritativeTime`. If apply discovers an authority conflict that would destroy all lawful `valid`, **refuse** with evidence rather than ship a hollow commit — Judge adjudicates owner questions.

## Plan status

**planned** — consolidated against `/tmp/ak-collector-fixer-plan-corrections.md`; ready for Judge approval before apply.
