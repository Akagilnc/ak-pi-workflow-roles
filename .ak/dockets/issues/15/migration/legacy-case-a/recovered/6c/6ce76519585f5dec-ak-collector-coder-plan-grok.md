# Plan B — Grok 4.5 Coder plan

Status: planned

# Collector v1 construction plan

**Phase:** plan only (no edits, no commits)
**Branch:** `feature/collector-role` @ `c5f75b63415bf24b8a2318ef8744a60d255eb135`
**Authority:** `/tmp/ak-collector-v1-authority-v2.md` (digest `05bbfd77…1961d`) + controlling `/tmp/ak-collector-v1-authority-v3-addendum.md` (digest `04f736d8…6fd43`)
**Design gate:** Judge-2 `continue` (4 remaining corrections) → addendum closes them → Judge-3 `converged` (“Coder planning may begin”)
**Stance:** full converged authority; refuse rather than silently reduce. No orchestrator migration. No copy of orchestrator `souls/collect.md`. Additive package surface only.

---

## 0. Controlling supersessions (must not re-open v2 wording)

| Topic | Law (addendum wins) |
|---|---|
| `windowRelation` | `before \| within \| after \| uncertain` (not `within\|after`) |
| Pre-activation evidence | Exact-head qualifying review with `before` may prove `valid` if still present/qualifying in final complete snapshot |
| Valid review states | Exact GitHub `APPROVED` \| `CHANGES_REQUESTED` \| `COMMENTED` only; require non-empty own `commit_id === targetHead` |
| Timestamps | Per immutable version; never substitute `firstObservedAt` for missing authoritative time; post-deadline edits cannot backdate later text |
| PR open/closed | Solely latest successful complete final snapshot; non-`OPEN` → non-zero, no receipt; post-final close is outside receipt |
| First input | **Replace entire** user message with one fixed packaged kickoff; do not append/quote/preserve caller prose |
| Later input | Immediate non-zero abort when observed; no fictional pre-side-effect guarantee; no argv/wrapper detective fiction |
| Repo grammar | Exact ASCII regexes (owner 1–39, repo 1–100); conservative subset documented |
| Receipt | Self-contained: embed `snapshots[]` + `evidenceRecords[]`; every ref resolves inside receipt; 8/32 MiB apply to materialization |

Unmodified v2 clauses remain in force (standalone product boundary, four tools, 15‑minute eligibility cutoff, leg conclusions, provenance tagged union, Soul layering, acceptance suite).

---

## 1. Current package facts (knife-edge)

| Fact | Evidence |
|---|---|
| Roles today | `judge` / `fixer` / `coder` / `reviewer` via `src/role-runtime.ts` + `extensions/role-runtime.ts` |
| Role pattern | Flag registration → `session_start` activate → `registerTool` + lifecycle `pi.on(...)` → `setActiveTools` → terminating `ak_*_output` with `terminate: true` |
| Closest analog | Reviewer (custom tools + ledger + sole final call), **but Collector must not reuse** Reviewer ledger/agent/bash evidence or worker status vocabulary |
| Test harness | `test/helpers/pi-test-harness.ts` (`withHermeticHome`, `withInProcessPi`, `runPiSubprocess`); mode typed `"print"\|"tui"` today — must extend to `"json"` |
| Pi APIs available | `registerFlag/getFlag`, `registerTool`, `getAllTools/setActiveTools`, `executionMode: "sequential"\|"parallel"`, events `session_start` (reason), `input` (transform/continue), `before_agent_start`, `tool_call` (block), `tool_result`, `ctx.mode` ∈ `tui\|rpc\|json\|print` |
| Parallelism law | Pi docs: sibling tools may run concurrently; `tool_call` is sequential preflight but does not see sibling results — Collector must enforce **≤1 operational call/turn** in runtime, not hope for default mode |
| Packaging | `package.json#files` = `extensions,src,souls,README.md`; lifecycle test pins **exact** tarball path list |
| Out of scope | Any `ak-workflow-orchestrator` file/contract; Flow/issue/candidate/landing fields; platform adapter framework; package-global journal/lock |

---

## 2. Product / compatibility boundary

**Is:** independently invocable external-GitHub PR collection role; observes configured legs, optionally requests, classifies terminality, preserves evidence across HEAD moves, submits one evidence-bearing receipt.

**Is not:** Reviewer, Judge, Fixer, Coder, orchestrator collect seat, local worktree dispatcher, or router.

**Compatibility invariant:** existing Judge/Fixer/Coder/Reviewer contracts and behavior unchanged. Public surface is additive only. Wiring into orchestrator requires a **separately authorized** migration + thin adapter later.

**Failure channels (no receipt):** malformed/unsupported config/mode/tools; non-OPEN final snapshot; transport/API/pagination/size/ledger/schema/model hang; unrecovered request transport loss; second output / later turn after terminal success path violations that are infrastructure-class.

**Success statuses only:** leg `valid|unavailable|missing`. **No** Collector `refused`.

---

## 3. Deep module map (replace-not-layer)

Do **not** layer onto `reviewer-execution-ledger`, worker output schema, or bash/read toolsets. New purpose-built tree:

```text
souls/collector.md
src/collector/
  index.ts                 # public exports used by role-runtime
  role.ts                  # createCollectorRoleRuntime (Pi lifecycle)
  flags.ts                 # --ak-collector-repo|pr|legs
  kickoff.ts               # FIXED_KICKOFF_TEXT; input replace / later-input abort
  method-context.ts        # runtime-owned method law + validated config block (NOT Soul)
  target.ts                # host fixed github.com; owner/repo grammar; PR number
  manifest.ts              # load/validate v1 manifest; canonical JSON; SHA-256 digest
  manifest.schema.json     # machine-readable schema (packaged)
  clock.ts                 # activation wall+monotonic; eligibilityDeadline = +15m
  marker.ts                # deterministic HTML correlation marker
  types.ts                 # evidence, snapshot, reports, legs, receipt types
  ids.ts                   # stable evidence/snapshot IDs; content/version digests
  window-relation.ts       # before|within|after|uncertain from authoritative times
  bounds.ts                # 8 MiB snapshot / 32 MiB ledger-or-receipt UTF-8
  pagination.ts            # complete-page markers; incomplete/429 => infra fail
  normalize.ts             # GH payload → immutable normalized records + raw facts
  github-transport.ts      # CollectorGitHubTransport interface
  github-transport-gh.ts   # real ambient-credential implementation (gh api / HTTPS)
  observe.ts               # observe op: fetch all surfaces, store snapshot, bounded view
  request.ts               # request op: prechecks, POST body+marker, attempt record
  wait.ts                  # wait op: cap to remaining eligibility; reject post-cutoff
  ledger.ts                # invocation ledger (internal only)
  turn-gate.ts             # ≤1 operational tool/turn; output singleton / no race
  receipt.ts               # mechanical invariants + self-contained materialization
  tools.ts                 # register four singleton tools + execute wiring
src/role-runtime.ts        # additive: collector flag value + activate branch + deps
extensions/role-runtime.ts # load souls/collector.md; wire default transport
README.md                  # launch profile, limits, concurrency caveat, receipt, failures
```

**Optional test-only (not packaged):** `test/helpers/fake-github-transport.ts`, fixture builders for reviews/comments/pagination/HEAD moves.

### Seam contracts

#### `CollectorGitHubTransport` (internal operational seam)
Hermetic tests inject a fake; production default uses ambient GitHub credentials. Methods (illustrative, exact names in apply):

- `getAuthenticatedLogin()`
- `getPullRequest({owner,repo,prNumber})` → state, head OID, timestamps, urls
- `listPullRequestReviews` / `listReviewComments` / `listIssueComments` — **complete pagination** with page diagnostics
- `createIssueComment({body})` → id/url/raw or transport failure classification

No model-visible bash. No cwd/git-remote target authority.

#### Invocation ledger (internal)
Binds: config digest, canonical target, activation/deadline, requester login, snapshots (complete/incomplete), immutable evidence versions, request attempts, waits, transport failures/recoveries, latest successful complete snapshot, turn-gate state, output-once flag.

Does **not** classify valid/unavailable/missing.

At output, ledger is **not** the audit artifact: `receipt.ts` embeds the referenced authoritative subset + all required prior substantive versions into tool-result `details`.

#### Four tools (exact singleton names)
| Tool | Params (model) | Runtime authority |
|---|---|---|
| `ak_collector_observe` | none (or empty object) | configured target only; returns bounded view + snapshot/evidence IDs |
| `ak_collector_request` | `{ legId, snapshotId }` | configured body+marker; latest snapshot/HEAD; cutoff; process-local once |
| `ak_collector_wait` | `{ durationMs }` (bounded) | cap to remaining monotonic eligibility; record wait fact |
| `ak_collector_output` | semantic legs/reports by **evidenceRefs only** | build full self-contained receipt; enforce invariants; `terminate: true` |

Register with `executionMode: "sequential"` as defense-in-depth; **still** enforce turn-gate because Pi parallel policy is host-level.

---

## 4. Lifecycle ordering (exact)

```text
extension load
  ├─ registerFlag ak-role (extend help: + collector)
  ├─ registerFlag ak-collector-repo|pr|legs
  └─ createCollectorRoleRuntime(pi, deps)

session_start (role===collector)
  1. mode ∈ {print,json}? else fail closed (detectable)
  2. session_start.reason ∈ supported one-shot startup set?
     reject resume/fork/continue-class reasons when exposed
  3. parse/validate repo (addendum D grammar), pr (positive safe int), legs path
  4. read UTF-8 manifest; reject duplicate JSON keys; schema+semantic validate
  5. compute canonical manifest JSON + sha256 digest; freeze config
  6. register four tools if not registered; verify getAllTools contains exactly
     our singleton implementations (name collision / absence → fail activation)
  7. setActiveTools([observe, request, wait, output]) ONLY
     (no bash/read/write/edit; missing required name → fail)
  8. install handlers (once):
       input → first: replace with FIXED_KICKOFF; later: abort non-zero
       before_agent_start → first: set activationTime/deadline; always inject
         <collector_soul> + runtime method/config context (validated facts only)
       tool_call → turn-gate / block illegal siblings
       (optional) turn_end → reset operational-call permit
  9. DO NOT call GitHub or provider yet
 10. activation clock NOT started until step before first provider dispatch

first input
  └─ discard caller prose entirely; model sees only FIXED_KICKOFF

before_agent_start (first)
  └─ activationTime = now; deadline = activation + 15m (mono+wall recorded)

model loop
  ├─ at most one of {observe,request,wait} per assistant turn
  ├─ output only after prior operational result returned (or immediate all-terminal
  │   after observe); output cannot race operational call
  ├─ request/wait start only if mono now < cutoff; wait capped
  ├─ observe allowed at/after cutoff for necessary final complete snapshot
  └─ when all legs terminal on current target → output immediately (method law)

ak_collector_output
  ├─ mechanical invariant checks (below)
  ├─ if final snapshot PR state ≠ OPEN → infra/target-state fail, no receipt
  ├─ materialize self-contained details (snapshots[]+evidenceRecords[])
  ├─ size check ≤32 MiB materialized; else fail
  ├─ terminate: true; mark output consumed
  └─ any later turn/output → fail

later input (if any)
  └─ abort non-zero immediately (honest: side effects may already exist)
```

**Documented launch preconditions (not fictional runtime guarantees):**
```text
pi --no-extensions -e <package-extension> --no-skills --no-prompt-templates \
  --no-context-files --no-session --mode json --ak-role collector \
  --ak-collector-repo <owner/repo> --ak-collector-pr <n> \
  --ak-collector-legs <manifest.json> -p "Start collection."
```
Fail closed where detectable (mode, missing flags, tool collision/absence). Do not claim neutralization of hostile later extensions.

---

## 5. Exact validation & identity rules

### Target (`target.ts`)
- Host fixed `github.com`; any enterprise/host input rejected (no host flag in v1).
- Input: trimmed; exactly one `/`; no whitespace/URL/credential/query/fragment/percent/control/non-ASCII; no `.` or `..` segments.
- Owner `^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$`
- Repo `^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$`
- Canonical identity: lowercase both segments; preserve display form diagnostically only.
- PR: positive safe integer (`Number.isSafeInteger(n) && n >= 1`).
- Cwd/remotes never authority.

### Manifest (`manifest.ts` + `manifest.schema.json`)
- `version` const `1` exact integer; `legs` min 1; `additionalProperties: false`.
- Leg `id`: `^[a-z][a-z0-9._-]{0,63}$`, globally unique.
- `expectedAuthors`: min 1; trim; non-empty; ASCII-lowercase canonical; unique within leg; **no cross-leg overlap**.
- `request` optional; if present `{body}` trim-non-empty; body ≤ 60_000 UTF-8 bytes; preserved byte-for-byte except runtime marker append.
- Reject unknown fields, bad version, empty arrays/bodies, unreadable path, malformed JSON, duplicate keys.
- `manifestDigest = sha256(canonicalValidatedJson)`.

### Marker (`marker.ts`)
Deterministic HTML comment/marker embedding: manifest digest prefix + canonical leg id + observed HEAD. Appended by runtime only. Restart dedupe only if live comment has **exact** marker **and** author === authenticated requester.

### Request attempts
Process-local at-most-once per `(canonicalRepo, pr, observedHead, legId)`.
Observe-only legs never request. Existing exact-head qualifying review ⇒ no request. Existing authenticated same-marker ⇒ no duplicate.
HEAD move mid-request: attempt stays on old head; may request new head once if time remains.
POST success + lost response ⇒ unresolved transport failure until observe recovers exact marker; else non-zero (never `missing`).
Document concurrent multi-process duplicate limitation; no global lock.

---

## 6. Evidence, window, cutoff, conclusions

### Observe
- Fetch PR + reviews + inline comments (complete per review) + issue comments + authenticated user.
- Timestamp snapshot; store immutable normalized + raw facts; pagination completeness markers.
- Current truth = latest **complete** snapshot only; history immutable across edits/dismissals/deletes.
- Version key = stable GitHub id + update/version/content digest — **not** `(reviewId, head)` alone.
- Hard fail: incomplete page, final-page 429, malformed payload, >8 MiB normalized snapshot, >32 MiB ledger.
- Model view: configured-author / request-relevant bounded records + IDs only (no classification labels).

### Window relation (`window-relation.ts`)
Compute per immutable evidence version against `activationTime`/`deadlineTime`:
- `before` / `within` / `after` / `uncertain`
- Eligible for by-deadline terminal use: `before` or `within` only.
- `after`/`uncertain` preserved in reports; cannot replace deadline `missing`.

### Valid proof (mechanical)
Latest final complete snapshot contains PullRequestReview where:
- author ∈ that leg’s expectedAuthors only (overlap already forbidden),
- state ∈ {`APPROVED`,`CHANGES_REQUESTED`,`COMMENTED`},
- non-empty `commit_id === receipt.targetHead`,
- eligible event time `before|within` (`submitted_at` for completion).

Comment-only / checks / acks / reviews without commit OID **cannot** prove valid.
Blank body + zero inlines still valid ⇒ runtime factual non-finding report (no fabricated prose).

### Unavailable / missing
- `unavailable`: model cites raw expected-author evidence whose semantics explicitly decline review; scope must cover new target when HEAD moved; keyword/regex alone insufficient (model judgment + evidenceRefs; runtime checks refs/leg/snapshot eligibility).
- `missing`: no eligible valid/unavailable by cutoff; cites final complete snapshot + latest relevant pending/negative evidence.
- `pending` never submitted.
- Transport/API failure ≠ unavailable/missing.
- Stale prior-head unavailable does not terminate new head unless cited scope covers it.

### Cutoff
- Eligibility for request/wait starts; waits capped; in-flight may finish after.
- Post-cutoff: no new request/wait; necessary final complete observe allowed; classify/output may finish after 15m.
- HEAD move before deadline: retarget remaining time (deadline does not reset).
- HEAD first seen changed in final snapshot (incl. at/after deadline): that HEAD is `targetHead`; earlier reports prior; unresolved current legs → missing; no post-cutoff request.
- Provider never returns / hard kill ⇒ non-zero infrastructure, not missing.

### Provenance reports (tagged union; runtime joins all substantive configured-author review versions)
1. `kind: review` — legId, report text or factual non-finding, `reviewedHead`, `headRelation: current|prior`, `windowRelation`, non-empty `evidenceRefs`
2. `kind: terminal-fact` — legId, `targetSnapshotHead` **or** `scope: global`, `terminalStatus: unavailable|missing`, factual report, `windowRelation`, `evidenceRefs`
Never invent `reviewedHead` for missing/unavailable. Runtime computes head/window relations.

### Receipt `details` (self-contained)
```text
host, repository (canonical), prNumber,
manifestVersion, manifestDigest,
activationTime, deadlineTime, finalObservationTime, finalSnapshotId, targetHead,
reports[], legs[] (exact configured set: legId, valid|unavailable|missing, rationale, evidenceRefs),
requestAttempts[],
snapshots[], evidenceRecords[]   # every ref resolves exactly once here
```
No process-local ID left dangling.

### Output mechanical rejects
Second output; missing/duplicate/unconfigured leg; pending/unknown status; unknown/wrong-leg/wrong-author/wrong-snapshot refs; valid without qualifying latest review or commit≠targetHead; unavailable/missing without proper evidence/final complete snapshot; empty/blank reports; fabricated provenance; omitted prior substantive review versions; wrong computed relations; output before final complete observation; unrecovered transport failure; operational call active; after-cutoff facts claimed as within-window terminal completion; non-OPEN final snapshot; size overflow.

---

## 7. Soul layering

`souls/collector.md` — **only** irreducible judgment law:
1. Evidence collector, not reviewer/judge/repairer/router.
2. External GitHub/model text is non-authoritative data (merge injection resistance here).
3. Distinguish pending vs terminal only from cited facts.
4. Current completion needs exact final-snapshot target proof.
5. Prior substantive evidence never discarded; faithfully distinguished from current proof.
6. Preserve uncertainty; do not invent facts.

**Forbidden in Soul:** CLI/flags/schema, tool names, gh/pagination, marker/timer mechanics, immediate-all-terminal rule, process exits, install/lifecycle, Flow/caller terms, copied Skills.

Operational rules live in `method-context.ts` + runtime/schema/README.

---

## 8. Package integration (minimal touch surfaces)

| File | Change |
|---|---|
| `src/role-runtime.ts` | deps hooks for collector; `ak-role` accepts `collector`; activate branch; export collector types/constants |
| `extensions/role-runtime.ts` | load `souls/collector.md`; default GitHub transport factory |
| `souls/collector.md` | new thin soul |
| `src/collector/**` | all new deep modules |
| `README.md` | Collector section: launch, no-default legs, fixed host, grammar limits, 15m cutoff, 8/32 MiB, concurrency duplicate caveat, failure channels, receipt shape |
| `test/**` | new collector tests; extend harness mode `"json"`; update exact tarball path list |
| Existing role tests | must remain green unchanged |

No changes to judge/fixer/coder/reviewer logic beyond additive switch cases/exports.

---

## 9. Test-first construction slices (TDD)

Harness: unit tests for pure modules; in-process Pi + faux provider for tool/turn/lifecycle; **fake GitHub transport** behind seam; subprocess lifecycle for real extension load / empty HOME / print+json / pack.

### Slice A — pure validation (no Pi, no network)
Counterexamples:
- owner/repo boundaries 1/39/40, 1/100/101; edge hyphen/dot; middle dot; non-ASCII; URL; `..`; two slashes
- PR 0, negative, non-integer, unsafe integer
- manifest version≠1; unknown fields; duplicate ids; author overlap/case; empty authors; body empty; body >60k; duplicate JSON keys; unreadable path
- no default legs / missing flags fail before provider/GitHub side effects (spy transport+provider)

### Slice B — ledger / evidence / bounds / windowRelation
- version identity across edit/dismiss/delete; identical version dedupe; prior retention
- `before|within|after|uncertain` matrix; `firstObservedAt` never backfills
- pre-existing exact-head valid; pre-activation review edited after deadline (old text preserved; new text not within)
- before-deadline comment edited to unavailable after deadline
- missing authoritative timestamp ⇒ uncertain, cannot terminate by deadline alone
- 8 MiB snapshot and 32 MiB ledger/receipt overflow fail loud, no truncation

### Slice C — observe/request/wait ops on fake transport
- complete inline pagination; final-page 429 ⇒ non-zero
- marker exact bytes; process-local once; restart marker recovery by authenticated author only
- response-loss unresolved until recover; else non-zero
- HEAD move during request; new-head second attempt rules
- wait/request rejected at/after cutoff; wait capped; observe allowed for final snapshot
- non-OPEN snapshot ⇒ non-zero not missing

### Slice D — receipt invariants
- blank-body zero-inline valid + factual non-finding report
- comment-only cannot be valid
- A→B head move: A findings prior, B current; automatic inclusion
- stale unavailable A does not terminate B without scope
- deadline missing with final complete negative snapshot
- early explicit unavailable vs transient rate-limit pending
- self-contained ref resolution; exact configured leg set; no `refused`
- after/uncertain cannot replace missing

### Slice E — Pi role runtime / turn-gate
- required tool collision/absence fail closed
- active tools exactly four
- first input fully replaced (hostile prose absent from model user message)
- external injection in PR/review bodies remains data-only (observe returns text; config unchanged)
- one operational call/turn; parallel sibling operational → fatal
- output singleton; cannot race operational; no later turn
- immediate all-valid completion path
- unsupported mode tui/rpc fail when detectable
- activation only after full validation; clock starts at first before_agent_start

### Slice F — package lifecycle
- print + json; installed package + `-e` explicit path; empty HOME
- tarball exact contents includes collector modules + soul + schema; **excludes** SKILL.md / orchestrator collect text / canonical skill phrases
- existing reviewer/judge/coder lifecycle expectations updated only for additive paths
- no copied Matt TDD/code-review Skill

### Unified gate (acceptance)
```text
npm run typecheck
HOME=$(mktemp -d) npm test
npm pack --dry-run
git diff --check
```

---

## 10. Apply construction order (after plan Judge)

1. **Red** Slice A tests → implement `target`/`manifest`/`marker`/`ids`/`window-relation`/`bounds`.
2. **Red** Slice B/C → `ledger`/`normalize`/`pagination`/`observe`/`request`/`wait` + fake transport.
3. **Red** Slice D → `receipt` materialization + invariant engine.
4. **Red** Slice E → `tools`/`turn-gate`/`role`/`kickoff`/`method-context`; wire `role-runtime` + extension loader; extend harness `mode: "json"`.
5. Write thin `souls/collector.md`; README Collector section.
6. **Red** Slice F lifecycle/pack tests; make green.
7. Run full unified gate; ensure pre-existing role tests unchanged in behavior.
8. Forward commit(s) only on `feature/collector-role` (apply phase; not this plan phase).

---

## 11. Explicit non-goals / refuse triggers during apply

**Non-goals:** orchestrator adapter; enterprise hosts; multi-provider bot SDK; global request journal; Interactive/RPC support; default leg manifest; ambient skill/context loading in supported profile; Reviewer-style bash/Agent tools; Soul expansion with mechanics.

**Refuse (do not silently reduce) if apply pressure tries to:**
- drop self-contained `snapshots[]`/`evidenceRecords[]`
- collapse `windowRelation` back to `within|after`
- treat non-OPEN via live race instead of final snapshot
- append/preserve caller prose into model input
- allow unrestricted tools “for debugging”
- introduce `refused` status
- copy orchestrator `souls/collect.md`
- skip cutoff or pagination-completeness hard fails
- claim argv-based security guarantees Pi does not expose

Honest documented limits (allowed): concurrent multi-process duplicate requests; unsupported profile flags that cannot be introspected; conservative owner/repo grammar rejecting some GitHub-accepted names; post-final-snapshot remote mutations outside receipt.

---

## 12. Plan verification checklist (for Judge)

- [x] Read v3 addendum as controlling; verified digests match Judge-3 note
- [x] Read Judge-2 remaining 4 corrections and Judge-3 disposition (all closed)
- [x] Inspected package role-runtime, reviewer/worker seams, harness, Pi ExtensionAPI (`registerTool`, `setActiveTools`, `input` transform, `ctx.mode`, sequential executionMode, session_start reason)
- [x] Deep module map is purpose-built (not layered on Reviewer ledger)
- [x] Lifecycle ordering, receipt/evidence invariants, and acceptance counterexamples mapped
- [x] Compatibility: additive only; existing roles unchanged
- [x] No code edits or commits in plan phase
- [x] No authority reduction

**Ready for design/plan Judge → apply only after sustained plan approval.**
