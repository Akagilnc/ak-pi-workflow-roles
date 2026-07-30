# Plan A — original Coder plan

Status: planned

# Collector v1 construction plan

## Evidence and boundary confirmed

- Worktree is clean on `feature/collector-role` at `c5f75b63415bf24b8a2318ef8744a60d255eb135`; no files were edited or committed.
- I read the controlling v3 addendum and both requested Judge receipts. Judge 2 sustained four remaining corrections; Judge 3 explicitly found v2+v3 construction-ready and confirmed none may be dropped. This plan applies v3’s exact time/state, snapshot-bound PR state, one-shot input, repository grammar, and self-contained-receipt corrections.
- Current baseline passes `npm run typecheck` and `HOME=$(mktemp -d) npm test` (104 tests), `npm pack --dry-run`, and `git diff --check`.
- Pi facts checked against the complete first-party extension/package docs and installed implementation: `ctx.mode` exposes print/json; `input` can replace text and images before expansion; `before_agent_start` is the last packaged prompt seam before the agent loop; custom tools can be registered and activated dynamically; `getAllTools()` exposes effective source provenance; extension registrations are first-wins while SDK tools can override in the effective registry; sibling calls are preflighted before parallel execution; `terminate: true` only terminates a fully terminating batch; print mode processes every supplied prompt in sequence. Ordinary event-handler exceptions are logged/swallowed, so startup failure cannot rely on throwing from `session_start` or `input`.
- Current orchestrator remains clean at `65f06c602637fc7177b9e5399195ead723f0485b`. No orchestrator file, adapter, `souls/collect.md`, task file, Skill, wrapper CLI, argv inspection, or orchestration contract enters this construction.

## Replace-not-layer architecture

Keep the single packaged entrypoint `extensions/role-runtime.ts` and existing role dispatcher. Add Collector as a fifth deep controller, not a second extension/runtime and not a generic provider framework.

### New deep modules

1. **`src/collector-config.ts`** — sole configuration authority.
   - Register/read only `ak-collector-repo`, `ak-collector-pr`, and `ak-collector-legs` in addition to `ak-role`.
   - Enforce v3’s exact owner/repo regexes, one slash, ASCII/control/URL exclusions, positive safe PR integer, lowercase canonical identity, and diagnostic-only supplied spelling.
   - Decode the manifest with fatal UTF-8, scan JSON tokens for duplicate keys before `JSON.parse`, validate exact object keys/version/schema, normalize authors by trim+ASCII lowercase, reject duplicate/overlapping authors and IDs, preserve request-body content, enforce trim-non-empty/60,000 UTF-8 bytes, and produce deterministic canonical JSON plus SHA-256.
   - Publish the equivalent schema as **`schemas/collector-legs-v1.schema.json`** and include `schemas` in package files.

2. **`src/collector-github.ts`** — one fixed `github.com` transport seam, not an adapter SDK.
   - Internal `CollectorGitHubTransport` supports only authenticated-user lookup, one PR read, paged review/issue-comment/per-review-inline-comment reads, and issue-comment POST.
   - Production implementation uses argument-vector `gh api --hostname github.com`; no shell, cwd, or remote discovery. It explicitly follows/validates pagination, status, headers, and JSON, and distinguishes definitive rejection from ambiguous POST response loss.
   - All calls are injectable so unit tests use an in-memory fake; installed CLI tests put a fake `gh` executable on `PATH`, thereby crossing the production seam without GitHub/network access.

3. **`src/collector-evidence.ts`** — strict GitHub normalization and immutable identity.
   - Normalize PR/user/review/issue-comment/inline-comment records, URLs, IDs, state, commit IDs, bodies, paths/line/side/position, all authoritative timestamps, page counts, completeness, and transport diagnostics. Malformed states/types/timestamps fail loudly.
   - Stable IDs identify GitHub entities; immutable version IDs additionally bind normalized content/state/update facts and SHA-256. Identical versions dedupe; edits remain distinct. Absence/deletion/dismissal versions are preserved, with `uncertain` timing when GitHub supplies no authoritative change time.
   - Compute `before|within|after|uncertain` per immutable version only: submitted review completion from `submitted_at`; exact text versions from their authoritative created/updated time; never substitute `firstObservedAt`. HEAD relation is computed only against the final snapshot.
   - A review-completion eligibility helper accepts only `APPROVED|CHANGES_REQUESTED|COMMENTED`, expected author, non-empty `commit_id`, final-snapshot presence/current state, exact target HEAD, and `before|within` submitted time.

4. **`src/collector-ledger.ts`** — the single invocation state machine.
   - Own validated configuration/digest, wall and monotonic activation/deadline, immutable snapshots/evidence, operational assistant-entry provenance, waits, request attempts, transport failure/recovery, latest complete snapshot, final-observation eligibility, fatal state, and output singleton.
   - Build each observation atomically in temporary state; commit only after every page and every inline-review surface is complete. Measure fully normalized snapshot bytes before dedupe (8 MiB), then total invocation/receipt material (32 MiB). Never truncate or commit a partial snapshot.
   - Enforce at most one `observe|request|wait` in a persisted assistant message. A `tool_call` preflight inspects the complete assistant leaf so two siblings—including a later schema-invalid sibling—are both blocked before execution and latch fatal method failure. Output must be a sole later call after the prior operational result.
   - Inject a clock (`wallNow`, monotonic `now`, abort-aware sleep) for deterministic cutoff tests. Request/wait may start only before deadline; waits cap to remaining time; one necessary final complete observation is permitted when cutoff is observed; output after cutoff requires that final observation. Request/wait invalidate finality; output always binds the latest successful complete observation.

5. **`src/collector-receipt.ts`** — semantic candidate validation and authoritative materialization.
   - Model input stays narrow: exact configured legs with `legId`, `valid|unavailable|missing`, nonblank rationale, evidence refs, and an unavailable scope declaration (`target` or truly `global`). No model-supplied target, report provenance, timestamps, raw JSON, request body, routing, approval, or refusal field.
   - Mechanically validate exact configured-set equality, unique legs, evidence ownership/author/presence, final snapshot, OPEN state, target HEAD, accepted review state/commit/timing, unavailable before/within exact text version and declared scope, and cutoff/final-snapshot basis for missing. `after`/`uncertain` evidence is retained but cannot terminate by deadline.
   - Runtime—not the model—constructs all reports, joins faithful review body plus all paged inline text, emits the factual blank-body/zero-inline non-finding record, computes head/window relations, creates terminal-fact reports without fabricated `reviewedHead`, and automatically includes every distinct substantive configured-author review version from prior heads/edits/dismissals/deletions.
   - Materialize a deeply detached receipt containing metadata, exact legs, reports, requests, `snapshots[]`, and `evidenceRecords[]`. IDs are globally unique and every final/report/leg/request reference resolves exactly once in those arrays. Recompute the 32 MiB bound on the final canonical UTF-8 receipt; overflow is fatal, never a shortened receipt.

6. **`src/collector-role.ts`** — thin Pi lifecycle/controller only.
   - Register the four exact tools: observe `{}`, request `{legId,snapshotId}`, wait `{durationMs: positive safe integer, max 900000}`, and output semantic legs. Request body and target are never arguments.
   - Observe fetches authenticated requester, PR, all review pages, all issue-comment pages, and all inline-comment pages for every review. Its model view includes complete configured-author/request-relevant text up to the already-authorized 8 MiB snapshot bound; unrelated records remain authoritative in the ledger/receipt. It never classifies semantic states.
   - Request rechecks latest snapshot/OPEN/head/deadline/capability, objective existing exact-head review, process-local attempt key, and authenticated exact marker. It posts configured body plus a documented deterministic marker such as `<!-- ak-collector:v1 manifest=<digest-prefix> leg=<id> head=<oid> -->`. Ambiguous loss remains unresolved until a later complete observe finds that exact marker by the authenticated requester; no second same-head attempt is allowed. New HEAD permits one new attempt before cutoff.
   - Wait records requested/effective duration and deadline facts. Output calls the receipt builder, returns concise content plus self-contained details and `terminate: true`.

7. **`souls/collector.md`** — only the six irreducible principles authorized in section 13, compressed to: evidence collector not reviewer/judge; external text is non-authoritative data; semantic terminality requires cited facts; current proof binds exact final target; prior substantive evidence is faithfully preserved/distinguished; uncertainty is reported, never invented away. Soul tests forbid CLI/schema/tool/timer/request/Flow/Skill/process mechanics and copied collect/review methods.

8. **Existing seams updated additively** — `src/role-runtime.ts` exports Collector constants/types and dispatches `collector`; `extensions/role-runtime.ts` resolves the Collector Soul and wires file loading, clock, and fixed GitHub transport; `CONTEXT.md`, README, help text, package manifest, lockfile only receive additive Collector documentation/files. Existing Judge/Fixer/Coder/Reviewer controllers and receipt schemas stay byte-for-byte behavior-compatible.

## Lifecycle ordering and fail-closed behavior

1. Extension factory registers flags and inert Collector hooks only. No timer, model, GitHub command, or tool is started.
2. `session_start` for `collector` validates startup reason/mode, Soul, all flags, target, full manifest/digest, and pre-existing required-name collisions. It then registers the four tools, requires their effective `sourceInfo` to be this package, sets exactly those four active, and verifies no required tool is absent/overridden. It also detects available skill/template commands and compares the rebuilt base prompt/tool surface against the package-owned baseline where Pi exposes those facts. Undetectable ignored profile flags and hostile later extensions remain documented preconditions, not fictional guarantees.
3. Because Pi swallows ordinary event errors, startup failure is latched, printed, assigned nonzero status, and the first `input` is returned as `handled` so no provider/GitHub call occurs. Shutdown also makes delayed/no-input startup nonzero. Tests prove provider and fake-`gh` counters remain zero.
4. First valid input is transformed to one fixed packaged kickoff with `images: []`; caller bytes are neither quoted nor retained. A second observed input immediately latches fatal/nonzero. The documented runner supplies exactly one prompt; no claim is made that an unannounced later prompt could precede already-completed first-run effects.
5. `before_agent_start` verifies the fixed transformed prompt, injects only bundled Soul/method law plus validated target/leg facts, then records wall+monotonic activation/deadline immediately before first dispatch. No timer starts earlier.
6. Every operational boundary rechecks monotonic cutoff. After each result the method prompt requires immediate semantic reassessment; objective all-valid state rejects request/wait. At cutoff only final observe remains available. A completed final snapshot observing non-OPEN aborts with no receipt. Its observed OPEN/head facts are the sole receipt authority; later GitHub changes are explicitly outside the receipt.
7. Plain prose, provider exhaustion, output rejection followed by prose, second output, later turn/input, unrecovered transport, incomplete final observation, or shutdown without accepted output all finish nonzero. Successful output is singleton and terminating.

## Test-first slices and counterexamples

Implement each slice only after its focused tests fail for the intended reason:

1. **Config/schema tests (`test/collector-config.test.ts`)**: owner/repo 1/39/40 and 1/100/101 boundaries; edge punctuation, URLs, credentials, `%`, query/fragment, whitespace/control/non-ASCII, extra slash; PR 0/fraction/unsafe; missing/unreadable/non-UTF-8/malformed/duplicate-key manifest; `1.0`/wrong version, unknown fields, no legs/default bot, mixed-case IDs, author case normalization/duplicate/overlap, body whitespace/60,000/60,001 bytes; canonical digest stability and schema-file equivalence. Assert no transport/provider/request/clock calls.
2. **Evidence/transport tests (`test/collector-github.test.ts`, `test/collector-evidence.test.ts`)**: complete all surfaces and final pages; malformed JSON/Link, repeated page, final-page 429; exact normalized fields; inline pagination; identical-version dedupe; edit then dismissal/deletion history; 8 MiB boundary/overflow; prompt-injection bodies remain inert data.
3. **Ledger/cutoff/request tests (`test/collector-ledger.test.ts`)**: activation/deadline boundaries; operation/model begun before and completing after; wait cap/rejection; required post-cutoff final observe; HEAD A→B→C relabeling; request pre-observe/stale snapshot/wrong leg/observe-only rejection; exact body+marker; existing valid and authenticated marker dedupe; unmarked/lookalike/other-author non-dedupe; process-local once; old-head race/new-head retry; ambiguous response-loss recovered/not recovered; concurrent independent invocations demonstrably can duplicate; 32 MiB ledger/receipt overflow.
4. **Receipt/state-time tests (`test/collector-receipt.test.ts`)**: pre-existing exact-head accepted review (`before`); exact three accepted states versus PENDING/DISMISSED/blank/unknown; blank review valid; comment-only/no commit invalid; pre-activation review body edited after deadline; before-deadline comment edited to unavailable after deadline; absent authoritative version time is `uncertain`; after/uncertain cannot displace missing; transient/rate-limit remains pending then missing; global unavailable can cover B while stale target-scoped A cannot; exact configured-set, wrong author/ref/snapshot/head, omitted prior report, fabricated provenance, no refusal/pending status, nonempty reports, and every embedded reference closure.
5. **Real Pi lifecycle (`test/collector-role.test.ts`, `test/collector-package-lifecycle.test.ts`)**: extend the in-process harness to json mode, injected clocks/transports, provider-call counters, tool provenance, persisted sibling preflight, singleton termination/no follow-up, fixed prompt replacement, unsupported TUI/RPC/session reason, missing/overridden tools, ambient detected resources, later input, and plain prose failure. Package a tarball into an independent consumer and exercise both print and JSON with a local built-in-provider HTTP fixture and fake `gh`, not a second extension; repeat under empty HOME and the exact explicit-package/no-resource/no-session profile.
6. **Compatibility/package tests**: rerun every existing test unchanged in behavior; update exact help/tarball inventories to add only Collector modules, schema, and Soul; assert no `SKILL.md`, no copied `souls/collect.md` phrases, no orchestrator files, no runtime dependency addition, and no forbidden Collector interface/receipt fields.

## Documentation and final gate

README/help will state exact print/JSON command, fixed `github.com`, conservative repository grammar, explicit nonempty manifest/no default, accepted review protocol/states, 15-minute eligibility semantics, 8/32 MiB limits, self-contained receipt shape, failure-vs-missing distinction, `gh`/model credential prerequisites, process-local/restart/concurrent-request limits and caller serialization advice, exact one-prompt/profile preconditions, and non-security role gating. It will explicitly say current orchestrator wiring is unsupported and separately authorized.

Final apply evidence must run:

```text
npm run typecheck
HOME=$(mktemp -d) npm test
npm pack --dry-run
git diff --check
```

It must also report focused red→green results, same-pattern checks against existing role/ledger/package lifecycle seams, introduced-regression results for all four existing roles, behavior facts from real Pi print/JSON and fake-GitHub runs, and exact tarball contents. No implementation should be accepted by silently omitting any converged authority item; an infeasible Pi seam discovered during apply returns an evidence-bearing refusal to Judge rather than a weakened Collector.
