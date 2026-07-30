# Plan: Reviewer protocol research documentation seams (corrected, HEAD d26033e)

## Baseline

- **HEAD:** `d26033eb8a95a501c1d1a62da718ac3d7f49d56e` (clean worktree)
- **Authority:** ADR 0010 accepted (owner 2026-07-28): callers own composition/order/repetition/disposition; roles own only single-invocation interior; packet presence may be validated, Judge authorship must not be required
- **Prior related work:** `04c2ad4` added ADR 0010 + Collector glossary only; did **not** clear Fixer/Coder/README/tool Judge-topology text. Research landed undifferentiated in `7cbbaf4`
- **Runtime truth today:** validates packet/task presence and per-invocation phase/status/`commitSha` invariants only (`src/worker-role.ts` `validateWorkerOutput` + `requireSingletonSubmissionCall`). No provenance guard, topology mechanism, or ADR/README/Soul consistency test exists or will be added
- **Exact-metadata oracle** (`test/judge-role.test.ts:371,375,393,397`) is green **because it snapshots the contradictory Judge-directed tool wording** — retarget those exact strings only
- **Judge note:** Standards #1 and future-design Spec are one layering/status-blur root; Standards #2 spans Fixer Soul + tool metadata + Coder caller guidance. No new guard justified. Scope = documentation/tool-metadata text + exact-string expectation updates only

**Non-goals (packet + judge, absolute):** no runtime/schema/transport/receipt/profile/protocol mechanism; no provenance/topology/generalized consistency test; no relaxing assertions; no amend/history rewrite; no baseline-smell carry-forward

---

## Root 1 — ADR 0010 caller-ownership false across textual surfaces

### Behavior

Every package textual surface that currently encodes **worker provenance** (packet must be Judge-authored) or **next-role / Flow routing** (report returns to Judge; orchestrator is mandatory traffic) must instead describe:

1. **Caller-supplied inputs** (repair packet / task present and sufficient — authorship irrelevant)
2. **Caller-owned disposition** (who reads the receipt, whether Judge is involved, optional orchestrator)
3. **Role interior only** (phase discipline, evidence, refuse-vs-fake-success)

Legitimate **Judge-role** descriptions (what Judge does when invoked; verdict contract; Judge toolset; Judge audit) stay. They are not worker provenance claims.

### Repository-wide topology disposition

Every current hit is classified. Only **EDIT** rows change in apply.

#### EDIT — false worker provenance / mandatory routing (in scope)

| Anchor | Current text (summary) | Disposition |
| --- | --- | --- |
| `CONTEXT.md:10` Fixer | “处理**判官**修理包”; commit “供**判官**查证” | Caller-supplied packet; advisory evidence **for the caller** |
| `CONTEXT.md:11` Coder | report “供**判官**审理”; refusal “交**判官**裁决” | Evidence for **caller** disposition; refusal is zero-commit return to **caller** |
| `README.md:46` Fixer intro | “**judge-authored** Markdown repair packet” | “**caller-supplied** Markdown repair packet” |
| `README.md:75` Fixer receipt | `commitSha` “for **the judge**”; “**the judge** decides whether to escalate”; “transports … **back to the judge**” | `commitSha` advisory **for the caller**; refused carries owner-decision evidence; **caller owns next step** (may or may not involve Judge); delete mandatory back-to-Judge transport sentence |
| `README.md:84` Coder apply row | “Execute the **Judge-approved** plan” | “Execute the **approved** plan” |
| `README.md:86` Coder refuse | “returns to the **Judge** for adjudication” | “returns to the **caller** for disposition” |
| `README.md:110` Coder report | self-check results “for **the Judge**” | “for the **caller**” (report/audit requirements unchanged) |
| `README.md:181` package close | “Workflow ordering and routing belong to a **separate orchestrator**.” | **Caller ownership / optional-orchestrator** wording, e.g. “Workflow ordering and routing are **caller-owned**. A separate orchestrator is optional infrastructure, not a package requirement.” (closes the residual ADR 0010 contradiction outside Fixer/Coder sections) |
| `souls/fixer.md:3` | fix packet “**判官签发**” | Input packet is the round’s repair packet; **no issuer** |
| `souls/fixer.md:18` | “**判官**给的是痛处与约束” | “**修理包**给的是痛处与约束” |
| `souls/fixer.md:31` | refused → “**交判官复判**” | Write evidence in `refused`; **no named downstream** |
| `souls/fixer.md:52-56` | commitSha “给**判官**查证”; owner “由**判官**决定是否叫人”; “不直连 reviewer / 不决定 `converged` / **调用 Flow** … **再由判官复判**” | See **Fixer Soul layering audit** below — delete topology **and** mechanically owned status matrix; keep irreducible judgment only |
| `src/worker-role.ts:169` Fixer `description` | “commitSha is advisory evidence **for the judge**.” | “commitSha is advisory evidence.” **or** “… for the caller.” |
| `src/worker-role.ts:173` Fixer `promptGuidelines` | “for **the judge to adjudicate**” | “for **the caller to dispose**.” |
| `src/worker-role.ts:274,278` Coder same pair | identical Judge consumer wording | Same caller-disposal rewrite |
| `test/judge-role.test.ts:371,375,393,397` | exact snapshots of the four tool strings above | Retarget to the new exact strings only |
| `docs/adr/0003-per-role-submission-tools.md` (status **`proposed`**, not safely “historical”) Judge-consumer clause | “Git commit 是供**判官**核查的客观证据…” | **Not** classifiable as inert history. **Action:** mark that single Judge-consumer clause **superseded by accepted ADR 0010**, and reword the surviving sentence to caller-owned advisory evidence (e.g. “Git commit 是供**调用方**核查的客观证据…”). Leave the rest of 0003 (named per-role tools, fixer two-phase envelope, package owns contract shape) intact under its existing `proposed` status. Do **not** silently treat whole 0003 as nonnormative without this supersession note |

#### KEEP — legitimate Judge-role or correct anti-routing text (out of edit scope)

| Anchor | Why keep |
| --- | --- |
| `CONTEXT.md:9` Judge definition; `:16` Soul-compliance audit about Judge | Defines the Judge role / Judge audit when that role is used |
| `CONTEXT.md:18-19` 角色调用 + 编排器 glossary | Already states caller owns composition; Orchestrator is defined as **out-of-package optional traffic**, not a worker duty |
| `README.md` Judge section (`:5-42`), Verdict contract (`:171-179`) | Describes Judge when invoked; `note` already “no built-in routing” |
| `README.md:134` Reviewer | Correctly denies findings→approval/routing/next-role |
| `README.md:140` Collector | Correctly “not Reviewer or Judge … or routes” |
| `README.md:169` “current orchestrator wiring is unsupported…” | Collector migration fact, not Fixer/Coder provenance law |
| `souls/judge.md` entire | Is the Judge |
| `souls/coder.md`, `souls/reviewer.md`, `souls/collector.md` | Already free of mandatory Judge-next topology |
| `docs/adr/0010-…` entire | Accepted authority for this repair |

#### KEEP with explicit classification — Flow/orchestrator ADR text (not worker provenance; do not rewrite campaign)

| ADR | Status | Classification |
| --- | --- | --- |
| `0001-roles-grow-by-demand.md` | `proposed` | Package-growth law: roles enter when real Flow/e2e demand pulls them; orchestrator **seat soul-path removal** at integration time. “Flow” here is **demand signal / integration moment**, not a worker-facing next-role obligation. **Nonnormative-to-workers; leave text.** |
| `0002-package-first-sequencing.md` | `proposed` | Sequencing: package standalone first; existing orchestrator becomes thin caller later. Reinforces package ≠ orchestrator. **Leave.** |
| `0004-targethead-binding-check.md` | `deferred` | About **Judge receipt** `targetHead` binding when a real binder appears. Legitimate Judge-domain deferral. **Leave.** |
| `0005-soul-layering-…` | `proposed` | Judge Soul generic-law rewrite; host/orchestrator overlay owns business law. Not worker provenance. **Leave.** |
| `0006-soul-audit-…` | `proposed` | Judge compliance-audit model policy; mentions phase-2 orchestrator only as future pull. **Leave.** |
| `0008-role-gating-…` | `proposed` | Judge toolset narrowing. **Leave.** |

**Boundary rule for apply grep:** after edits, worker-facing surfaces (Fixer/Coder Soul, CONTEXT Fixer/Coder lines, README Fixer/Coder sections, README:181, worker tool metadata) must not require Judge authorship or name Judge/Flow as mandatory next hop. Judge sections and the classified ADRs above may still say “判官/Judge/orchestrator” in their proper domains.

### Fixer Soul layering audit (`souls/fixer.md`)

CLAUDE.md / project Soul discipline: Soul = irreducible professional judgment only. Schema owns field shapes; TypeScript runtime owns mechanical invariants; tool metadata owns transport hints.

#### Remove from Soul (mechanically owned — do **not** replace with new runtime guards or tests)

| Soul material today | True owner already in tree | Disposition |
| --- | --- | --- |
| “最终只调用一次 `ak_fixer_output`” (singleton invocation) | `requireSingletonSubmissionCall` in `src/worker-role.ts` | **Delete** from Soul |
| Status matrix bullets: plan→`planned` without `commitSha`; apply→`completed`; refused±`commitSha` | `workerOutputSchema` + `validateWorkerOutput` phase/`commitSha` rules | **Delete** exact combination law from Soul |
| “你不输出 escalate” as Soul law | Schema enum is only `planned\|completed\|refused`; escalate is impossible at the tool boundary. Tool guideline may keep a one-line “never escalates” transport hint | **Delete** from Soul (keep brief tool-metadata line only if still accurate after caller rewrite) |
| Closing topology paragraph: no direct reviewer, no `converged`, Flow transports back to Judge | ADR 0010 + caller ownership; Reviewer/Judge are other roles | **Delete** entire Flow/reviewer/converged/判官复判 closing |
| “交判官复判 / 由判官决定是否叫人” | Caller disposition | **Delete**; replace with “需要 owner 决策时写进 refused report，由**调用方**处置” as judgment about refusal content, not routing |

#### Retain in Soul (irreducible repair judgment)

- Phase intent: do not cross `plan`/`apply` duties; do not fabricate completion declarations
- `plan`: investigate real code/history; minimal verifiable plan; no code/test/doc/git mutation; `planned` or evidence-bearing `refused`
- `apply`: execute approved repair; self-verify; create new forward commit only; never amend/rewrite history; `completed` or `refused`
- Startup: read full packet, issue/authority pointers, and code; consult `git log` for same-shape failed fixes and do not resubmit that method family
- Packet supplies pain points and constraints, **not necessarily the final cut**
- When divergent/root-unclear/repeated-seam/flake: minimize with evidence-driven diagnosis; do not pile speculative guards
- Tests/AC are a red line: no weakening assertions, deleting failed paths, or rewriting AC to force green unless packet authority explicitly allows
- Delete-over-add; fix class not point; do not expand past packet/authority
- If packet conflicts with authority, facts no longer hold, or safe completion is impossible: no empty commit; return `refused` with evidence
- Apply self-check professional sequence: blast radius, declared typecheck/tests/acceptance, authorized worktree only, one new forward commit with required title prefix and body, HEAD strict forward descendant of start HEAD
- `report` is complete Markdown (what was fixed, refused, evidence, verification)
- Git forward commit is **repair evidence**, not the complete role output; `commitSha` when present is advisory self-report, not mechanical ground truth

**Green Soul shape (intent, not frozen prose):** short role identity + phase judgment + startup judgment + repair principles + apply self-check + thin handoff line (“submit through the role output tool with an evidence-bearing report; caller owns disposition”). No status/`commitSha` matrix, no singleton catechism, no Judge/Flow topology.

### Owner (Root 1)

| Surface | Path |
| --- | --- |
| Glossary | `CONTEXT.md` Fixer + Coder lines |
| Caller docs | `README.md` Fixer + Coder sections **and** `:181` closing routing sentence |
| Bundled Soul | `souls/fixer.md` (topology **and** mechanical-rule removal) |
| Tool metadata | `src/worker-role.ts` Fixer + Coder `description` + `promptGuidelines` |
| ADR supersession | `docs/adr/0003-per-role-submission-tools.md` Judge-consumer clause only |
| Exact oracle | `test/judge-role.test.ts` metadata fixtures at the four string sites |

### Red

All EDIT rows above are present on `d26033e`. Residual package-level contradiction at `README.md:181` was missing from the prior plan and is now in scope. ADR 0003 remains `proposed` with a live Judge-consumer sentence that still contradicts ADR 0010. Fixer Soul still mixes topology with schema/runtime catechism.

### Green

- Worker text: caller-supplied inputs + caller-owned disposition; no mandatory Judge next-hop; no mandatory orchestrator
- Fixer Soul: judgment-only; mechanical invariants left to existing runtime/schema
- ADR 0003 Judge-consumer clause explicitly superseded by ADR 0010 and reworded to caller
- Exact metadata tests match new tool strings
- Judge-role surfaces and classified Flow/orchestrator ADRs unchanged in meaning

### Scope

- **In:** text on owners above; exact-string test retargets; 0003 one-clause supersession note + caller reword
- **Out:** runtime validation changes; new guards/tests; schema/phase changes; Judge Soul; bulk ADR status graduation; inventing orchestrator features

### Verification (Root 1)

- `rg` worker-facing paths for mandatory Judge-next / Flow-routing / judge-authored packet (Fixer/Coder Soul, CONTEXT Fixer/Coder, README Fixer/Coder, README:181, `src/worker-role.ts` metadata) → zero hits
- Confirm Judge section, Reviewer/Collector anti-routing lines, and classified ADRs still coherent
- Confirm `souls/fixer.md` no longer restates singleton / status×`commitSha` / escalate-impossibility matrices
- `npm test` (especially `test/judge-role.test.ts`) + `npm run typecheck` + `git diff --check`

---

## Root 2 — Research doc blurs accepted policy / current v1 / observations / future sketches

### Behavior

`docs/research/external-reviewer-protocols.md` must not present unaccepted designs as v1 contracts. **Thin owner-approved adaptation rationale** moves to the ADR layer. Research **cites** that ADR, then separates **Current v1 (implemented)** from **non-normative observations** and **unaccepted future sketches**.

### Owner

| Layer | Path |
| --- | --- |
| Accepted policy (thin) | **New** `docs/adr/0011-collector-adapts-to-documented-reviewer-protocols.md` (or next free number), **status: accepted**, owner date 2026-07-28 |
| Research restructure | `docs/research/external-reviewer-protocols.md` |
| Current v1 truth sources (**cite only**) | `schemas/collector-legs-v1.schema.json`; `src/collector-github.ts` + `src/collector-ledger.ts` transport surfaces; `src/collector-receipt.ts` / `src/collector-tool-schemas.ts` / `src/collector-role.ts` status rules |

### Red (status blur on current head)

1. Top “Decision summary” reads as package-normative decision + provider terminal matrix
2. “Collector design requirements” + sample JSON with `"protocol": "codex-hosted-github-v1"` read as usable manifest contract — **v1 schema has no `protocol`** (`additionalProperties: false`; required only `version` + `legs[{id, expectedAuthors, request?}]`)
3. Four-state “operation state: pending, completed, unavailable, missing” contradicts submitted statuses **`valid | unavailable | missing`**
4. Shared evidence list includes **reactions / check runs / commit statuses** — v1 transport observes only **user, pull request, pull-request reviews, issue comments, review comments** (`getAuthenticatedUser`, `getPullRequest`, `listPullRequestReviews`, `listIssueComments`, `listReviewComments`)
5. No durable separation of accepted policy vs implemented v1 vs repo observations vs unaccepted proposals

### Green — thin accepted ADR 0011 (rationale only)

Single decision paragraph, no profile shapes:

- **Decision:** Collector should adapt to each reviewer’s **documented** completion forms rather than require every leg to emit a GitHub `PullRequestReview`
- **Consequences:** (1) accepted policy does **not** ship profiles, manifest `protocol` fields, expanded transport, or expanded submitted statuses; (2) v1 may remain review-shaped until a future accepted change; (3) undocumented repo observations are not terminal rules without first-party support **and** captured fixtures
- **Non-goals inside ADR:** no JSON examples, no profile names, no four-state model, no reactions/checks/statuses design

### Green — research doc target shape

```
# External GitHub reviewer protocols
Research snapshot: 2026-07-28

## How to read this document
- Accepted policy → cite ADR 0011 only
- Current v1 (implemented) → descriptive truth of today’s code/schema
- Observations (non-normative, dated) → repository evidence with durable object anchors
- Future sketches (unaccepted, unimplemented) → not usable contracts

## Accepted policy
Cite ADR 0011 adaptation rationale (one short restatement + link). No design.

## Current v1 (implemented)
Cite schema/transport/receipt seams. State accurately:
- legs manifest (`collector-legs-v1`): `version: 1` + `legs[]` with `id`, `expectedAuthors`, optional `request.body` only;
  **no `protocol` field**; unknown fields rejected
- transport surfaces: authenticated user, pull request, submitted pull-request reviews,
  issue comments, review comments only;
  **no reactions, check runs, or commit statuses** in v1 transport
- valid completion (existing receipt rule): qualifying **submitted review** with exact-HEAD `commit_id`
  from an expected author on the final snapshot (plus existing cite/embedding rules)
- **submitted** leg statuses: `valid | unavailable | missing` only
- `pending` is **internal/semantic only** and **never submitted**; there is **no** Collector
  `refused` / submitted `completed` status
- `unavailable` requires `unavailableScope: target|global`

## Observations (non-normative)
Provider notes + durable object URLs/IDs from Root 3. Explicitly dated; not contracts;
no profile terminal rule may derive from them.

## Future sketches (unaccepted / unimplemented)
Banner: not usable contracts; require first-party docs + captured API fixtures before any acceptance.
Contents moved under this banner only:
- protocol profiles (`codex-hosted-github-v1`, `coderabbit-github-v1`, `cursor-bugbot-github-v1`, …)
- manifest `protocol` field JSON example
- extended transport (reactions / check runs / commit statuses)
- four-state operation model + review-outcome / binding-kind / provenance split
- profile interpretation bullets formerly written as “should therefore”
```

**Preserve Root 2 separation exactly:** ADR owns **only** adaptation rationale; Current v1 section **cites existing** schema/transport/receipt rules and states that **no** protocol field/profile and **no** expanded transport/status exist today; **all** profile shapes stay under unaccepted future sketches.

### Scope

- **In:** new thin ADR + research restructure/citations
- **Out:** runtime/schema/profile implementation; transport expansion; receipt state changes; new generalized tests

### Verification (Root 2)

- Research never asserts v1 has `protocol`, reactions/checks/statuses transport, or submitted `pending`/`completed`
- ADR 0011 contains rationale only (no profile JSON / four-state / transport design)
- `npm test` + `npm run typecheck` remain green without code-path changes

---

## Root 3 — Unsupported Codex/Cursor terminal-authority claims

### Behavior

Repository observations and overloaded fields must not be labeled **documented** or authorized as **terminal profile rules** without first-party support **and** a captured fixture. Keep useful observations as **dated, non-normative** evidence pinned by **stable object URLs/API IDs** (not merely PR container URLs + a commit SHA). No profile terminal rule may derive from them in this repair.

### Owner

`docs/research/external-reviewer-protocols.md` provider sections (Codex, Cursor, CodeRabbit observation anchors), under the Observations / Future sketches split from Root 2. First-party claims that already checked out remain.

### Red

1. Codex table/prose treat PR-level `+1` + commit-naming issue comment as **documented / native no-findings form** and authorize profile acceptance — that form is **repo observation**, not the cited OpenAI contract (OpenAI docs cover `@codex review` + standard GitHub review / thumbs-up **description**; they do not make this repository’s comment+reaction pair a captured package fixture or terminal rule)
2. Cursor unavailable / profile text claims check output **distinguishes** findings / cancellation / internal error / quota — cited Cursor docs define overloaded `neutral` but **no stable check-output discriminator** is established
3. Quota path sits beside classification rules without an observation-only label
4. Prior plan’s PR #4/#5 anchors were container URL + commit SHA only — **insufficient** for mutable issue comments, reviews, checks, statuses, reactions
5. Prior plan’s “`c73bf31…` PR-level `+1` reaction” is **absent** from the current PR #5 reaction listing and has **no captured fixture/ID** — must **not** be stated as fact. Current sole Codex `+1` on PR #5 is reaction **`428138437`** (`2026-07-28T13:17:06Z`), which pairs with the **later** no-findings comment for `f01c9bf854` (`#issuecomment-5104638115`) — **do not substitute** it as the c73 observation

### Green — claim treatment

| Claim | Treatment |
| --- | --- |
| OpenAI `@codex review` + standard GitHub review pages | Keep as **documented** trigger/findings surface; cite existing OpenAI URLs |
| Hosted connector ≠ `openai/codex-action` | Keep |
| Codex no-findings on roles PR #5 @ `c73bf31a3d22815b26b9a33a5d28fd1f242f5701` | **Observation only** (see durable anchors). **Not** documented terminal form; **not** profile-authorized. Note comment mutability. **Do not claim** a c73-era PR-level `+1` reaction |
| “Accept documented no-findings native form” profile bullet | Future sketch only; conditional on first-party support **and** captured API fixtures |
| Cursor documented `success` / `neutral` / `failure` meanings | Keep as **documented** (success = no issues & no unresolved earlier Bugbot comments; neutral overloaded; failure when fail-on-unresolved enabled) |
| Enterprise analytics `commit_sha` / `bugs_found` | Keep as documented API fields; **not** a GitHub-check discriminator |
| Reliable discrimination of neutral subtypes via check output | **Remove / negate** until first-party support + fixtures exist |
| Quota neutral check + usage-limit issue comment | **Observation only** with durable anchors below |
| CodeRabbit documented triggers / progress / rate-limit | Keep as documented |
| CodeRabbit PR #4 multi-surface demo | **Observation only** with durable anchors; still non-normative |
| GitHub object semantics (reviews/comments/reactions/checks/statuses as platform facts) | Keep in explanatory “why one universal review-object rule fails” material; do **not** imply v1 transport implements reactions/checks/statuses |

### Green — durable object anchors for every retained unsupported observation

All remain **explicitly dated, non-normative**. IDs verified against live GitHub API at plan time on `Akagilnc/ak-pi-workflow-roles`.

#### Codex — PR #5 no-findings observation @ `c73bf31a3d22815b26b9a33a5d28fd1f242f5701`

| Object | Durable anchor |
| --- | --- |
| PR container (context only) | https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5 |
| Target commit | `c73bf31a3d22815b26b9a33a5d28fd1f242f5701` |
| No-findings **issue comment** | **API id `5102352848`** · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5#issuecomment-5102352848 · author `chatgpt-codex-connector[bot]` · `2026-07-28T09:27:54Z` · body includes `Didn't find any major issues` and `Reviewed commit: c73bf31a3d` |
| PR-level `+1` reaction for this c73 run | **REMOVED from factual claims** — not present in current PR #5 reactions listing; no captured reaction id/fixture for a c73-era reaction. **Do not use** reaction `428138437` (that id is the later `f01c9bf` run at `2026-07-28T13:17:06Z`) |
| Negative structured surfaces for this observation | State as observation: no `PullRequestReview` and no Codex check run established for this no-findings form on that commit (findings-shaped Codex reviews on PR #5 exist for **other** SHAs, e.g. review id `4793710774` @ `a817975c…`, and are out of scope unless separately cited) |

#### Cursor — PR #5 quota observation @ same HEAD `c73bf31a3d22815b26b9a33a5d28fd1f242f5701`

| Object | Durable anchor |
| --- | --- |
| Usage-limit **issue comment** | **API id `5102308579`** · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5#issuecomment-5102308579 · author `cursor[bot]` · `2026-07-28T09:23:40Z` · body starts `Bugbot couldn't run - usage limit reached` |
| HEAD-bound **check run** | **Check run id `90233500616`** · name `Cursor Bugbot` · `conclusion: neutral` · `head_sha: c73bf31a3d22815b26b9a33a5d28fd1f242f5701` · `completed_at: 2026-07-28T09:23:40Z` · app slug `cursor` · https://github.com/Akagilnc/ak-pi-workflow-roles/runs/90233500616 · observed `output.title: "Error"` (recorded as observation only; **not** a stable subtype discriminator) |

#### CodeRabbit — PR #4 multi-surface observation (non-normative demo)

| Object | Durable anchor |
| --- | --- |
| PR container | https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4 |
| Walkthrough / summary **issue comment** | **API id `5099890151`** · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#issuecomment-5099890151 · author `coderabbitai[bot]` · `2026-07-28T04:18:36Z` |
| Submitted **pull request review** | **Review id `4793700581`** · author `coderabbitai[bot]` · `state: COMMENTED` · `commit_id: c5f75b63415bf24b8a2318ef8744a60d255eb135` · `submitted_at: 2026-07-28T04:24:49Z` · HTML: https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#pullrequestreview-4793700581 |
| Inline **review comment / discussion** | **Review comment id `3662760359`** · `pull_request_review_id: 4793700581` · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#discussion_r3662760359 · `2026-07-28T04:24:48Z` |
| **Commit status** | **Status id `51192757994`** · `context: CodeRabbit` · `state: success` · `created_at: 2026-07-28T04:24:51Z` · on commit `c5f75b63415bf24b8a2318ef8744a60d255eb135` |

Optional secondary CodeRabbit PR #4 objects (if text mentions later pass): review `4797137516` @ `9ea6fa59…`; discussion `3665422516` — still observation-only.

### Scope

- **In:** wording, labels, durable anchors inside research doc under Root 2 layering
- **Out:** capturing new live fixtures as package test assets in this repair; implementing terminal profile rules; asserting current c73 reaction presence; promoting observations into ADR 0011

### Verification (Root 3)

- Grep research: no “documented” on Codex `+1`+commit-comment form; no “check output distinguishes” as established fact; quota labeled observation; c73 reaction claim absent; every retained observation carries object-level URL/ID above; profile terminal bullets only under Future sketches with fixture precondition

---

## Apply sequence (when approved; not authorized by this plan turn)

1. **Root 1 text unit:** CONTEXT Fixer/Coder; README Fixer/Coder + `:181`; Fixer Soul topology **and** mechanical-rule removal (layering audit); worker-role Fixer/Coder metadata; `test/judge-role.test.ts` exact strings; ADR 0003 Judge-consumer supersession note + caller reword
2. **Roots 2–3 doc unit:** add thin ADR 0011; restructure research doc (Accepted / Current v1 / Observations with durable anchors / Future sketches); strip unsupported terminal-authority wording
3. Full residual grep: worker Judge-topology; v1 status-blur; terminal overclaim; Fixer Soul mechanical catechism; missing object anchors; banned c73 reaction claim
4. `npm ci` if needed → **`npm test`** (full) → **`npm run typecheck`** → **`git diff --check`**
5. Exactly one new forward commit (no amend); title per task prefix contract; body lists roots fixed and any refused items

## Risk notes

- Fixer Soul must remain professionally complete after deleting topology **and** mechanical catechism — judgment principles listed above stay; hollowed Soul is a regression
- ADR 0011 must stay thin (adaptation rationale only); profile/manifest/four-state/transport designs stay unaccepted sketches in research
- ADR 0003 stays `proposed` except the superseded Judge-consumer clause — do not fake-graduate the whole ADR
- Exact-metadata test is the only mechanical couple to Root 1 tool text; missing the retarget fails CI for the right reason
- Durable anchors can later be deleted/mutated on GitHub; text must keep them labeled observation, not law

## Explicit success criteria

1. ADR 0010 true on all worker-facing textual surfaces including `README.md:181`, with repository-wide topology disposition recorded and applied
2. Fixer Soul retains only irreducible repair judgment; mechanical singleton/status/`commitSha`/escalate rules left to existing schema/runtime without new guards
3. Research layers Accepted (ADR 0011 thin rationale) / Current v1 (accurate, cited) / Observations (object-anchored, non-normative) / Future sketches (unaccepted)
4. Codex/Cursor unsupported terminal claims removed or relabeled; c73 reaction claim removed; PR #4/#5 observations use the stable IDs above
5. Full tests + typecheck + diff check green on a single forward commit
