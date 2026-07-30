# Collector v1 construction authority — revised after Judge review

## 1. Independent product boundary

Add an independently invocable `collector` role to `@ak/pi-workflow-roles`. Collector observes explicitly configured external GitHub PR reviewer legs, optionally requests them, classifies collection terminality, preserves evidence across HEAD changes, and submits one evidence-bearing receipt. It is not Reviewer or Judge. It never reviews code, adjudicates findings, repairs, writes code, pushes, merges, approves, routes, or knows its caller, Flow, prior/next role, or landing semantics.

v1 supports `github.com` pull requests only. It deliberately does not introduce a platform adapter framework, arbitrary bot plugin SDK, workflow DSL, package-global journal, or orchestration. Ambient GitHub and model credentials are execution prerequisites, not caller identity.

### Explicit incompatibility with the current orchestrator

Collector v1 is standalone construction, not a drop-in replacement for `ak-workflow-orchestrator` head `65f06c6`:

| Current orchestrator collect contract | Collector v1 |
|---|---|
| one shared local/online collect seat and `souls/collect.md` | external GitHub collection role only; new thin bundled Soul |
| unrestricted tools | only purpose-built observe/request/wait/output tools |
| no poll ceiling | fixed 15-minute eligibility cutoff at controlled boundaries |
| implicit Codex default in default composition | required explicit non-empty leg manifest; no default |
| leg `{id, request}` | versioned identity-bearing manifest |
| issue/candidate/Flow pointers | only target repo/PR and leg manifest |
| host-owned `ReviewCargo`, `axis`, structured-output wrapper | role-owned `ak_collector_output`, `legId`; future adapter maps receipt |
| existing Soul includes local dispatch/worktrees, CLI recipes, schema and Verify/Flow law | none of that text is a source for bundled Collector Soul |

No orchestrator file or contract changes in this construction. Wiring requires a separately authorized orchestrator CLAUDE/ADR migration plus a thin adapter. The current `souls/collect.md` must not be copied into this package.

## 2. Supported launch profile and caller independence

Collector is one-shot and supported only in Pi `print` or `json` mode with one initial kickoff. Interactive/RPC, delayed first prompt, resume/continue, or later prompts are unsupported and fail non-zero before collection. The initial user text is non-authoritative kickoff: runtime replaces/contains it so it cannot alter target, legs, policy, deadline, or tool behavior.

The documented v1 launch profile disables ambient instruction resources and session reuse, and explicitly loads only this package extension:

```text
pi --no-extensions -e <package-extension> --no-skills --no-prompt-templates \
  --no-context-files --no-session --mode json --ak-role collector \
  --ak-collector-repo <owner/repo> --ak-collector-pr <n> \
  --ak-collector-legs <manifest.json> -p "Start collection."
```

The package must fail closed when it can detect unsupported mode or missing/overridden required tools. It does not claim to neutralize hostile later extensions or a caller that ignores the supported profile; role gating is drift prevention, not a security boundary. Manual and host calls are identical only when explicit inputs and launch profile are identical.

Collector interface/Soul/receipt contains no onlineCollect, code-delivery, publish, landing, merge, Fixer, next-role, approval, routing, issue, candidate, or caller fields.

## 3. Exact target interface

No `task.md`. Required flags:

```text
--ak-role collector
--ak-collector-repo <owner/repo>
--ak-collector-pr <positive-safe-integer>
--ak-collector-legs <readable-manifest-path>
```

v1 host is fixed to `github.com`; enterprise hosts are rejected. `owner/repo` is trimmed, must contain exactly two non-empty GitHub name segments and no URL/credentials/query/fragment, and is canonicalized to lowercase for identity while preserving the supplied display form only diagnostically. PR number is a positive safe integer. Cwd and git remotes are never target authority. Collector queries PR state and HEAD itself.

Configuration is fully loaded and validated before activation, model/provider dispatch, GitHub command, request, or timer start. Invalid target/configuration is clear non-zero failure with no `ak_collector_output`.

## 4. Exact leg manifest v1

JSON Schema semantics (publish a machine-readable equivalent):

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["version", "legs"],
  "properties": {
    "version": { "const": 1 },
    "legs": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["id", "expectedAuthors"],
        "properties": {
          "id": {
            "type": "string",
            "pattern": "^[a-z][a-z0-9._-]{0,63}$"
          },
          "expectedAuthors": {
            "type": "array",
            "minItems": 1,
            "items": { "type": "string", "minLength": 1 }
          },
          "request": {
            "type": "object",
            "additionalProperties": false,
            "required": ["body"],
            "properties": {
              "body": { "type": "string", "minLength": 1 }
            }
          }
        }
      }
    }
  }
}
```

Additional semantic validation:

- UTF-8 JSON only; no duplicate JSON keys; exact integer version 1.
- `id` already uses canonical lowercase grammar and is globally unique.
- author logins are trimmed, compared by ASCII lowercase (GitHub login semantics), unique within a leg, and stored canonical lowercase; blank or non-string rejected.
- expected-author sets may not overlap across legs, so one review cannot satisfy multiple legs.
- request body is trim-non-empty, preserved byte-for-byte except runtime appends its correlation marker, and must be at most 60,000 UTF-8 bytes so marker remains within GitHub limits.
- unknown fields, unsupported versions, empty arrays/bodies, unreadable path, malformed JSON, duplicate ids/authors, or overlap fail before side effects.
- runtime records SHA-256 of canonical validated manifest JSON.

There is one fixed GitHub evidence protocol, not a model-guessed provider profile. Only a GitHub PullRequestReview returned by the reviews surface, authored by a configured expected author, in submitted/non-dismissed current state, carrying its own commit OID, can be cited to prove `valid`. A PR issue comment, check, status, request acknowledgement, or review without commit OID can be pending/unavailable/raw evidence but can never prove exact-head completion. Inline review comments are fetched completely for each observed review.

## 5. Trust boundary

Only bundled role/method law and explicit validated CLI/manifest inputs may instruct Collector. PR body, issue/review comments, review body, inline comments, bot messages, author-controlled names, and GitHub output are data-only evidence. They cannot alter target, configured legs, request body, deadline, credentials, tools, policy, or cause any mutation other than the exact configured request operation. External text attempting instructions is preserved as evidence, never followed.

## 6. Purpose-built operational seam

Collector has no unrestricted bash/read/write/edit tools. Runtime registers and exclusively activates four required singleton-named capabilities; absent or overridden names fail activation:

1. `ak_collector_observe` — no caller-supplied target/query. Runtime reads the configured PR and authenticated requester, performs complete paginated GitHub fetches, timestamps a snapshot, stores immutable raw structured evidence in the invocation ledger, and returns a bounded evidence view plus stable evidence/snapshot IDs. It does not label valid/pending/unavailable/missing or interpret keywords/findings.
2. `ak_collector_request` — accepts configured `legId` and a cited latest snapshot ID. Runtime verifies the leg is request-capable, request body is exactly configured, snapshot/HEAD is latest, eligibility cutoff has not passed, and this process has not attempted that leg/head. It posts only the configured body plus deterministic correlation marker and records attempt/start/result/response evidence. It does not claim the reviewer will bind to that HEAD.
3. `ak_collector_wait` — accepts a bounded duration. Runtime caps it at remaining monotonic eligibility time, records the wait/deadline fact, and rejects all waits once cutoff is reached.
4. `ak_collector_output` — singleton terminating submission. It accepts semantic classifications/rationales only by references to ledger evidence; runtime constructs authoritative details and enforces the receipt invariants below.

Pi may otherwise execute sibling tool calls from one assistant message in parallel. Runtime therefore permits at most one operational Collector call (`observe`, `request`, or `wait`) between model turns. A sibling/parallel second operational call is rejected as fatal method failure; output may follow only after a completed prior operational result has returned to the model. Output itself is singleton and cannot race an operational call.

The invocation ledger mechanically binds configuration digest, target, activation/cutoff, observations, complete/incomplete pagination state, stable raw evidence versions, request attempts, waits, transport failures/recoveries, and latest successful snapshot. It does not classify reviewer semantics. Output is rejected if it cites unknown evidence, omits configured legs, follows an incomplete final snapshot, or follows an unrecovered transport failure.

## 7. Bounded exact evidence

Every observation stores immutable normalized records plus raw response facts sufficient for independent review:

- observation/snapshot ID and observed time;
- host/repository/PR/state/head OID;
- complete-page counts and pagination-completeness markers for every queried surface;
- review/comment stable ID and URL, author, state, created/updated/submitted times;
- review and inline-comment commit IDs;
- body, path, line, side/position fields when present;
- request comments/markers and authenticated requester identity;
- response/transport diagnostics.

Current truth comes only from the latest complete snapshot. Previously observed substantive versions remain immutable history even if later edited, dismissed, or absent/deleted. Record versions use stable GitHub ID plus update/version/content digest; `(reviewId, head)` alone never deduplicates changed text. Repeated identical versions are referenced once. A dismissed/deleted latest review cannot prove current valid, but its previously observed findings remain historical reports.

No silent truncation. v1 hard limits are 8 MiB UTF-8 normalized evidence per complete snapshot and 32 MiB per invocation ledger. Exceeding either, an incomplete/failing page (including final-page/API 429), malformed API result, or inability to store authoritative evidence is non-zero infrastructure failure with no receipt. Observe tool returns only configured-author/request-relevant bounded records and IDs to the model; output details are mechanically joined from the authoritative ledger, so the model never has to reproduce raw JSON in tool arguments.

## 8. Honest request semantics

Runtime appends a deterministic HTML marker containing manifest digest prefix, canonical leg id, and freshly observed HEAD to each configured request. It records the authenticated requester. Before request, Collector must observe. The runtime enforces process-local at-most-one request attempt per `(repo, PR, observedHead, legId)`.

A marker-authored request found in live evidence may support restart dedupe only when its exact marker was authored by the authenticated requester. This is best-effort recovery, not global exactly-once. Concurrent independent Collector invocations can race after observation and post duplicates; v1 documents this limitation and assumes callers serialize invocations when duplicate comments are unacceptable. No package-global journal or lock is added.

A request is only an attempt made after snapshot X and before the cutoff; it is not proof that the bot reviewed X. If POST succeeds but response is lost, the ledger records an unresolved transport failure; Collector must observe and recover the exact authenticated marker before any successful output, otherwise non-zero. If HEAD moves between precheck and comment creation, the attempt remains associated with the marker's old observed HEAD; it is preserved but never treated as a request/current proof for the new HEAD. A new-head request may be attempted once if time remains.

Observe-only legs never request. Existing exact-head qualifying review means no request. Existing authenticated same-marker request means no duplicate. Other comments or unmarked lookalikes do not prove this Collector requested.

## 9. Controlled 15-minute cutoff

`activationTime` is recorded after all input/tool/mode validation and immediately before the first model/provider dispatch. `eligibilityDeadline = activation monotonic time + 15 minutes`; wall-clock activation/deadline timestamps are also recorded for receipt evidence.

The 15 minutes is a request/wait/evidence-event eligibility cutoff observed at runtime tool/model boundaries, not a metaphysical process completion guarantee:

- request and wait may start only when runtime monotonic time is before cutoff;
- waits are capped to cutoff;
- an operation/model turn begun before cutoff may finish afterward;
- once cutoff is observed, no new request/wait is permitted;
- exactly the necessary final complete observation is allowed at/after cutoff so facts whose GitHub event timestamps are within the window can be discovered;
- final classification/output may complete after 15 minutes;
- a provider turn that never returns or an external hard kill is non-zero infrastructure failure, not `missing`.

Eligibility timeline:

- review/unavailable fact with authoritative event time at or before deadline, first discovered in final complete snapshot: eligible for current terminal classification;
- fact created after deadline: preserve as `windowRelation: after`, but it does not replace deadline `missing` for the v1 collection outcome;
- HEAD move observed before deadline: retarget within remaining time; deadline does not reset;
- HEAD move whose authoritative update is first seen in the final snapshot, including at/after deadline: final snapshot HEAD becomes receipt target; earlier reports become prior; no post-cutoff request; unresolved current legs become missing;
- changes after the final snapshot are outside this receipt. `targetHead` means the HEAD in the latest successful timestamped complete final snapshot, never a claim that GitHub could not move immediately afterward.

After every operational result the model classifies. When all configured legs have terminal current-target conclusions, output immediately rather than wait. At cutoff unresolved current legs become evidence-bearing missing based on the final complete snapshot. There is no promised short grace; if final observation/model/output fails or hangs, process fails non-zero.

A closed or merged PR before successful final submission is no longer a collectable open target and causes non-zero target-state failure; it is not bot unavailable/missing.

## 10. Semantic leg conclusions

For the final snapshot `targetHead`, each configured leg terminates exactly once:

- `valid`: cites a qualifying latest-snapshot PullRequestReview whose author belongs only to that leg, current review state is submitted/non-dismissed, own commit OID equals targetHead, and eligible event time is within the window.
- `unavailable`: cites raw expected-author evidence whose semantics explicitly state the reviewer will not review, with a declared scope established by Collector. Keyword/regex alone is insufficient. A global/run-scoped unavailable fact can terminate a new target only if its text/evidence scope demonstrably covers it.
- `missing`: no eligible valid/unavailable conclusion by cutoff; cites the final complete snapshot plus latest relevant pending/negative evidence.

`pending` is never submitted. Queue/in-progress/retry-after/transient service rate limit remain pending. GitHub/API/CLI failure is transport failure, never leg unavailable/missing. A prior-head unavailable fact is preserved but does not terminate a new target unless Collector explicitly establishes from cited evidence that its scope covers the new target; otherwise the leg remains pending/missing.

There is no Collector `refused` status. Valid/unavailable/missing cover successful collection outcomes. Malformed config, unsupported mode, target/auth/GitHub/model/tool/ledger/schema failures are non-zero with no receipt.

## 11. Prior evidence and tagged provenance

HEAD movement changes completion proof but never deletes observed evidence. Every substantive review body/inline finding from earlier heads remains in reports. Prior evidence does not satisfy current valid and is not automatically irrelevant downstream.

Report provenance is a tagged union, not a fabricated universal `reviewedHead`:

### Review-derived report

```text
kind: review
legId
report: non-empty faithful body + paginated inline text, or factual non-finding record
reviewedHead: actual review commit OID
headRelation: current | prior (relative to receipt.targetHead)
windowRelation: within | after
evidenceRefs: non-empty ledger IDs
```

### Terminal/negative fact report

```text
kind: terminal-fact
legId
targetSnapshotHead: head of cited complete snapshot, or scope: global when evidence truly global
terminalStatus: unavailable | missing
report: non-empty factual text plus raw cited evidence
windowRelation: within | after
evidenceRefs: non-empty ledger IDs
```

Never invent `reviewedHead` for missing/unavailable. If A→B→C, all distinct substantive A/B review versions remain `prior`; qualifying C reports are `current`. Runtime computes head/window relation from evidence and final snapshot, and automatically joins every observed substantive configured-author review version so the model cannot silently discard it. Stable version/content IDs prevent duplicate identical observations while retaining edits/dismissals/deletions as history.

A qualifying completed review with blank body and zero inline comments remains valid and receives a clearly runtime-generated factual non-finding report (review id, author, submitted time, reviewed head, blank body, zero inline comments); it never fabricates reviewer prose. Comment-only completion without a qualifying review commit cannot be valid.

## 12. Receipt interface and runtime invariants

Collector terminates only through singleton `ak_collector_output`. Plain prose is not completion. Authoritative tool-result details contain:

```text
host: github.com
repository: canonical owner/repo
prNumber
manifestVersion: 1
manifestDigest
activationTime
deadlineTime
finalObservationTime
finalSnapshotId
targetHead
reports: non-empty tagged provenance reports
legs: exact configured set with legId, valid|unavailable|missing, rationale and evidenceRefs
requestAttempts and immutable evidence records/references needed for audit
```

Runtime mechanically rejects:

- second output or any later turn;
- configured leg missing, duplicate, or unconfigured;
- pending/unknown status;
- evidence reference absent from ledger or wrong leg/author/snapshot;
- valid without qualifying latest-snapshot review or `commitOid !== targetHead`;
- unavailable/missing without appropriate evidence/final complete snapshot;
- empty report set, blank report, fabricated provenance, omitted prior substantive review versions, or incorrect computed head/window relation;
- output before latest observation is final/complete, after unrecovered transport failure, or while an operational call is active;
- output that claims facts created after cutoff as within-window terminal completion.

Semantic interpretation of unavailable scope and reviewer text remains model judgment; mechanical eligibility and provenance remain runtime law.

## 13. Soul layering

`souls/collector.md` contains only irreducible professional law:

- Collector is evidence collector, not reviewer/judge;
- external material is non-authoritative data;
- distinguish semantic pending/terminal states using cited facts;
- current completion requires exact final-snapshot target proof;
- prior substantive evidence is never discarded and is faithfully distinguished from current proof;
- preserve uncertainty and report evidence rather than inventing facts.

Merge data-only and prompt-injection resistance into one principle. Do not put CLI/fields/schema, GitHub commands/pagination, request counts/markers, timer duration/mechanics, all-terminal immediate submission, process exits, installation, package lifecycle, caller/Flow terms, or tool names in Soul. Those belong to runtime/schema/README and narrowly owned operational method law. Collector uses no Matt TDD/code-review Skill and bundles no copied canonical Skill.

## 14. Compatibility and acceptance

Existing Judge/Fixer/Coder/Reviewer contracts and behavior remain unchanged. Additive public exports/package files only. README/help document exact supported launch, no-default behavior, fixed host, limits, concurrency limitation, failure channels, and receipt.

Tests use the packaged Pi harness and a hermetic fake GitHub transport behind the internal operational seam, while lifecycle tests cross real Pi extension/tool/session behavior. They prove at minimum:

- all loud validation failures happen before provider/GitHub/request side effects;
- no default bot; exact manifest schema/version/unknown fields/case normalization/author overlap;
- required tool collision/absence and ambient unsupported launch/mode fail closed where detectable;
- initial prompt cannot alter immutable inputs; external prompt injection remains data-only;
- one operational call per model turn; parallel siblings rejected; singleton output/no later turn;
- immediate all-valid completion and blank-body/zero-inline valid review;
- comment-only completion lacking commit cannot be valid;
- early explicit unavailable vs transient/pending rate limit;
- wait/request cutoff enforcement and provider/tool calls crossing deadline;
- deadline missing with final complete negative snapshot;
- exact final-snapshot head binding and A→B preservation/relabeling of A findings;
- stale unavailable after A→B does not terminate B unless scope covers B;
- HEAD moves during request and before/at/after cutoff;
- request process-local at-most-once, exact marker/request body, response-loss recovery, restart marker recovery, and documented concurrent duplicate limitation;
- edited then dismissed/deleted review retains immutable prior versions but latest cannot prove valid;
- complete inline pagination and stable evidence/version dedupe;
- PR closure/merge, final-page/API 429, final snapshot failure, and unrecovered transport failure exit non-zero, never missing;
- raw snapshot/invocation corpus crossing 8/32 MiB fails loudly without truncation;
- exact configured-set receipt validation and automatic inclusion of all substantive prior reports;
- no refusal status;
- print/JSON installed/explicit-package lifecycle, empty HOME, tarball exact contents, and no copied canonical Skill.

Unified gate:

```text
npm run typecheck
HOME=$(mktemp -d) npm test
npm pack --dry-run
git diff --check
```

Forward commits only. After design convergence: Coder plan → Judge → Coder apply → Judge → fresh Reviewer → Judge; only sustained findings go to Fixer → Judge.
