# External GitHub reviewer protocols

Research snapshot: 2026-07-28

## How to read this document

| Layer | Authority |
| --- | --- |
| **Accepted policy** | Thin rationale only — cite [ADR 0011](../adr/0011-collector-adapts-to-documented-reviewer-protocols.md) |
| **Current v1 (implemented)** | Package truth today — cite schema, transport, and receipt rules |
| **Observations (non-normative)** | Dated positive object anchors; mutable; not terminal law |
| **Future sketches (unaccepted)** | Design ideas only; not usable contracts |

Do not promote observations or sketches into package behavior without a separate accepted decision, first-party documentation support, and captured fixtures.

## Accepted policy

See [ADR 0011](../adr/0011-collector-adapts-to-documented-reviewer-protocols.md): Collector should adapt to each reviewer’s documented completion forms rather than require every leg to emit a GitHub `PullRequestReview`.

This research note does not add design. Profiles, extended transport, and multi-state operation models remain unaccepted.

## Current v1 (implemented)

Truth sources (cite only; do not restate as redesign):

- [`schemas/collector-legs-v1.schema.json`](../../schemas/collector-legs-v1.schema.json)
- Collector GitHub transport and ledger code under `src/collector-github.ts` (and related ledger helpers)
- Receipt / tool-schema / role status rules under `src/collector-receipt.ts`, `src/collector-tool-schemas.ts`, `src/collector-role.ts`

Facts that hold today:

- **Manifest shape:** `version` + `legs[{ id, expectedAuthors, request? }]` only. There is **no** `protocol` field.
- **Transport surfaces:** user, pull request, submitted reviews, issue comments, and review comments only. v1 does **not** collect reactions, check runs, or commit statuses as ledger transport.
- **`valid`:** a qualifying submitted review whose `commit_id` matches the exact target HEAD (plus existing cite rules).
- **Submitted leg statuses:** `valid` | `unavailable` | `missing` only.
- **`pending`:** internal/semantic only; never a submitted receipt status. Collector has no submitted `refused` or `completed` status.

A provider’s operational completion and its findings outcome remain separate facts even under future designs: a completed review may contain findings; `valid` must not mean “clean.”

## Observations (non-normative)

Positive durable object anchors only. Live GitHub objects can mutate or disappear; these are research evidence, not terminal rules. Negative absences without captured fixtures are omitted.

### Hosted Codex — documented surfaces

OpenAI documents `@codex review` as the hosted trigger and describes a standard GitHub review. Primary sources:

- [OpenAI: GitHub code review](https://developers.openai.com/codex/integrations/github/)
- [OpenAI: Codex GitHub Action](https://developers.openai.com/codex/github-action/)

The hosted connector and `openai/codex-action` are different protocols. An Action’s check, output schema, checkout ref, and posted comment are repository-defined and cannot be treated as the hosted connector’s fixed result format.

### Hosted Codex — PR #5 positive observation @ `c73bf31…`

| Object | Durable anchor |
| --- | --- |
| PR container | https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5 |
| Target commit | `c73bf31a3d22815b26b9a33a5d28fd1f242f5701` |
| Issue comment (positive) | API id `5102352848` · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5#issuecomment-5102352848 · `chatgpt-codex-connector[bot]` · `2026-07-28T09:27:54Z` · body includes `Didn't find any major issues` and `Reviewed commit: c73bf31a3d` |

**Observation only.** This comment is not a documented native terminal form, not profile-authorized, and not structured full-SHA binding. The comment is mutable. Do not treat it as package law.

### CodeRabbit — documented surfaces

CodeRabbit documents automatic and manual review triggers, including `@coderabbitai review` and `@coderabbitai full review`. Its default `reviews.review_progress` publishes progress through a GitHub check run; `reviews.commit_status` is the legacy status mirror when progress is disabled.

Primary sources:

- [Code review triggers and events](https://docs.coderabbit.ai/guides/code-review-overview#review-triggers-and-events)
- [Manual commands](https://docs.coderabbit.ai/guides/commands#manually-request-code-reviews)
- [Configuration: review progress](https://docs.coderabbit.ai/reference/configuration#param-review-progress)
- [Request-changes workflow](https://docs.coderabbit.ai/reference/configuration#param-request-changes-workflow)
- [Rate-limit behavior](https://docs.coderabbit.ai/management/plans#when-a-review-is-rate-limited)

The docs do not define a stable machine-readable zero-findings count. Check/status success proves operational completion, not necessarily absence of findings. Approval is optional and can follow resolution of earlier findings, so it is not a universal clean-review signal.

### CodeRabbit — PR #4 multi-surface demo (non-normative)

| Object | Durable anchor |
| --- | --- |
| PR container | https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4 |
| Walkthrough issue comment | API id `5099890151` · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#issuecomment-5099890151 · `coderabbitai[bot]` · `2026-07-28T04:18:36Z` |
| Pull request review | Review id `4793700581` · `COMMENTED` · `commit_id: c5f75b63415bf24b8a2318ef8744a60d255eb135` · `2026-07-28T04:24:49Z` · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#pullrequestreview-4793700581 |
| Inline review comment | id `3662760359` · `pull_request_review_id: 4793700581` · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/4#discussion_r3662760359 · `2026-07-28T04:24:48Z` |
| Commit status | id `51192757994` · `context: CodeRabbit` · `state: success` · `2026-07-28T04:24:51Z` · on `c5f75b63415bf24b8a2318ef8744a60d255eb135` |

Optional secondary (later pass, only if text mentions it): review `4797137516`; discussion `3665422516`; statuses `51213941087` / `51214696930`.

### Cursor Bugbot — documented surfaces

Cursor documents that every run publishes a `Cursor Bugbot` check. Documented conclusions:

- `success`: no issues and no unresolved earlier Bugbot comments;
- `neutral`: overloaded (docs group findings, cancellation by a newer commit, or internal error under this conclusion);
- `failure`: findings when fail-on-unresolved-issues is enabled.

Primary sources:

- [Cursor Bugbot: how it works and CI statuses](https://cursor.com/docs/bugbot#how-it-works)
- [Cursor Bugbot API](https://cursor.com/docs/bugbot#api)

The enterprise API’s completed-review records expose `commit_sha`, `bugs_found`, and findings as **documented API fields**. They are not by themselves a GitHub-check discriminator for ordinary installations. On ordinary GitHub installations, the check run is the strongest completion source among documented surfaces.

**Not established:** reliable discrimination of `neutral` subtypes solely via check output text. Treat any such reading as unsupported until first-party docs and fixtures say otherwise.

### Cursor Bugbot — PR #5 quota observation @ `c73bf31…`

| Object | Durable anchor |
| --- | --- |
| Usage-limit issue comment | API id `5102308579` · https://github.com/Akagilnc/ak-pi-workflow-roles/pull/5#issuecomment-5102308579 · `cursor[bot]` · `2026-07-28T09:23:40Z` |
| Check run | id `90233500616` · `Cursor Bugbot` · `conclusion: neutral` · `head_sha: c73bf31a3d22815b26b9a33a5d28fd1f242f5701` · https://github.com/Akagilnc/ak-pi-workflow-roles/runs/90233500616 |

**Observation only.** The pair (HEAD-bound neutral check + usage-limit comment) was observed in this repository. Observed check output titles are not stable discriminators. The comment alone is not HEAD-bound; the check is.

### Platform object semantics (explanation only)

GitHub PR conversation comments are issue comments and have no commit field. Reactions identify a parent PR/comment and actor but have no commit field. By contrast:

- submitted pull-request reviews expose `commit_id`;
- inline review comments expose review and commit provenance;
- check runs expose `head_sha`, status, conclusion, app, and output;
- commit statuses can be queried at a literal SHA.

These are platform facts that explain why providers differ. They do **not** imply that Collector v1 transport implements reactions, checks, or statuses.

GitHub API references:

- [Pull request reviews](https://docs.github.com/en/rest/pulls/reviews)
- [Pull request review comments](https://docs.github.com/en/rest/pulls/comments)
- [Issue and PR comments](https://docs.github.com/en/rest/issues/comments)
- [Reactions](https://docs.github.com/en/rest/reactions/reactions)
- [Check runs](https://docs.github.com/en/rest/checks/runs)
- [Commit statuses](https://docs.github.com/en/rest/commits/statuses)

## Future sketches (unaccepted / unimplemented)

> **Not usable contracts.** Nothing below ships with ADR 0011 or current v1. Any bundled profile would need first-party documentation support **and** captured GitHub API fixtures for every accepted terminal form before becoming package law. Undocumented observed forms may be preserved as evidence but must not silently become normative terminal rules.

### Protocol profiles + manifest `protocol` field

Sketch only — v1 has no `protocol`:

```json
{
  "id": "codex",
  "protocol": "codex-hosted-github-v1",
  "expectedAuthors": ["chatgpt-codex-connector[bot]"],
  "request": { "body": "@codex review" }
}
```

Other initial profile names under discussion: `coderabbit-github-v1`, `cursor-bugbot-github-v1`. Collector must not infer a profile from bot names or repository contents.

### Extended transport

Future profiles might interpret additional immutable ledger surfaces (reactions, check runs, commit statuses) on top of a shared complete/paginated GitHub transport. A protocol profile would own only trigger rules and evidence interpretation. **Not implemented in v1.**

### Multi-state operation model + binding-kind split

A future receipt might keep these concepts distinct:

1. **operation state** (design sketch; not v1 submitted statuses);
2. **review outcome:** findings, no findings, or unspecified;
3. **binding kind:** exact structured SHA or provider-attested HEAD;
4. **evidence provenance:** author/app, IDs, timestamps, immutable observed versions, and cited snapshot.

This is unaccepted design, not current receipt shape.

### Former “profile should therefore” bullets (sketch only)

**Hosted Codex (sketch):** prefer exact submitted-review `commit_id` evidence; accept a documented no-findings native form only from the configured bot/app **after** first-party support and fixtures exist; resolve any stated SHA prefix uniquely to the target HEAD; require request/observation timestamps and a stable PR HEAD bracket; preserve raw evidence and disclose weaker binding kinds; never reinterpret prose such as “no major issues” as GitHub approval or merge readiness.

**CodeRabbit (sketch):** bind completion through a configured CodeRabbit check run’s `head_sha`, or through its latest commit status queried at the exact target SHA; collect same-HEAD reviews and inline comments as findings/report evidence; distinguish the documented passing `Review rate limited` check from a completed review; treat walkthrough comments as report data, not sole HEAD proof; avoid inferring “clean” merely from zero new comments or a successful progress check.

**Cursor (sketch):** select the configured Cursor app’s completed `Cursor Bugbot` check with `head_sha === targetHead`; classify `success` as the documented no-issues outcome; only classify overloaded `neutral` subtypes when structured evidence and fixtures support it; identify quota/internal-error/cancellation as unavailable rather than findings or clean completion; re-read PR HEAD before certification.

### Head movement and mutation (sketch discipline)

For every future profile:

- record target HEAD before the request;
- bracket requests and terminal observations with PR snapshots;
- reject structured records bound to another SHA;
- restart or remain missing after HEAD movement;
- preserve prior-head reports;
- preserve first-observed content versions because comments, reviews, reactions, checks, and statuses have different mutation/deletion behavior.
