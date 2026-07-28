# External GitHub reviewer protocols

Research snapshot: 2026-07-28

## Decision summary

Collector must adapt to documented reviewer protocols rather than require every reviewer to emit a GitHub `PullRequestReview`.

The providers studied expose different completion surfaces:

| Protocol | Findings | No findings | Unavailable | Best HEAD binding |
| --- | --- | --- | --- | --- |
| Hosted Codex | Submitted review plus inline review comments | PR-level `+1` reaction and, in observed runs, an issue comment naming the reviewed commit | No documented structured form found | Findings: review `commit_id`. No findings: provider-attested short SHA plus a HEAD-stable request/observation bracket; no structured SHA exists. |
| CodeRabbit | Reviews, inline comments, and walkthrough text | No documented zero-findings field | Documented rate-limit comment plus passing `Review rate limited` check; other review errors use the progress surface | Check-run `head_sha`, or a commit status queried at the literal SHA; reviews/comments additionally carry commit fields. |
| Cursor Bugbot | HEAD-bound check plus review/inline findings | `Cursor Bugbot` check with `conclusion: success` | `neutral` is overloaded; check output distinguishes findings, cancellation, internal error, and observed quota failures | Check-run `head_sha`; enterprise analytics additionally exposes `commit_sha`. |

A provider's operational completion and its findings outcome are separate facts. A completed review may contain findings; `valid` must not mean “clean.”

## Why one universal review-object rule fails

GitHub PR conversation comments are issue comments and have no commit field. Reactions identify a parent PR/comment and actor but have no commit field. By contrast:

- submitted pull-request reviews expose `commit_id`;
- inline review comments expose review and commit provenance;
- check runs expose `head_sha`, status, conclusion, app, and output;
- commit statuses can be queried at a literal SHA.

The Collector v1 rule accepted only submitted reviews with `commit_id`. That is strong for providers that always create reviews, but hosted Codex does not do so for every successful no-findings run. Requiring that shape turns a real provider conclusion into `missing`.

GitHub API references:

- [Pull request reviews](https://docs.github.com/en/rest/pulls/reviews)
- [Pull request review comments](https://docs.github.com/en/rest/pulls/comments)
- [Issue and PR comments](https://docs.github.com/en/rest/issues/comments)
- [Reactions](https://docs.github.com/en/rest/reactions/reactions)
- [Check runs](https://docs.github.com/en/rest/checks/runs)
- [Commit statuses](https://docs.github.com/en/rest/commits/statuses)

## Hosted Codex

OpenAI documents `@codex review` as the hosted trigger and describes a standard GitHub review. Its generated GitHub boilerplate says that suggestions produce comments while no suggestions produce a thumbs-up reaction.

Primary sources:

- [OpenAI: GitHub code review](https://developers.openai.com/codex/integrations/github/)
- [OpenAI: Codex GitHub Action](https://developers.openai.com/codex/github-action/)

The hosted connector and `openai/codex-action` are different protocols. An Action's check, output schema, checkout ref, and posted comment are repository-defined and cannot be treated as the hosted connector's fixed result format.

### Observed on roles PR #5

Findings runs created `COMMENTED` reviews whose full `commit_id` matched the requested HEAD and whose inline comments joined through `pull_request_review_id`.

The no-findings run for `c73bf31a3d22815b26b9a33a5d28fd1f242f5701` created:

1. a PR-level `+1` reaction by `chatgpt-codex-connector[bot]`; and
2. an issue comment saying `Didn't find any major issues` and `Reviewed commit: c73bf31a3d`.

It created no `PullRequestReview` and no Codex check run. The conclusion is real provider evidence, but its commit binding is provider-attested prose rather than a structured full SHA. The comment is mutable and the reaction is deletable.

A Codex protocol profile should therefore:

- prefer exact submitted-review `commit_id` evidence;
- accept the documented no-findings native form only from the configured bot/app;
- resolve the stated SHA prefix uniquely to the target HEAD;
- require request/observation timestamps and a stable PR HEAD bracket;
- preserve the raw comment and reaction and disclose the weaker binding kind;
- never reinterpret “no major issues” as GitHub approval or merge readiness.

## CodeRabbit

CodeRabbit documents automatic and manual review triggers, including `@coderabbitai review` and `@coderabbitai full review`. Its default `reviews.review_progress` publishes progress through a GitHub check run; `reviews.commit_status` is the legacy status mirror when progress is disabled.

Primary sources:

- [Code review triggers and events](https://docs.coderabbit.ai/guides/code-review-overview#review-triggers-and-events)
- [Manual commands](https://docs.coderabbit.ai/guides/commands#manually-request-code-reviews)
- [Configuration: review progress](https://docs.coderabbit.ai/reference/configuration#param-review-progress)
- [Request-changes workflow](https://docs.coderabbit.ai/reference/configuration#param-request-changes-workflow)
- [Rate-limit behavior](https://docs.coderabbit.ai/management/plans#when-a-review-is-rate-limited)

The docs do not define a stable machine-readable zero-findings count. Check/status success proves operational completion, not necessarily absence of findings. Approval is optional and can follow resolution of earlier findings, so it is not a universal clean-review signal.

A CodeRabbit protocol profile should:

- bind completion through a configured CodeRabbit check run's `head_sha`, or through its latest commit status queried at the exact target SHA;
- collect same-HEAD reviews and inline comments as findings/report evidence;
- distinguish the documented passing `Review rate limited` check from a completed review;
- treat walkthrough comments as report data, not sole HEAD proof;
- avoid inferring “clean” merely from zero new comments or a successful progress check.

On PR #4, CodeRabbit demonstrated all three relevant surfaces: a `CodeRabbit` status, a mutable walkthrough issue comment, and a `COMMENTED` review with an exact `commit_id` plus an inline actionable finding.

## Cursor Bugbot

Cursor documents that every run publishes a `Cursor Bugbot` check. Its conclusions are:

- `success`: no issues and no unresolved earlier Bugbot comments;
- `neutral`: findings, cancellation by a newer commit, or internal error;
- `failure`: findings when fail-on-unresolved-issues is enabled.

Primary sources:

- [Cursor Bugbot: how it works and CI statuses](https://cursor.com/docs/bugbot#how-it-works)
- [Cursor Bugbot API](https://cursor.com/docs/bugbot#api)

The enterprise API's completed-review records expose `commit_sha`, `bugs_found`, and findings. On ordinary GitHub installations, the check run is the strongest completion source.

A Cursor protocol profile should:

- select the configured Cursor app's completed `Cursor Bugbot` check with `head_sha === targetHead`;
- classify `success` as the documented no-issues outcome;
- inspect structured check output and same-HEAD reviews for overloaded `neutral` outcomes;
- identify quota/internal-error/cancellation as unavailable rather than findings or clean completion;
- re-read PR HEAD before certification.

Observed quota runs in this repository used a HEAD-bound neutral check plus an issue comment saying usage limit was reached. The comment alone is not HEAD-bound; the check is.

## Collector design requirements

### Explicit protocol, no guessing

Each manifest leg should select a bundled, versioned protocol explicitly, for example:

```json
{
  "id": "codex",
  "protocol": "codex-hosted-github-v1",
  "expectedAuthors": ["chatgpt-codex-connector[bot]"],
  "request": { "body": "@codex review" }
}
```

Other initial profiles can be `coderabbit-github-v1` and `cursor-bugbot-github-v1`. Collector must not infer a profile from bot names or repository contents.

### Shared evidence capabilities

Profiles should interpret a common set of immutable ledger surfaces rather than each owning transport:

- pull-request snapshots;
- issue comments and immutable observed versions;
- submitted reviews and inline review comments;
- PR/issue/comment reactions;
- check runs;
- commit statuses.

The GitHub transport remains shared and complete/paginated. A protocol profile owns only trigger rules and evidence interpretation.

### Separate facts in the receipt

The receipt should keep these concepts distinct:

1. **operation state:** pending, completed, unavailable, or missing;
2. **review outcome:** findings, no findings, or unspecified;
3. **binding kind:** exact structured SHA or provider-attested HEAD;
4. **evidence provenance:** author/app, IDs, timestamps, immutable observed versions, and cited snapshot.

This preserves honesty where a provider's documented native completion lacks structured SHA binding.

### Head movement and mutation

For every profile:

- record target HEAD before the request;
- bracket requests and terminal observations with PR snapshots;
- reject structured records bound to another SHA;
- restart or remain missing after HEAD movement;
- preserve prior-head reports;
- preserve first-observed content versions because comments, reviews, reactions, checks, and statuses have different mutation/deletion behavior.

### Documentation is necessary but not sufficient

First-party docs define supported behavior, but often omit stable app IDs, check names, exact payload schemas, or trigger-to-run correlation IDs. Every bundled profile therefore needs both:

- citations to the provider's documented behavior; and
- captured GitHub API contract fixtures for every accepted terminal form.

Undocumented observed forms may be preserved as evidence but must not silently become normative terminal rules.
