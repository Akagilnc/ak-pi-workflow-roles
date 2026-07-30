# Approved second Collector repair plan

# Fixer plan 2 delta — closes `/tmp/ak-collector-fixer-plan-2-corrections-final2.md` only

**Phase:** plan only — no code, test, doc, or Git mutation.  
**HEAD:** `c7ee3b5` (`c7ee3b56597470b273603a214abcc65ced6c1182`)  
**This document is the sole controlling apply plan.** It inherits F1/F2/F3 scope from Judge packet 2 and prior approved plan law, and **replaces** the defective §2.6 latestRelevant fixture, §3.1 timestamp-less rows, §3.2 collision facades, §3.3 ambient/loader wiring, and §3.4 byte constructions with the executable specifications below. No alternatives, placeholders, `e.g.`, slash-cases, or vacuous assertions remain in those sections.

**Local probes locked during planning (do not re-litigate):**
- `review.body` pad with `raw: {}` → `measureNormalizedBytes` grows **exactly +1 UTF-8 byte per ASCII `x`** (empty body base `1255`; `need = 8_388_608 - 1255 = 8_387_353` hits `8_388_608`; `need+1` hits `8_388_609`).
- One-leg `status:"valid"` receipt → `legs[0].rationale` occurs **once** in `JSON.stringify(receipt)`; base with rationale `"x"` measured `2532`; `nMax = 33_554_432 - 2532 + 1 = 33_551_901` hits exact `32 MiB`; `nMax+1` throws at `src/collector-receipt.ts:748-753` and latches fatal.
- Pi types inspected: `DefaultResourceLoaderOptions` (`node_modules/@earendil-works/pi-coding-agent/dist/core/resource-loader.d.ts:61-112`), `Skill` + `SourceInfo`, `registerCommand(name, Omit<RegisteredCommand,"name"|"sourceInfo">)` with required `handler`, `BuildSystemPromptOptions.appendSystemPrompt?: string` (loader `string[]` joined by session).

---

## Unchanged owning repairs (still mandatory)

### F1 — Singular TypeBox schema owner
- Add `src/collector-tool-schemas.ts` as the **only** arg contract (strict status-discriminated output union; `unavailableScope` required only on `unavailable`; nonblank via unanchored `pattern: "\\S"`; `additionalProperties: false`).
- Wire `collector-role` registration, ledger `collectorToolArgumentsValid`, receipt `parseCollectorOutputCandidate` to that owner; delete key lists / optional-scope-on-all-status / dual validators.
- Observe residual envelope: reject `arguments === undefined|null` before `Value.Check`.
- Real-Pi sole invalid output rows (unknown leg field; unavailable missing/invalid scope; scope on valid; scope on missing; blank rationale; empty refs; unknown top-level) + valid+invalid siblings → `message_end` deny, `latchFatal`, every GitHub counter `0`. Controls: well-formed missing/unavailable + multiline rationale schema-allowed.

### F2 — Leg-owned receipt refs (attempt join only)
- **No** independent `ak-collector:v1` / `leg=` parser.
- Join requester comments only via `record.body.includes(attempt.marker)` with `attempt.legId === L`.
- `latestRelevant(L)` = last chronological same-leg attempt with `status ∈ {"succeeded","recovered"}` AND (`commentEvidenceId` string OR `recoverySnapshotId` string).
- Missing auto-link **only** that attempt’s present `{commentEvidenceId, snapshotId, recoverySnapshotId}`.
- Missing model cites: allow only final snapshot, final PR/user facts, expected-author material (any window), same-leg attempt-owned ids, marker-joined same-leg requester comments; else fail closed. Transport failures never enter leg/report refs.
- Unavailable: every model cite must `qualifiesUnavailableEvidence(...).ok`; delete `boundRefs = proof ∪ remaining`; bind leg+terminal-report refs to qualifying proof only.
- Production: rewrite `collectMissingProofRefs` (`src/collector-receipt.ts:327-375`) and missing/unavailable bind paths.

### F3 remainder (labels → constructions)
Keep concrete rows for v3 before→after deadline comment edit, review edit/dismiss/disappearance retention, required-tool absence, ambient surfaces, ID collisions, exact 8/32 MiB — as specified below.

---

## Correction 1 — §2.6 latestRelevant uses a real older **recovered** attempt

**Home:** `test/collector-receipt.test.ts`  
**Manifest:** two request-capable legs `a` and `b` (both with `requestBody`), authors `["author-a"]` / `["author-b"]`.

### Fixture `F2-latestRelevant-recovered-then-succeeded` (leg `a` only; non-vacuous)

Clock start `2024-01-01T00:00:00Z`. Fake transport user `collector-bot`.

1. **Observe head-a:** `pullRequest.headOid = "head-a"`; reviews/comments empty.  
   `const snapA = (await ledger.observe(...)).snapshot`.

2. **Older attempt — actually recovered (all three IDs defined):**
   - `transport.state.createComment = async () => ({ kind: "ambiguous_loss", diagnostics: "lost POST" })`.
   - `const reqA1 = await ledger.request({ legId: "a", snapshotId: snapA.snapshotId }, transport, clock)` → status path records `ambiguous_loss` with `marker`, `snapshotId === snapA.snapshotId`.
   - Set `transport.state.issueComments = [sampleIssueComment({ id: 501, userLogin: "collector-bot", body: \`Please review.\\n\${reqA1.marker}\\n\`, createdAt/updatedAt within window })]`.
   - `const snapRecover = (await ledger.observe(...)).snapshot`.
   - `const older = ledger.requestAttempts().find(t => t.legId==="a" && t.status==="recovered")`.
   - **Assert before output (fixture integrity, not the ownership claim):**
     - `older.status === "recovered"`
     - `typeof older.commentEvidenceId === "string"`
     - `typeof older.snapshotId === "string"` (`snapA.snapshotId`)
     - `typeof older.recoverySnapshotId === "string"` (`snapRecover.snapshotId`)
     - `older.commentEvidenceId`, `older.snapshotId`, `older.recoverySnapshotId` are three defined strings (the values that must later be absent from auto-link).

3. **Later eligible same-leg attempt — succeeded at a new HEAD** (attempt key includes HEAD; same HEAD would be refused):
   - `transport.state.pullRequest = samplePull({ headOid: "head-b" })`.
   - Clear `createComment` override so default success path runs.
   - Keep older marker comment in `issueComments` (immutable history).
   - `const snapB = (await ledger.observe(...)).snapshot` (`head-b`).
   - `const reqA2 = await ledger.request({ legId: "a", snapshotId: snapB.snapshotId }, transport, clock)` → `status === "succeeded"`, `commentEvidenceId` set, `snapshotId === snapB.snapshotId`, `recoverySnapshotId` undefined.
   - `const later = ledger.requestAttempts().filter(t => t.legId==="a").at(-1)`.
   - Assert `later.status === "succeeded"` and `later.attemptId !== older.attemptId`.
   - Assert `latestRelevant` selection target is `later` (last eligible same-leg).

4. **Past cutoff + both legs missing with minimal model cites** (final snapshot only):
   - `clock.advance(16 * 60 * 1000)`.
   - `const final = (await ledger.observe(...)).snapshot`.
   - `buildCollectorReceipt(ledger, { legs: [
        { legId:"a", status:"missing", rationale:"a missing", evidenceRefs:[final.snapshotId] },
        { legId:"b", status:"missing", rationale:"b missing", evidenceRefs:[final.snapshotId] },
     ]}, clock)`.

5. **Ownership assertions (leg `a` and matching terminal-fact report):**
   - Auto-linked present: `later.commentEvidenceId`, `later.snapshotId`, `final.snapshotId`.
   - **All three older IDs absent from both** `receipt.legs.find(l=>l.legId==="a").evidenceRefs` **and** `receipt.reports.find(r=>r.kind==="terminal-fact"&&r.legId==="a").evidenceRefs`:
     - `older.commentEvidenceId`
     - `older.snapshotId`
     - `older.recoverySnapshotId`
   - Leg `b` contains none of `older.*` or `later.*` attempt ids (`bContaminated === false`).

This replaces the vacuous two-`succeeded`-without-recoverySnapshotId fixture. The older attempt is a real `recovered` row with all three proof fields defined; absence is meaningful.

### Other F2 tests (unchanged intent, still one decoy each)
- Two-leg missing contamination (request only `a`, both missing).
- M1 cross-leg `a.commentEvidenceId` on `b` → throw.
- M2a cross-leg `a.snapshotId` on `b` → throw.
- M2b cross-leg `a.recoverySnapshotId` on `b` (use the recovered older attempt above as the id source) → throw.
- M3a dangling evidence id → throw; M3b dangling snapshot id → throw.
- M-clean qualifying only → accept.
- U1–U5 / U-clean unavailable decoys, one decoy per call; leg+terminal-report refs asserted every time.

---

## Correction 2 — §3.1 exact timestamp-less review fixtures (one seam, no `or`)

**Owning seam:** `applyEvidenceVersionHistory` for `kind==="review"` (`src/collector-evidence.ts:366-373`): every later distinct review version forces `authoritativeTime = null` while GitHub still reuses `submitted_at`. Fake transport feeds `GitHubReview` directly (no REST `requireString` path).

**Do not** use issue/review comments with null/missing `created_at`/`updated_at` (transport normalizers require those strings). **Do not** say “reused or cleared”.

### Test `F3-timestamp-less-review-state` (exact)

```
clock = 2024-01-01T00:10:00Z; activation recorded; headOid = "head-c"
```

**Observe1** — `transport.state.reviews = [sampleReview({
  id: 1,
  userLogin: "codexbot",
  state: "APPROVED",
  body: "LGTM",
  commitId: "head-c",
  submittedAt: "2024-01-01T00:00:00Z",
  raw: {},
})]`.

- `first = ledger.allEvidence().find(r => r.kind==="review" && r.state==="APPROVED")`
- Assert `first.authoritativeTime === "2024-01-01T00:00:00Z"`
- Assert `first.windowRelation === "before"`

**Observe2** — same stable review id, **state-only** mutation, **submittedAt literally reused** (not cleared, not omitted):

```
transport.state.reviews = [sampleReview({
  id: 1,
  userLogin: "codexbot",
  state: "DISMISSED",
  body: "LGTM",
  commitId: "head-c",
  submittedAt: "2024-01-01T00:00:00Z",
  raw: {},
})]
```

- `later = ledger.allEvidence().find(r => r.kind==="review" && r.state==="DISMISSED")`
- Assert `later.versionId !== first.versionId`
- Assert `later.authoritativeTime === null`
- Assert `later.windowRelation === "uncertain"`
- Assert first version still in `allEvidence()`
- `buildCollectorReceipt` with `status:"valid"` citing **only** `later.evidenceId` throws `/qualifying|valid/i`
- DISMISSED cannot sole-qualify valid; uncertain cannot sole-prove valid

### Test `F3-timestamp-less-review-text` (exact)

**Observe1** — `sampleReview({ id: 2, userLogin: "codexbot", state: "COMMENTED", body: "still looking", commitId: "head-c", submittedAt: "2024-01-01T00:00:00Z", raw: {} })`.

- `first.body === "still looking"`; `first.authoritativeTime === "2024-01-01T00:00:00Z"`; `windowRelation === "before"`.

**Observe2** — body-only mutation, submittedAt reused:

```
sampleReview({
  id: 2,
  userLogin: "codexbot",
  state: "COMMENTED",
  body: "I will not review this PR",
  commitId: "head-c",
  submittedAt: "2024-01-01T00:00:00Z",
  raw: {},
})
```

- `later.body === "I will not review this PR"`
- `later.authoritativeTime === null`
- `later.windowRelation === "uncertain"`
- both bodies retained under same `stableGitHubId === "review:2"`
- unavailable citing **only** `later.evidenceId` throws `/unavailable|eligible|window/i`
- uncertain text cannot sole-prove unavailable

### Other §3.1 rows (still required, already concrete in prior plan)
- **v3 before-deadline comment → terminal edit after deadline** (issue_comment id `C`, body change with real after-deadline `updated_at`; early within/before; terminal after; unavailable-only-terminal fails; missing may preserve both).
- **review edit retention**, **review dismiss retention**, **review disappearance retention** as previously specified.

---

## Correction 3 — §3.2 exact collision facades (no `e.g.` / no “embed both”)

**Home:** `test/collector-receipt.test.ts`  
**Pattern:** build a real ledger via observe; wrap with a test-local facade object that implements the `CollectorLedger` methods `buildCollectorReceipt` actually calls, delegating by default and overriding **only** the listed methods. No production test hooks.

Shared setup for all three:
```
clock @ 2024-01-01T00:10:00Z
transport: user + OPEN PR head-c + one APPROVED review (codexbot, submittedAt before activation)
ledger.recordActivation; await ledger.observe
review = allEvidence review; pr = allEvidence pull_request; finalId = latestCompleteSnapshotId
```

### Test `F3-collision-duplicate-evidenceId`

Facade overrides:
```ts
allEvidence() {
  const rows = [...real.allEvidence()];
  const prRow = rows.find(r => r.kind === "pull_request")!;
  return [
    ...rows,
    { ...prRow, versionId: "forged-dup-evidence-version" }, // same evidenceId as prRow
  ];
}
getEvidence(id) {
  return this.allEvidence().find(r => r.evidenceId === id) ?? real.getEvidence(id);
}
```
All other methods → `real.*`.

**Why this reaches the check first:** `buildCollectorReceipt` always embeds final-snapshot PR via `finalSnapshot.evidenceIds` → `embedEvidenceIds.add(pr.evidenceId)`. Then:
```ts
evidenceRecords = ledger.allEvidence().filter(r => embedEvidenceIds.has(r.evidenceId))
```
returns **two** rows sharing `pr.evidenceId` → fails at `src/collector-receipt.ts` evidenceId uniqueness (`/evidenceId collision/i`) **before** namespace ambiguity.

Call:
```ts
buildCollectorReceipt(facade, {
  legs: [{ legId:"codex", status:"valid", rationale:"ok", evidenceRefs:[review.evidenceId] }],
}, clock)
```
Assert throws `/evidenceId collision/i`.

### Test `F3-collision-duplicate-snapshotId`

Facade overrides:
```ts
allSnapshots() {
  const snaps = [...real.allSnapshots()];
  const final = snaps.find(s => s.snapshotId === real.latestCompleteSnapshotId)!;
  return [
    ...snaps,
    { ...final, observedAt: "1970-01-01T00:00:00.000Z" }, // same snapshotId
  ];
}
getSnapshot(id) {
  return this.allSnapshots().find(s => s.snapshotId === id) ?? real.getSnapshot(id);
}
```

**Why reachable:** `embedSnapshotIds` always contains `finalSnapshot.snapshotId`; filter over `allSnapshots()` keeps both rows → fails snapshotId uniqueness (`/snapshotId collision/i`).

Same valid candidate as above. Assert throws `/snapshotId collision/i`.

### Test `F3-collision-cross-namespace`

Let `collisionId = pr.evidenceId` (guaranteed embedded as evidence).

Facade overrides:
```ts
const forgedSnapshot = {
  ...real.getSnapshot(real.latestCompleteSnapshotId)!,
  snapshotId: collisionId, // equals embedded PR evidenceId
  observedAt: "1970-01-01T00:00:00.000Z",
};
allSnapshots() {
  return [...real.allSnapshots(), forgedSnapshot];
}
getSnapshot(id) {
  if (id === collisionId) return forgedSnapshot;
  return real.getSnapshot(id);
}
```

Candidate **must cite `collisionId`** so `addEvidence` runs both branches:
```ts
legs: [{
  legId: "codex",
  status: "valid",
  rationale: "ok",
  evidenceRefs: [review.evidenceId, collisionId],
}]
```
`addEvidence(collisionId)`:
- `getEvidence(collisionId)` → PR row → `embedEvidenceIds`
- `getSnapshot(collisionId)` → forgedSnapshot → `embedSnapshotIds`

Then the cross-namespace loop fails (`/ambiguous|namespaces/i`) at `src/collector-receipt.ts` exactly-one resolution — the first check that sees both namespaces populated for one id.

Assert throws `/ambiguous|namespaces/i`.

---

## Correction 4 — §3.3 exact loader options, registerCommand, session_start activation

**Harness change (test-only):** extend `InProcessPiOptions` + `withInProcessPi` in `test/helpers/pi-test-harness.ts` to pass through these `DefaultResourceLoader` fields when provided (default behavior unchanged for existing tests):

| Option | Default today | Pass-through when set |
| --- | --- | --- |
| `noSkills` | hard-coded `true` | use `options.noSkills` if `=== false` or `=== true`; else `true` |
| `noContextFiles` | hard-coded `true` | same pattern |
| `additionalSkillPaths` | already optional | keep |
| `skillsOverride` | absent | pass `options.skillsOverride` |
| `appendSystemPrompt` | absent | pass `options.appendSystemPrompt` |

No production hooks in `src/`.

### `F3-required-tool-absence`
Earlier `extensionFactories` entry:
```ts
(pi) => {
  const orig = pi.registerTool.bind(pi);
  pi.registerTool = ((tool) => {
    if (tool.name === COLLECTOR_WAIT_TOOL) return; // drop required wait
    return orig(tool);
  }) as typeof pi.registerTool;
}
```
Then `createRoleRuntimeExtension({...collector deps...})`.  
Flags: role collector + repo/pr/legs. Prompt once.  
Assert: `process.exitCode === 1`; `transport.calls.pull/user/create === 0`; provider pending responses unused; error path is missing required tool at activate (`Collector required tool missing: ak_collector_wait`).

### `F3-ambient-skills` — **one** injection: `skillsOverride`
```ts
await withInProcessPi({
  ...baseCollectorPiOptions,
  noSkills: false,
  skillsOverride: () => ({
    skills: [{
      name: "ambient-collector-skill",
      description: "nonempty ambient skill for collector fail-closed",
      filePath: `${home}/ambient-collector-skill/SKILL.md`,
      baseDir: `${home}/ambient-collector-skill`,
      sourceInfo: {
        path: `${home}/ambient-collector-skill/SKILL.md`,
        source: "test",
        scope: "temporary",
        origin: "top-level",
      },
      disableModelInvocation: false,
    }],
    diagnostics: [],
  }),
  // no additionalSkillPaths
}, ...)
```
Prompt once → `before_agent_start` sees `systemPromptOptions.skills.length > 0` → `failInfrastructure` / `latchFatal(/ambient skills/i)`; GitHub counters 0; exit 1.

### `F3-ambient-contextFiles` — **one** injection: real cwd file + `noContextFiles: false`
```ts
await writeFile(resolve(home, "AGENTS.md"), "# Ambient agents instructions\nDo ambient things.\n");
await withInProcessPi({
  ...base,
  cwd: home,
  noContextFiles: false,
}, ...)
```
Prompt once → `systemPromptOptions.contextFiles.length > 0` → fatal ambient context files; GitHub 0; exit 1.

### `F3-ambient-appendSystemPrompt` — **one** injection: loader `appendSystemPrompt: string[]`
```ts
await withInProcessPi({
  ...base,
  appendSystemPrompt: ["AMBIENT_APPEND_BLOCK"],
}, ...)
```
Session joins to string (`loader.getAppendSystemPrompt().join("\n\n")`); `before_agent_start` sees nonempty string `systemPromptOptions.appendSystemPrompt` → fatal append drift; GitHub 0; exit 1.

### `F3-ambient-commands` — complete `registerCommand` call
```ts
extensionFactories: [
  (pi) => {
    pi.registerCommand("skill-ambient", {
      description: "ambient skill command decoy",
      async handler(_args, _ctx) {
        /* no-op */
      },
    });
  },
  createRoleRuntimeExtension({ /* collector deps */ }),
],
```
`RegisteredCommand` after `Omit<...,"name"|"sourceInfo">` requires `handler`; `description` supplied; no other fields. Name `skill-ambient` matches activate filter `name.includes("skill")` at `src/collector-role.ts:575-588`.  
Assert startup fail before prompt work: exit 1, GitHub 0, provider unused.

### `F3-receipt-overflow-role-path` — direct Collector runtime + **explicit session_start activation**

Construction alone does **not** activate. Exact factory:

```ts
import { createCollectorRoleRuntime } from "../src/collector-role.ts";

const failCalls: unknown[] = [];
extensionFactories: [
  (pi) => {
    // createCollectorRoleRuntime registers ak-collector-* flags itself
    const collector = createCollectorRoleRuntime(
      pi,
      {
        loadSoul: async () => COLLECTOR_SOUL,
        createTransport: () => transport,
        createClock: () => clock,
      },
      {
        failInfrastructure(error, ctx) {
          failCalls.push(error);
          ctx.abort();
          if (ctx.mode === "print" || ctx.mode === "json") process.exitCode = 1;
          throw error;
        },
      },
    );
    pi.on("session_start", async (event, ctx) => {
      await collector.activate(ctx, event); // mandatory — not optional
    });
  },
],
flags: {
  // no ak-role needed; this factory is collector-only
  "ak-collector-repo": "acme/widgets",
  "ak-collector-pr": "1",
  "ak-collector-legs": legsPath,
},
```

Session bind emits `session_start` → `activate` runs. Then prompt-driven observe + output as in §3.4 role path.

---

## Correction 5 — §3.4 one-byte-granularity reachable 8 / 32 MiB fixtures

### 8 MiB snapshot — independent one-byte legal field

**Law:** `src/collector-ledger.ts` observe path → `measureNormalizedBytes(pendingRecords)` with `pendingRecords = [user, pr, ...reviews]` after history/windows; reject when `> COLLECTOR_SNAPSHOT_MAX_BYTES` (`8_388_608`).

**Pad field:** `GitHubReview.body` only, with `raw: {}` so the pad appears **once** in the normalized record (not again inside `raw`). Hash fields (`contentDigest`, `versionId`, `evidenceId`) are fixed-length; ASCII `x` is JSON-safe → **Δbody = Δmeasured = 1**.

**Calibration helper (test-local, mirrors observe normalize order):**
```ts
function measureSnapshotBytes(body: string): number {
  const observedAt = "2024-01-01T00:00:00.000Z";
  const records = [
    normalizeAuthenticatedUserEvidence(sampleUser(), observedAt),
    normalizePullRequestEvidence(samplePull(), observedAt),
    normalizeReviewEvidence(
      sampleReview({ id: 1, userLogin: "codexbot", body, raw: {} }),
      observedAt,
    ),
  ];
  applyEvidenceVersionHistory(records, []);
  assignWindowRelations(
    records,
    new Date("2024-01-01T00:00:00Z"),
    new Date("2024-01-01T00:15:00Z"),
  );
  return measureNormalizedBytes(records);
}
```

**Exact pads (formula locked by planning probe; re-assert in test, do not hardcode without measuring):**
```ts
const MAX = COLLECTOR_SNAPSHOT_MAX_BYTES; // 8388608
const base = measureSnapshotBytes("");
const padMax = "x".repeat(MAX - base);       // measured === MAX
const padMax1 = "x".repeat(MAX - base + 1);  // measured === MAX+1
assert.equal(measureSnapshotBytes(padMax), MAX);
assert.equal(measureSnapshotBytes(padMax1), MAX + 1);
```

**Accept path:** fresh ledger; `sampleReview({ id:1, userLogin:"codexbot", body: padMax, raw:{} })`; `await ledger.observe` resolves; `ledger.fatal === false`; `snapshot.normalizedByteLength === MAX`; `snapshot.complete === true`.

**Reject path:** fresh ledger; body `padMax1`; `observe` rejects `/bytes|snapshot/i`; `ledger.fatal === true`; `collectorFatal === true`.

**Forbidden:** padding a field also copied into `raw`; dual-serialized body; “max+1 body length” without `measureNormalizedBytes === MAX+1`; truncation.

Replace stub at `test/collector-ledger.test.ts:761-763`.

### 32 MiB receipt — one-leg `valid` rationale (single occurrence)

**Law:** `src/collector-receipt.ts:748-753`  
`bytes = Buffer.byteLength(JSON.stringify(receipt), "utf8")`; `> MAX` → `ledger.latchFatal`.

**Why valid, not missing/unavailable:** missing/unavailable copy `rationale` into both `legs[].rationale` and terminal-report `report` (2× per pad byte). Valid puts rationale **only** in `legs[0].rationale` (planning probe: one `"rationale"` key; review report text is independent). ASCII `x` → **Δrationale = Δreceipt = 1**.

**Minimal post-observe ledger:** one leg `codex`; OPEN PR; one before-window APPROVED review on head; activation recorded; single successful `observe`. Keep every snapshot `normalizedByteLength <= 8 MiB` and `materializationByteLength() <= 32 MiB` (true for this fixture).

**Calibration (same ledger allowed until fatal; MAX+1 uses fresh ledger because fatal latches):**
```ts
function measureReceipt(ledger, clock, reviewId, n: number): number {
  const receipt = buildCollectorReceipt(ledger, {
    legs: [{
      legId: "codex",
      status: "valid",
      rationale: "x".repeat(n),
      evidenceRefs: [reviewId],
    }],
  }, clock);
  return Buffer.byteLength(JSON.stringify(receipt), "utf8");
}
const MAX = COLLECTOR_RECEIPT_MAX_BYTES; // 33554432
const b1 = measureReceipt(ledger, clock, review.evidenceId, 1);
const nMax = MAX - b1 + 1;
const nMax1 = nMax + 1;
assert.equal(measureReceipt(ledgerMax, clock, reviewId, nMax), MAX);
// fresh ledger for +1:
await assert.rejects(
  async () => measureReceipt(ledgerMax1, clock, reviewId, nMax1),
  /receipt exceeded|33554432|bytes/i,
);
assert.equal(ledgerMax1.fatal, true);
```

**Exact MAX accept (builder):** `buildCollectorReceipt` with `rationale: "x".repeat(nMax)` returns; `ledger.fatal === false`; measured bytes `=== MAX`.

**Exact MAX+1 role infrastructure path (non-substitutable):**
1. Use the §3.3 direct `createCollectorRoleRuntime` factory with spy `failInfrastructure` and **explicit** `pi.on("session_start", (e,ctx) => collector.activate(ctx,e))`.
2. Fake transport + clock; legs manifest one `codex` author; qualifying APPROVED review present pre-activation window.
3. Assistant turns: (T1) sole `ak_collector_observe` `{}`; (T2) sole `ak_collector_output` with schema-valid one-leg valid args, `rationale: "x".repeat(nMax1)`, `evidenceRefs: [reviewEvidenceId from observe details or known stable path]`.
4. Assert **all** of:
   - output tool execute entered (not batch schema deny)
   - thrown/latched message `/receipt exceeded|32/i`
   - `failCalls.length === 1`
   - `process.exitCode === 1`
   - no successful output `toolResult` carrying a receipt
   - `transport.calls.create === 0` (no extra GitHub writes)

**Calibration of `nMax1` for the role path:** build an identical unit ledger (same manifest digest/authors/head/review body) in the test before the Pi session; compute `nMax1` via the measure helper above; reuse that integer in the faux output arguments. Do not approximate.

**Forbidden:** missing/unavailable double-rationale pads; observe-growth proxy; builder-only as sole MAX+1 proof; constant-only asserts; refusal instead of construction; any path that cannot hit both adjacent sizes.

---

## Apply order

1. Red F1 schema matrix + registered-schema inspection + real-Pi invalid output rows/siblings/controls.  
2. Add `src/collector-tool-schemas.ts`; wire three consumers; delete divergent checkers; F1 green.  
3. Red F2 including **recovered-then-succeeded latestRelevant** + contamination + M*/U* decoys.  
4. Fix `collectMissingProofRefs` + missing/unavailable bind; F2 green.  
5. Red/green F3 §3.1–3.3 with exact fixtures above; harness pass-through; production fix only if a row exposes a true residual bug.  
6. Replace 8 MiB stub with measured `==MAX`/`==MAX+1`; add 32 MiB valid-rationale MAX accept + role MAX+1 infrastructure path.  
7. Gates: `npm run typecheck`; hermetic `HOME=$(mktemp -d) npm test`; focused real-Pi output schema probes; `git diff --check`.  
8. One forward commit `fix(collector): …` (no amend); HEAD strict descendant of `c7ee3b5`.  
9. Fresh independent Reviewer over `c5f75b6...<new HEAD>`; return receipt. Convergence barred until that review passes.

## Refusal triggers
- Authority orders preserving non-qualifying unavailable extras → refused.  
- After the constructions above, measured `MAX`/`MAX+1` still unreachable through legal single-occurrence fields and the real output infrastructure path → refused with measured evidence (do not fake boundaries).  
- Partial adoption → refused (optional commitSha if a forward commit landed).

## Success bar
- F1 sole schema owner; every malformed output row fatal at batch with zero GitHub; multiline control allowed.  
- F2: older **recovered** attempt’s three IDs absent from leg+report auto-link; no cross-leg contamination; each decoy fails alone.  
- F3: exact review state/text timestamp-less fixtures; three collision facades with specified return arrays/lookups; ambient rows with the single chosen loader/`registerCommand` wiring; required-tool absence; explicit session_start activation on overflow role path; `measureNormalizedBytes == 8 MiB` accept and `== 8 MiB+1` fatal; receipt JSON UTF-8 `== 32 MiB` accept and `== 32 MiB+1` through output execute → size check → `latchFatal` → spy `failInfrastructure`.  
- Typecheck + hermetic full suite green; one forward commit; fresh full-range Reviewer receipt.


## Binding Plan Judge apply obligations

Construction-ready under the owner-approved Plan Gate. F1–F3 each fix Behavior, the owning seam, executable red/green oracles, and bounded Scope; no unresolved contract/owner/seam, incompatible alternative, absent oracle, forbidden parallel mechanism, or demonstrated infeasibility remains. Authority stays frozen to the cited Collector v1/v2/v3 authority and packet-2 residuals. Apply must preserve the specified fixture meanings, collision embed/lookup paths, and independently remeasure the legal single-occurrence review.body and valid-rationale fields at exact MAX/MAX+1 on the applied head; exact literals/helper syntax are Apply obligations, not grounds for another plan rewrite. One Apply wiring correction is required: Pi creates a distinct ExtensionAPI per inline factory (`node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js:385-390`), so the required-tool-absence monkey patch cannot affect a separate later factory. Compose the registerTool wrapper and invocation of `createRoleRuntimeExtension(...)` within the same inline factory (or an equivalent same-API construction), while retaining the fixed missing-tool activation oracle and zero provider/GitHub side effects. This is fixture wiring, not a construction-readiness blocker.
