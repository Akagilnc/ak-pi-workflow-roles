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
- **Plan file:** `/tmp/reviewer-protocol-research-fixer-plan.md` (same content)

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
| `docs/adr/0003-per-role-submission-tools.md` (status **`proposed`**, not safely “historical”) Judge-consumer clause | “Git commit 是供**判官**核查的客观证据…” | **Action:** mark that single Judge-consumer clause **superseded by accepted ADR 0010**, and reword the surviving sentence to caller-owned advisory evidence (e.g. “Git commit 是供**调用方**核查的客观证据…”). Leave the rest of 0003 intact under its existing `proposed` status. Do **not** silently treat whole 0003 as nonnormative without this supersession note |

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
| **`0009-minimal-engineering-face-git-distribution.md`** | **`proposed`** | **Explicit classification (correction #2).** Distribution/backup/CI face (`pi install git:`, no npm yet). Contains future **`phase-2 编排器`** integration text: when a phase-2 orchestrator integrates, pin package version by git ref and nail submission contracts with bilateral tracer tests. This is **future integration / version-coupling direction**, **not** worker provenance or next-role routing law. **KEEP as written; include in residual audit only to confirm it is not rewritten into worker-facing topology and is not mistaken for a residual EDIT hit.** |

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
| “创建了 commit 就自报 commitSha…不是机械真相” | schema optional `commitSha` + tool description + runtime non-gate | **Delete** field-name / self-report mechanics from Soul; keep “Git forward commit is repair evidence, not the complete role output” as judgment about evidence quality |
| “你不输出 escalate” as Soul law | Schema enum forbids escalate at the tool boundary; tool guideline may keep a one-line hint **outside Soul** | **Delete** from Soul |
| Closing topology paragraph: no direct reviewer, no `converged`, Flow transports back to Judge | ADR 0010 + caller ownership | **Delete** entire Flow/reviewer/converged/判官复判 closing |
| “交判官复判 / 由判官决定是否叫人” | Caller disposition (README / caller guidance) | **Delete**; do **not** replace with a Soul-level “由调用方处置 / submit through role output tool” handoff line — that is still transport/caller semantics |
| Tool/API handoff lines (“通过 `ak_fixer_output` 返回…”, “最终只调用一次…”, any “submit through the role output tool…” green-shape line) | tool metadata + runtime | **Delete** from Soul entirely |

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

### Owner / Red / Green / Scope / Verification (Root 1)

- **Owner:** `CONTEXT.md` Fixer+Coder; `README.md` Fixer+Coder + `:181`; `souls/fixer.md`; `src/worker-role.ts` Fixer+Coder metadata; `docs/adr/0003-…` Judge-consumer clause only; `test/judge-role.test.ts` four exact strings
- **Red:** all EDIT rows present on `d26033e`; README:181 residual; 0003 live Judge-consumer clause; Fixer Soul mixes topology with schema/runtime/tool catechism; 0009 previously missing from inventory (now classified KEEP)
- **Green:** caller-supplied inputs + caller-owned disposition on worker surfaces; judgment-only Fixer Soul; 0003 supersession note; 0009 explicit KEEP; exact metadata retargeted; Judge-domain text unchanged
- **Scope in:** text + exact-string retargets + 0003 one-clause supersession
- **Scope out:** runtime/schema/new guards/tests; Judge Soul; bulk ADR graduation; rewriting 0009
- **Verification:** worker-facing `rg` clean of mandatory Judge-next / Flow-routing / judge-authored packet; Fixer Soul free of status/field/tool/caller-handoff semantics; 0009 still present and classified KEEP; `npm test` + `typecheck` + `git diff --check`

---

## Root 2 — Research doc blurs accepted policy / current v1 / observations / future sketches

### Behavior

Thin owner-approved **protocol-adaptation rationale** moves to ADR layer. Research cites it, then separates **Current v1 (implemented)** from **non-normative observations** and **unaccepted future sketches**.

### Owner

| Layer | Path |
| --- | --- |
| Accepted policy (thin) | **New** `docs/adr/0011-collector-adapts-to-documented-reviewer-protocols.md` (or next free number), **status: accepted**, owner date 2026-07-28 |
| Research restructure | `docs/research/external-reviewer-protocols.md` |
| Current v1 truth sources (**cite only**) | `schemas/collector-legs-v1.schema.json`; `src/collector-github.ts` + ledger transport; receipt/tool-schema/role status rules |

### Red

1. “Decision summary” reads as package-normative decision + provider terminal matrix
2. Design JSON with `"protocol": "codex-hosted-github-v1"` reads as usable manifest — **v1 has no `protocol`**
3. Four-state operation model contradicts submitted **`valid | unavailable | missing`**
4. Shared evidence list includes reactions/checks/statuses — v1 transport is user/PR/reviews/issue comments/review comments only
5. No durable separation of accepted / v1 / observation / future

### Green — thin ADR 0011 (rationale only)

- **Decision:** Collector should adapt to each reviewer’s **documented** completion forms rather than require every leg to emit a GitHub `PullRequestReview`
- **Consequences:** no profiles / manifest `protocol` / expanded transport / expanded submitted statuses ship with this acceptance; v1 may remain review-shaped; undocumented observations are not terminal without first-party support **and** captured fixtures
- **Non-goals inside ADR:** no JSON examples, profile names, four-state model, or reactions/checks/statuses design

### Green — research target shape

```
# External GitHub reviewer protocols
## How to read this document
  Accepted policy → ADR 0011 | Current v1 | Observations (non-normative) | Future sketches (unaccepted)

## Accepted policy
  Cite ADR 0011 only. No design.

## Current v1 (implemented)
  - collector-legs-v1: version + legs[{id, expectedAuthors, request?}] only; NO protocol
  - transport: user, PR, reviews, issue comments, review comments only
    (NO reactions/checks/statuses)
  - valid = qualifying submitted review with exact-HEAD commit_id (+ existing cite rules)
  - submitted statuses: valid | unavailable | missing only
  - pending = internal/semantic only; never submitted; no Collector refused/completed

## Observations (non-normative)
  Positive durable object anchors from Root 3 only.
  No unanchored negative absence claims.

## Future sketches (unaccepted / unimplemented)
  Banner: not usable contracts; need first-party docs + fixtures first.
  - protocol profiles + manifest protocol field JSON
  - extended transport (reactions/checks/statuses)
  - four-state model + binding-kind split
  - former “profile should therefore” bullets
```

### Scope / Verification (Root 2)

- **In:** new thin ADR + research restructure/citations
- **Out:** runtime/schema/profile/transport/receipt changes; fixture capture; new generalized tests
- **Verify:** research never asserts v1 has `protocol`, reactions/checks/statuses transport, or submitted `pending`/`completed`; ADR 0011 rationale-only; full tests + typecheck still green

---

## Root 3 — Unsupported Codex/Cursor terminal-authority claims

### Behavior

Do not elevate repository observations or overloaded fields into documented/terminal authority without first-party support **and** captured fixtures. Keep useful **positive** observations as dated, non-normative evidence pinned by **stable object URLs/API IDs**.

**Negative absences without captured fixtures are out of scope (correction #2):** do **not** state “no PullRequestReview”, “no Codex check run”, or “no c73 reaction” as retained factual observations. Live mutable API listings are not durable evidence; fixture capture is not authorized. Remove those negative claims. Do **not** substitute later reaction `428138437` (different run).

### Red

1. Codex `+1` + commit-naming comment treated as documented/native no-findings form / profile-authorized
2. Cursor text claims check output distinguishes findings/cancellation/internal-error/quota — docs define overloaded `neutral` only
3. Quota path unlabeled as observation
4. PR #4/#5 anchors that are only container URL + commit SHA
5. Unanchored negatives (no review / no check / absent c73 reaction)

### Green — claim treatment

| Claim | Treatment |
| --- | --- |
| OpenAI `@codex review` + standard GitHub review pages | Keep as **documented** trigger/findings surface |
| Hosted connector ≠ `openai/codex-action` | Keep |
| Codex positive observation: PR #5 issue comment @ `c73bf31…` naming reviewed short SHA | **Observation only** with durable comment anchor. Not documented terminal; not profile-authorized. Note mutability. |
| Codex PR-level `+1` for c73 run | **Do not claim** (no durable captured reaction id/fixture; do not use `428138437`) |
| Negative “no PullRequestReview / no Codex check run for c73” | **Remove entirely** |
| “Accept documented no-findings native form” profile bullet | Future sketch only; needs first-party support **and** fixtures |
| Cursor documented `success` / `neutral` / `failure` | Keep as documented |
| Enterprise analytics fields | Keep as documented API fields; not GitHub-check discriminator |
| Reliable neutral-subtype discrimination via check output | **Remove / negate** until supported |
| Quota neutral check + usage-limit comment | **Observation only** with positive anchors |
| CodeRabbit documented triggers/progress/rate-limit | Keep |
| CodeRabbit PR #4 multi-surface demo | **Observation only** with positive anchors |
| GitHub object semantics | Keep as platform explanation; do not imply v1 transport implements reactions/checks/statuses |

### Green — durable **positive** object anchors (verified live at plan time)

#### Codex — PR #5 @ `c73bf31a3d22815b26b9a33a5d28fd1f242f5701`

| Object | Durable anchor |
| --- | --- |
| PR container | https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5 |
| Target commit | `c73bf31a3d22815b26b9a33a5d28fd1f242f5701` |
| Issue comment (positive) | **API id `5102352848`** · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5#issuecomment-5102352848 · `chatgpt-codex-connector[bot]` · `2026-07-28T09:27:54Z` · `Didn't find any major issues` + `Reviewed commit: c73bf31a3d` |

**Not retained:** c73-era `+1` reaction; reaction `428138437`; unanchored negatives “no PullRequestReview” / “no Codex check run”.

#### Cursor — PR #5 quota @ same HEAD

| Object | Durable anchor |
| --- | --- |
| Usage-limit issue comment | **API id `5102308579`** · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5#issuecomment-5102308579 · `cursor[bot]` · `2026-07-28T09:23:40Z` |
| Check run | **id `90233500616`** · `Cursor Bugbot` · `conclusion: neutral` · `head_sha: c73bf31…` · https://github.com/Akagilnc/ak-pi-workflow-roles/runs/90233500616 · observed output title is observation only, **not** a stable discriminator |

#### CodeRabbit — PR #4 multi-surface (non-normative)

| Object | Durable anchor |
| --- | --- |
| PR container | https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4 |
| Walkthrough issue comment | **API id `5099890151`** · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#issuecomment-5099890151 · `coderabbitai[bot]` · `2026-07-28T04:18:36Z` |
| Pull request review | **Review id `4793700581`** · `COMMENTED` · `commit_id: c5f75b63415bf24b8a2318ef8744a60d255eb135` · `2026-07-28T04:24:49Z` · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#pullrequestreview-4793700581 |
| Inline review comment | **id `3662760359`** · `pull_request_review_id: 4793700581` · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#discussion_r3662760359 · `2026-07-28T04:24:48Z` |
| Commit status | **id `51192757994`** · `context: CodeRabbit` · `state: success` · `2026-07-28T04:24:51Z` · on `c5f75b63415bf24b8a2318ef8744a60d255eb135` |

Optional secondary (only if text mentions later pass): review `4797137516`; discussion `3665422516`; statuses `51213941087` / `51214696930`.

### Scope / Verification (Root 3)

- **In:** wording/labels/positive anchors; deletion of unanchored negatives and unsupported terminal-authority wording
- **Out:** fixture capture; terminal profile implementation; asserting c73 reaction; promoting observations into ADR 0011
- **Verify:** no “documented” on Codex +1+comment form; no “check output distinguishes” as fact; quota labeled observation; c73 reaction absent; `428138437` unused as c73 evidence; unanchored negatives absent; every retained observation has a positive object ID; profile bullets only under Future sketches with fixture precondition

---

## Apply sequence (when approved; **not** authorized by this plan turn)

1. **Root 1 text unit:** CONTEXT Fixer/Coder; README Fixer/Coder + `:181`; Fixer Soul judgment-only rewrite (no status/field/tool/handoff); worker-role Fixer/Coder metadata; `test/judge-role.test.ts` exact strings; ADR 0003 Judge-consumer supersession note + caller reword
2. **Roots 2–3 doc unit:** add thin ADR 0011; restructure research doc; strip unsupported terminal-authority wording and unanchored negatives; attach positive durable anchors
3. Full residual grep checklist:
   - worker Judge-topology / judge-authored packet
   - README:181 mandatory-orchestrator wording
   - **ADR 0009 still present and classified KEEP** (not accidentally edited; not left off inventory)
   - Fixer Soul free of status/field/tool/caller-handoff semantics
   - v1 status-blur (`protocol`, reactions/checks/statuses as v1, submitted pending/completed)
   - terminal overclaim (Codex documented +1 form; Cursor check-output discriminator)
   - unanchored negatives / banned c73 reaction claim
   - missing positive object anchors on retained observations
4. `npm ci` if needed → **`npm test`** (full) → **`npm run typecheck`** → **`git diff --check`**
5. Exactly one new forward commit (no amend); title per task prefix contract; body lists roots fixed

## Risk notes

- Fixer Soul must remain professionally complete after deleting topology **and** mechanical/transport catechism; reintroducing status/field/tool/handoff lines is a layering regression
- ADR 0011 must stay thin; profile designs stay unaccepted sketches
- ADR 0003 stays `proposed` except the superseded Judge-consumer clause
- ADR 0009 stays untouched KEEP (version-coupling context, not residual topology defect)
- Exact-metadata test is the only mechanical couple to Root 1 tool text
- Removing unanchored negatives means the Codex observation becomes “positive comment evidence exists,” not “structured surfaces were absent”
- Durable positive anchors can later mutate on GitHub; keep them labeled observation, not law

## Explicit success criteria

1. ADR 0010 true on all worker-facing textual surfaces including `README.md:181`, with repository-wide topology disposition recorded and applied, **including explicit ADR 0009 KEEP classification**
2. Fixer Soul retains only irreducible repair judgment; **no** status names, field names, tool/API instructions, or caller-handoff/disposition transport; mechanical rules left to existing schema/runtime without new guards
3. Research layers Accepted (ADR 0011 thin rationale) / Current v1 (accurate, cited; no protocol/expanded transport/submitted pending) / Observations (positive object-anchored, non-normative) / Future sketches (unaccepted)
4. Codex/Cursor unsupported terminal claims removed or relabeled; **all unanchored negative Codex/reaction claims removed**; PR #4/#5 retained observations use the stable positive IDs above
5. Full tests + typecheck + diff check green on a single forward commit; **no runtime/schema/transport/receipt changes**

## Corrections explicitly closed

| Correction requirement | Plan disposition |
| --- | --- |
| README:181 in Root 1 Owner/Red/Green/Scope | EDIT row + caller/optional-orchestrator green wording |
| Repository-wide topology disposition | Full EDIT/KEEP tables including all Flow/orchestrator ADRs |
| ADR 0003 not “historical” | Supersession note + caller reword; remains `proposed` otherwise |
| Fixer Soul layering audit | Remove mechanical/transport material; judgment-only retain list |
| No new runtime guards/tests | Absolute non-goal |
| Object-level durable anchors | Positive IDs for Codex comment, Cursor comment+check, CodeRabbit comment/review/discussion/status |
| Remove unanchored c73 reaction claim | Removed; `428138437` banned as substitute |
| Explicitly classify ADR 0009 | KEEP — future integration/version-coupling; not worker provenance |
| Fixer Soul no status/field/tool/caller-handoff | Hard rule + forbidden list; no green-shape handoff line |
| Remove unanchored negative Codex claims | “no PullRequestReview” / “no Codex check run” removed entirely |
| Retain current-v1/future separation | Root 2 shape preserved |
| No runtime changes | Absolute non-goal across all roots |
