# Plan: Reviewer protocol research documentation seams
# (final corrected, self-contained; HEAD d26033e; apply NOT authorized)

## Baseline

- **HEAD:** `d26033eb8a95a501c1d1a62da718ac3d7f49d56e` (clean worktree)
- **Authority:** ADR 0010 accepted (owner 2026-07-28): callers own composition/order/repetition/disposition; roles own only single-invocation interior; packet/task presence may be validated; Judge authorship must not be required; package must not encode orchestration/routing/next-role
- **Prior related work:** `04c2ad4` added ADR 0010 + Collector glossary only; did **not** clear Fixer/Coder/README/tool Judge-topology text. Research landed undifferentiated in `7cbbaf4`
- **Runtime truth today:** validates packet/task presence and per-invocation phase/status/`commitSha` invariants only (`src/worker-role.ts` `validateWorkerOutput` + `requireSingletonSubmissionCall`). No provenance guard, topology mechanism, or ADR/README/Soul consistency test exists or will be added
- **Exact-metadata oracle** (`test/judge-role.test.ts` Fixer/Coder metadata fixtures) is green **because it snapshots the contradictory Judge-directed tool wording** — retarget those exact strings only
- **Judge note:** Standards #1 and future-design Spec are one layering/status-blur root; Standards #2 spans Fixer Soul + tool metadata + Coder caller guidance. No new guard justified
- **Corrections incorporated:** `/tmp/reviewer-protocol-research-plan-corrections.md` and `/tmp/reviewer-protocol-research-plan-corrections-2.md`

**Absolute non-goals:** no runtime/schema/transport/receipt/profile/protocol mechanism; no provenance/topology/generalized consistency test; no fixture-capture campaign; no relaxing assertions beyond retargeting exact strings that encode deleted false topology; no amend/history rewrite; no baseline-smell carry-forward

---

## Root 1 — ADR 0010 caller-ownership false across textual surfaces

### Behavior

Every package textual surface that currently encodes **worker provenance** (packet must be Judge-authored) or **next-role / Flow routing** (report returns to Judge; orchestrator is mandatory traffic) must instead describe:

1. **Caller-supplied inputs** (repair packet / task present and sufficient — authorship irrelevant)
2. **Caller-owned disposition** (who reads the receipt, whether Judge is involved, optional orchestrator)
3. **Role interior only** (phase discipline, evidence quality, refuse-vs-fake-success, forward-history discipline)

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
| `README.md:110` Coder report | self-check results “for **the Judge**” | “for the **caller**” (report/audit requirements unchanged as README/caller guidance) |
| `README.md:181` package close | “Workflow ordering and routing belong to a **separate orchestrator**.” | **Caller ownership / optional-orchestrator** wording, e.g. “Workflow ordering and routing are **caller-owned**. A separate orchestrator is optional infrastructure, not a package requirement.” |
| `souls/fixer.md` entire topology + mechanical catechism | Judge issuer; Judge next-hop; Flow/reviewer/converged routing; singleton tool call; status/`commitSha` matrix; escalate impossibility; field/tool handoff | See **Fixer Soul layering audit** — judgment-only rewrite of the contaminated sections |
| `src/worker-role.ts:169` Fixer `description` | “commitSha is advisory evidence **for the judge**.” | “commitSha is advisory evidence.” (or “… for the caller.”) |
| `src/worker-role.ts:173` Fixer `promptGuidelines` | “for **the judge to adjudicate**” | “for **the caller to dispose**.” |
| `src/worker-role.ts:274,278` Coder same pair | identical Judge consumer wording | Same caller-disposal rewrite |
| `test/judge-role.test.ts` (exact metadata fixtures for the four tool strings) | snapshots of the Judge-directed wording | Retarget to the new exact strings only |
| `docs/adr/0003-per-role-submission-tools.md` (status **`proposed`**, not safely “historical”) Judge-consumer clause | “Git commit 是供**判官**核查的客观证据…” | **Action:** mark that single Judge-consumer clause **superseded by accepted ADR 0010**, and reword the surviving sentence to caller-owned advisory evidence (e.g. “Git commit 是供**调用方**核查的客观证据…”). Leave the rest of 0003 (named per-role tools, fixer two-phase envelope, package owns contract shape) intact under its existing `proposed` status. Do **not** silently treat whole 0003 as nonnormative without this supersession note |

#### KEEP — legitimate Judge-role or correct anti-routing text (out of edit scope)

| Anchor | Why keep |
| --- | --- |
| `CONTEXT.md:9` Judge definition; `:16` Soul-compliance audit about Judge | Defines the Judge role / Judge audit when that role is used |
| `CONTEXT.md:18-19` 角色调用 + 编排器 glossary | Already states caller owns composition; Orchestrator is defined as **out-of-package optional traffic**, not a worker duty |
| `CONTEXT.md:20` 三态判词 | Judge verdict vocabulary when Judge is used |
| `README.md` Judge section, Verdict contract | Describes Judge when invoked; `note` already “no built-in routing” |
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
| **`0009-minimal-engineering-face-git-distribution.md`** | **`proposed`** | **Explicit classification required by correction #2.** Distribution/backup/CI face (`pi install git:`, no npm yet). Contains future **`phase-2 编排器`** integration text: when a phase-2 orchestrator integrates, pin package version by git ref and nail submission contracts with bilateral tracer tests. This is **future integration / version-coupling direction**, **not** worker provenance or next-role routing law. **KEEP as written; include in residual audit only to confirm it is not rewritten into worker-facing topology and is not mistaken for a residual EDIT hit.** |

**Boundary rule for apply grep:** after edits, worker-facing surfaces (Fixer/Coder Soul, CONTEXT Fixer/Coder lines, README Fixer/Coder sections, README:181, worker tool metadata) must not require Judge authorship or name Judge/Flow as mandatory next hop. Judge sections and the classified ADRs above may still say “判官/Judge/orchestrator/Flow” in their proper domains.

### Fixer Soul layering audit (`souls/fixer.md`) — judgment-only

CLAUDE.md / project Soul discipline: Soul = irreducible professional judgment only. Schema owns field shapes; TypeScript runtime owns mechanical invariants; tool metadata / README own transport and caller handoff.

**Hard rule for the proposed Soul (correction #2):** no status names, no field names, no tool/API instructions, no caller-disposition / handoff transport lines. An evidence-sufficiency principle may remain without naming receipt fields.

#### Remove from Soul (mechanically or transport-owned — do **not** replace with new runtime guards or tests)

| Soul material today | True owner already in tree | Disposition |
| --- | --- | --- |
| “最终只调用一次 `ak_fixer_output`” (singleton invocation) | `requireSingletonSubmissionCall` in `src/worker-role.ts` | **Delete** from Soul |
| Exact phase→status mappings (`planned` / `completed` / `refused`) and `commitSha` combination law | `workerOutputSchema` + `validateWorkerOutput` | **Delete** status names and field combination law from Soul |
| “report 始终写完整 Markdown” as field catechism | tool schema (`report` required non-empty) + README | **Delete** field-name catechism; keep professional **evidence-sufficiency** principle without naming the field |
| “创建了 commit 就自报 commitSha…不是机械真相” | schema optional `commitSha` + tool description (“advisory evidence”) + runtime non-gate | **Delete** field-name / self-report mechanics from Soul; keep “Git forward commit is repair evidence, not the complete role output” as judgment about evidence quality |
| “你不输出 escalate” as Soul law | Schema enum is only the worker statuses; escalate is impossible at the tool boundary. Tool guideline may keep a one-line “never escalates” transport hint **outside Soul** | **Delete** from Soul |
| Closing topology paragraph: no direct reviewer, no `converged`, Flow transports back to Judge | ADR 0010 + caller ownership | **Delete** entire Flow/reviewer/converged/判官复判 closing |
| “交判官复判 / 由判官决定是否叫人” | Caller disposition (README / caller guidance) | **Delete**; do **not** replace with a Soul-level “由调用方处置 / submit through role output tool” handoff line — that is still transport/caller semantics |
| Tool/API handoff lines (“通过 `ak_fixer_output` 返回…”, “最终只调用一次…”, green-shape “submit through the role output tool…”) | tool metadata + runtime | **Delete** from Soul entirely |

#### Retain in Soul (irreducible repair judgment only)

- Role identity: repair worker for a supplied repair packet under an explicit plan-or-apply duty; do not cross phase duties; do not fabricate completion declarations
- **plan judgment:** investigate real code and history; produce a minimal verifiable repair plan; no code/test/doc/git mutation and no commit during plan
- **apply judgment:** execute the approved repair; self-verify; create only a new forward commit when repaired; never amend or rewrite existing history
- **Refusal judgment:** if the packet conflicts with authority, facts no longer hold, or safe completion is impossible — do not manufacture an empty commit; refuse with evidence rather than fake success
- **Startup investigation:** read the full packet, issue/authority pointers, and relevant code; consult `git log` for same-shape failed fixes and do not resubmit that method family; packet supplies pain points and constraints, not necessarily the final cut
- **Diagnosis discipline:** when divergent / root-unclear / repeated-seam / flake — minimize with evidence-driven diagnosis; do not pile speculative guards
- **Test/AC red line:** no weakening assertions, deleting failed paths, or rewriting acceptance criteria to force green unless packet authority explicitly allows
- **Delete-over-add; fix class not point;** do not expand past packet/authority
- **Apply self-check professional sequence:** blast-radius check; run repository-declared typecheck/tests/acceptance (no weaker substitute); authorized worktree only; one new forward commit with required title prefix and explanatory body; confirm new HEAD is a strict forward descendant of start HEAD
- **Evidence-sufficiency principle:** the role’s written account must make fix/refuse/evidence/verification independently auditable — **without naming receipt fields**
- **Evidence quality about Git:** a new forward commit is repair evidence, not the complete role output — **without naming `commitSha` or instructing self-report mechanics**

**Green Soul shape (intent, not frozen prose):** short role identity + phase boundary judgment + startup/investigation judgment + repair principles + refusal criteria + apply self-check + evidence-sufficiency/evidence-quality principles.  
**Forbidden in proposed Soul:** status enums/names; field names (`report`, `commitSha`, `status`); tool names/API call instructions; caller-disposition or handoff/transport lines; Judge/Flow/reviewer/converged topology.

README, tool metadata, and runtime continue to carry phase success vocabulary, field shapes, singleton submission, and caller disposition — that is correct layering, not Soul content.

### Owner (Root 1)

| Surface | Path |
| --- | --- |
| Glossary | `CONTEXT.md` Fixer + Coder lines |
| Caller docs | `README.md` Fixer + Coder sections **and** `:181` closing routing sentence |
| Bundled Soul | `souls/fixer.md` (topology **and** mechanical/transport removal → judgment-only) |
| Tool metadata | `src/worker-role.ts` Fixer + Coder `description` + `promptGuidelines` |
| ADR supersession | `docs/adr/0003-per-role-submission-tools.md` Judge-consumer clause only |
| Exact oracle | `test/judge-role.test.ts` metadata fixtures at the four string sites |

### Red

All EDIT rows above are present on `d26033e`. Residual package-level contradiction at `README.md:181` is in scope. ADR 0003 remains `proposed` with a live Judge-consumer sentence that still contradicts ADR 0010. ADR 0009’s phase-2 orchestrator sentence is classified KEEP (integration/version-coupling), not an EDIT miss. Fixer Soul still mixes topology with schema/runtime/tool catechism.

### Green

- Worker text: caller-supplied inputs + caller-owned disposition; no mandatory Judge next-hop; no mandatory orchestrator
- Fixer Soul: **judgment-only**; no status/field/tool/caller-handoff semantics; mechanical invariants left to existing runtime/schema; transport/caller guidance left to README/tool metadata
- ADR 0003 Judge-consumer clause explicitly superseded by ADR 0010 and reworded to caller
- ADR 0009 explicitly classified KEEP (future integration/version-coupling; not worker provenance)
- Exact metadata tests match new tool strings
- Judge-role surfaces and classified Flow/orchestrator ADRs unchanged in meaning

### Scope

- **In:** text on owners above; exact-string test retargets; 0003 one-clause supersession note + caller reword
- **Out:** runtime validation changes; new guards/tests; schema/phase changes; Judge Soul; bulk ADR status graduation; inventing orchestrator features; rewriting 0009

### Verification (Root 1)

- `rg` worker-facing paths for mandatory Judge-next / Flow-routing / judge-authored packet (Fixer/Coder Soul, CONTEXT Fixer/Coder, README Fixer/Coder, README:181, `src/worker-role.ts` metadata) → zero hits
- Confirm Judge section, Reviewer/Collector anti-routing lines, and classified ADRs (including **0009**) still coherent and not mistaken for residual EDIT hits
- Confirm `souls/fixer.md` contains **none** of: status names (`planned`/`completed`/`refused`/`escalate`/`converged`), field names (`report`/`commitSha`/`status`), tool names (`ak_fixer_output`), caller-handoff/disposition transport, Judge/Flow topology
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
4. Shared evidence list includes **reactions / check runs / commit statuses** — v1 transport observes only **user, pull request, pull-request reviews, issue comments, review comments**
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
Provider notes + durable **positive** object URLs/IDs from Root 3.
Explicitly dated; not contracts; no profile terminal rule may derive from them.
No unanchored negative absence claims.

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
- **Out:** runtime/schema/profile implementation; transport expansion; receipt state changes; new generalized tests; fixture capture

### Verification (Root 2)

- Research never asserts v1 has `protocol`, reactions/checks/statuses transport, or submitted `pending`/`completed`
- ADR 0011 contains rationale only (no profile JSON / four-state / transport design)
- `npm test` + `npm run typecheck` remain green without code-path changes

---

## Root 3 — Unsupported Codex/Cursor terminal-authority claims

### Behavior

Repository observations and overloaded fields must not be labeled **documented** or authorized as **terminal profile rules** without first-party support **and** a captured fixture. Keep useful **positive** observations as **dated, non-normative** evidence pinned by **stable object URLs/API IDs** (not merely PR container URLs + a commit SHA). No profile terminal rule may derive from them in this repair.

**Negative absences without captured fixtures are out of scope:** do **not** state “no PullRequestReview”, “no Codex check run”, or “no c73 reaction” as retained factual observations. Live mutable API listings are not durable evidence; fixture capture is not authorized by this packet. Remove those negative claims rather than keep them unanchored. Do **not** substitute later reaction `428138437` (different run).

### Owner

`docs/research/external-reviewer-protocols.md` provider sections (Codex, Cursor, CodeRabbit observation anchors), under the Observations / Future sketches split from Root 2. First-party claims that already checked out remain.

### Red

1. Codex table/prose treat PR-level `+1` + commit-naming issue comment as **documented / native no-findings form** and authorize profile acceptance — that form is **repo observation**, not the cited OpenAI contract
2. Cursor unavailable / profile text claims check output **distinguishes** findings / cancellation / internal error / quota — cited Cursor docs define overloaded `neutral` but **no stable check-output discriminator** is established
3. Quota path sits beside classification rules without an observation-only label
4. PR #4/#5 anchors that are only container URL + commit SHA are insufficient for mutable objects
5. Unanchored negative claims (no review / no check / absent c73 reaction) appear without captured fixtures

### Green — claim treatment

| Claim | Treatment |
| --- | --- |
| OpenAI `@codex review` + standard GitHub review pages | Keep as **documented** trigger/findings surface; cite existing OpenAI URLs |
| Hosted connector ≠ `openai/codex-action` | Keep |
| Codex positive observation on roles PR #5 @ `c73bf31…`: issue comment naming reviewed short SHA | **Observation only** with durable comment anchor below. **Not** documented terminal form; **not** profile-authorized. Note comment mutability. |
| Codex PR-level `+1` reaction for the c73 run | **Do not claim** (no durable captured reaction id/fixture for a c73-era reaction; do not use `428138437`) |
| Negative “no PullRequestReview / no Codex check run for c73” | **Remove entirely** (unanchored negative; fixture capture out of scope) |
| “Accept documented no-findings native form” profile bullet | Future sketch only; conditional on first-party support **and** captured API fixtures |
| Cursor documented `success` / `neutral` / `failure` meanings | Keep as **documented** |
| Enterprise analytics `commit_sha` / `bugs_found` | Keep as documented API fields; **not** a GitHub-check discriminator |
| Reliable discrimination of neutral subtypes via check output | **Remove / negate** until first-party support + fixtures exist |
| Quota neutral check + usage-limit issue comment | **Observation only** with durable **positive** anchors below |
| CodeRabbit documented triggers / progress / rate-limit | Keep as documented |
| CodeRabbit PR #4 multi-surface demo | **Observation only** with durable positive anchors; still non-normative |
| GitHub object semantics (reviews/comments/reactions/checks/statuses as platform facts) | Keep in explanatory “why one universal review-object rule fails” material; do **not** imply v1 transport implements reactions/checks/statuses |

### Green — durable **positive** object anchors for every retained observation

All remain **explicitly dated, non-normative**. IDs verified against live GitHub API at plan time on `Akagilnc/ak-pi-workflow-roles`. Only positive existing objects are retained.

#### Codex — PR #5 positive observation @ `c73bf31a3d22815b26b9a33a5d28fd1f242f5701`

| Object | Durable anchor |
| --- | --- |
| PR container (context only) | https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5 |
| Target commit | `c73bf31a3d22815b26b9a33a5d28fd1f242f5701` |
| No-findings **issue comment** (positive) | **API id `5102352848`** · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5#issuecomment-5102352848 · author `chatgpt-codex-connector[bot]` · `2026-07-28T09:27:54Z` · body includes `Didn't find any major issues` and `Reviewed commit: c73bf31a3d` |

**Explicitly not retained as facts in the repaired doc:**
- any c73-era PR-level `+1` reaction
- reaction id `428138437` (later run @ `f01c9bf` / comment `#issuecomment-5104638115`)
- unanchored negatives “no PullRequestReview” / “no Codex check run” for the c73 observation

#### Cursor — PR #5 quota observation @ same HEAD `c73bf31a3d22815b26b9a33a5d28fd1f242f5701`

| Object | Durable anchor |
| --- | --- |
| Usage-limit **issue comment** | **API id `5102308579`** · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5#issuecomment-5102308579 · author `cursor[bot]` · `2026-07-28T09:23:40Z` · body starts `Bugbot couldn't run - usage limit reached` |
| HEAD-bound **check run** | **Check run id `90233500616`** · name `Cursor Bugbot` · `conclusion: neutral` · `head_sha: c73bf31a3d22815b26b9a33a5d28fd1f242f5701` · app slug `cursor` · https://github.com/Akagilnc/ak-pi-workflow-roles/runs/90233500616 · observed `output.title` may be recorded as observation only; **not** a stable subtype discriminator |

#### CodeRabbit — PR #4 multi-surface observation (non-normative demo)

| Object | Durable anchor |
| --- | --- |
| PR container | https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4 |
| Walkthrough / summary **issue comment** | **API id `5099890151`** · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#issuecomment-5099890151 · author `coderabbitai[bot]` · `2026-07-28T04:18:36Z` |
| Submitted **pull request review** | **Review id `4793700581`** · author `coderabbitai[bot]` · `state: COMMENTED` · `commit_id: c5f75b63415bf24b8a2318ef8744a60d255eb135` · `submitted_at: 2026-07-28T04:24:49Z` · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#pullrequestreview-4793700581 |
| Inline **review comment / discussion** | **Review comment id `3662760359`** · `pull_request_review_id: 4793700581` · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#discussion_r3662760359 · `2026-07-28T04:24:48Z` · path `src/worker-role.ts` |
| **Commit status** | **Status id `51192757994`** · `context: CodeRabbit` · `state: success` · `created_at: 2026-07-28T04:24:51Z` · on commit `c5f75b63415bf24b8a2318ef8744a60d255eb135` |

Optional secondary CodeRabbit PR #4 objects (only if text mentions a later pass; still observation-only): review `4797137516` @ `9ea6fa59…`; discussion `3665422516`; status `51213941087` / `51214696930`.

### Scope

- **In:** wording, labels, durable **positive** anchors inside research doc under Root 2 layering; deletion of unanchored negatives and unsupported terminal-authority wording
- **Out:** capturing new live fixtures as package test assets; implementing terminal profile rules; asserting current/historical c73 reaction presence; promoting observations into ADR 0011; keeping unanchored absence claims

### Verification (Root 3)

- Grep research: no “documented” on Codex `+1`+commit-comment form; no “check output distinguishes” as established fact; quota labeled observation
- c73 reaction claim absent; reaction `428138437` not used as c73 evidence
- unanchored negatives (“no PullRequestReview”, “no Codex check run”) absent
- every retained observation carries a positive object-level URL/ID above
- profile terminal bullets only under Future sketches with fixture precondition

---

## Apply sequence (when approved; **not** authorized by this plan turn)

1. **Root 1 text unit:** CONTEXT Fixer/Coder; README Fixer/Coder + `:181`; Fixer Soul judgment-only rewrite (no status/field/tool/handoff); worker-role Fixer/Coder metadata; `test/judge-role.test.ts` exact strings; ADR 0003 Judge-consumer supersession note + caller reword
2. **Roots 2–3 doc unit:** add thin ADR 0011; restructure research doc (Accepted / Current v1 / Observations with positive durable anchors / Future sketches); strip unsupported terminal-authority wording and unanchored negatives
3. Full residual grep checklist:
   - worker Judge-topology / judge-authored packet
   - README:181 mandatory-orchestrator wording
   - ADR 0009 still present and classified KEEP (not accidentally edited into worker law; not left off the inventory)
   - Fixer Soul free of status/field/tool/caller-handoff semantics
   - v1 status-blur (`protocol`, reactions/checks/statuses as v1, submitted pending/completed)
   - terminal overclaim (Codex documented +1 form; Cursor check-output discriminator)
   - unanchored negatives / banned c73 reaction claim
   - missing positive object anchors on retained observations
4. `npm ci` if needed → **`npm test`** (full) → **`npm run typecheck`** → **`git diff --check`**
5. Exactly one new forward commit (no amend); title per task prefix contract; body lists roots fixed and any refused items

## Risk notes

- Fixer Soul must remain professionally complete after deleting topology **and** mechanical/transport catechism — judgment principles listed above stay; hollowed Soul is a regression; reintroducing status/field/tool/handoff lines to “help the model” is a layering regression
- ADR 0011 must stay thin (adaptation rationale only); profile/manifest/four-state/transport designs stay unaccepted sketches in research
- ADR 0003 stays `proposed` except the superseded Judge-consumer clause — do not fake-graduate the whole ADR
- ADR 0009 stays untouched KEEP; its phase-2 orchestrator sentence is version-coupling context, not a residual topology defect requiring edit
- Exact-metadata test is the only mechanical couple to Root 1 tool text; missing the retarget fails CI for the right reason
- Durable positive anchors can later be deleted/mutated on GitHub; text must keep them labeled observation, not law
- Removing unanchored negatives means the Codex observation becomes “positive comment evidence exists,” not “structured surfaces were absent”

## Explicit success criteria

1. ADR 0010 true on all worker-facing textual surfaces including `README.md:181`, with repository-wide topology disposition recorded and applied, **including explicit ADR 0009 KEEP classification**
2. Fixer Soul retains only irreducible repair judgment; **no** status names, field names, tool/API instructions, or caller-handoff/disposition transport; mechanical rules left to existing schema/runtime without new guards
3. Research layers Accepted (ADR 0011 thin rationale) / Current v1 (accurate, cited; no protocol/expanded transport/submitted pending) / Observations (positive object-anchored, non-normative) / Future sketches (unaccepted)
4. Codex/Cursor unsupported terminal claims removed or relabeled; **all unanchored negative Codex/reaction claims removed**; PR #4/#5 retained observations use the stable positive IDs above
5. Full tests + typecheck + diff check green on a single forward commit; **no runtime/schema/transport/receipt changes**
