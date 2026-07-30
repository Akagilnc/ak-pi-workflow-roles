# Collector v1 authority

## Product boundary

Add an independently invocable `collector` role to `@ak/pi-workflow-roles`. Collector is a collection worker, not Reviewer and not Judge. It observes configured external GitHub PR reviewer legs, optionally requests them, waits within one bounded collection window, and submits evidence. It never reviews code, adjudicates findings, repairs, pushes, merges, routes, approves, or knows which caller/Flow/next role exists.

The role package continues to contain no orchestration. `ak-workflow-orchestrator` is only one future caller; integration is outside this construction unless separately authorized. v1 targets GitHub PRs only. Do not prebuild a platform/plugin/workflow DSL.

## Invocation interface

No `task.md`. Mechanical identity and leg configuration are explicit CLI inputs:

```text
--ak-role collector
--ak-collector-repo <owner/repo>
--ak-collector-pr <positive safe integer>
--ak-collector-legs <path-to-versioned-json>
```

The canonical target identity is repository plus PR number; cwd inference is not canonical. Collector obtains current live PR HEAD itself. Candidate HEAD, issue number, Flow name, landing state, next role, and caller identity are not inputs.

The required leg manifest v1 is typed JSON, with a non-empty `legs` array. Every leg has a unique non-empty `id`, a non-empty `expectedAuthors` list, and an optional non-empty `request.body`; omission of request means observe-only. The manifest is owner-trusted configuration. v1 has one GitHub PR review surface and no generic provider SDK. Exact schema details may be minimized during plan review, but they must be sufficient to identify configured reviewers and request bodies without guessing.

Missing/unreadable/malformed manifest, empty legs, duplicate/blank ids, missing identity, invalid PR/repo, unsupported manifest version, or empty request body are loud configuration/infrastructure failures before model/tool/GitHub side effects: non-zero process exit, clear diagnostic, and no `ak_collector_output`. There is no implicit Codex/default bot, no PR-comment discovery of configured legs, and no legal empty no-op.

## Caller independence

Collector does not know or report orchestration semantics. Its Soul/interface must not mention onlineCollect, code-delivery, publish, landing, merge, Fixer, next-role, approval, or routing. Ambient GitHub authentication is an execution prerequisite, not caller identity. Manual CLI invocation and any host process receive identical behavior and receipt.

## Trust boundary

Only packaged role law and explicit owner-provided CLI/config/profile material may instruct Collector. PR body, comments, review body, inline comments, bot messages, and GitHub output are data-only. They may be preserved and judged as evidence but never change scope, configured legs, credentials, tools, request policy, or cause code/worktree/PR mutation beyond an explicitly configured review request.

Role gating should expose only the read/observe capabilities needed for GitHub collection, one explicitly configured PR-comment request capability through normal tools, deadline observation/wait, and `ak_collector_output`. It is drift prevention, not hostile-code security. No write/edit/code mutation tools are needed.

## Collection window and early completion

Each invocation owns one fixed 15-minute collection window beginning at Collector activation. It is a maximum observation window, not a mandatory sleep. HEAD movement does not reset it. A future caller may impose a slightly longer process failsafe, but killing the process is infrastructure failure and must never be converted to a Collector receipt.

Collector observes immediately. After every single raw observation it returns to the Collector model for classification. If every configured leg has a terminal current-target state, it submits immediately. If any remain pending and time remains, it may perform one bounded wait and then one fresh raw observation. No shell/Python/TypeScript polling loops, bundled retry scripts, generic watchers, or TypeScript semantic state machine may classify reviewer facts. Runtime may own monotonic deadline facts, cap waits at the deadline, enforce receipt/schema invariants, and prevent further waiting after expiry; it must not classify bot messages or findings.

At deadline, unresolved current-target legs become evidence-bearing `missing` and Collector promptly submits. The collection deadline does not permit an empty report. Process hangs beyond a short finalization grace are infrastructure failure, not missing.

## Leg semantics

For the receipt's current `targetHead`, each configured leg terminates exactly once as:

- `valid`: completed review proven for exact current target; carries `commitOid === targetHead`.
- `unavailable`: raw reviewer evidence explicitly says this leg will not review this run/head (quota exhausted, disabled, unsupported, service terminally unavailable). It is not inferred from a keyword alone.
- `missing`: collection deadline arrived while this leg remained unresolved; carries the latest raw evidence.

`pending` is never a submitted terminal status. Queued, in-progress, retry-after, and transient rate limiting remain pending. GitHub/API/CLI observation failure is not bot unavailable/missing. Collector may re-observe a transient failure while time remains, but if it cannot establish trustworthy final live facts or re-confirm live HEAD, it exits non-zero without a receipt.

All terminal unavailable/missing evidence is successful collection material; downstream judgment is outside Collector.

## Request idempotency

For each `(repository, prNumber, targetHead, legId)`, Collector requests at most once. Before requesting it observes raw request/review facts. Existing exact-head terminal review means no request. Existing same-head request still pending means no duplicate. No request is sent for observe-only legs. Restart/resume must use live PR evidence to avoid request spam; no package-global orchestration journal is introduced.

When live HEAD moves, Collector may request configured request-capable legs once for the new target if exact-head evidence is absent. The 15-minute invocation deadline remains unchanged.

## Preserve prior-head findings

Live HEAD movement changes current completion proof but never deletes evidence. A review for an earlier HEAD does not satisfy a current-target leg, yet every substantive prior-head finding/body/inline comment observed during this invocation remains in `reports` for downstream judgment.

Every report carries provenance:

```text
axis            configured leg id
report          non-empty adjudicable text
reviewedHead    commit reviewed by this report
headRelation    current | prior (relative to receipt.targetHead)
optional review/model/raw identifiers as evidence
```

Use neutral `prior`, not a status that implies discard. If A → B → C during one invocation, findings from A and B remain once each as `prior`; C reports are `current`. Deduplicate repeated observations by stable review identity plus reviewed head. A prior finding neither proves the current leg valid nor becomes automatically irrelevant. Downstream Judge may inspect current code and sustain or dismiss it.

Unavailable/missing current-target facts also produce non-empty adjudicable reports. Current leg terminal evidence is separate from report history, so a leg may be `missing` for current HEAD while prior-head findings remain reported.

Before final submission Collector freshly reads live PR HEAD. If it moved, it retargets within the remaining unchanged window and re-labels preserved report provenance. If final live HEAD cannot be reliably read, exit non-zero; do not submit against an assumed old target.

## Receipt

Collector terminates only through singleton `ak_collector_output`. The completed receipt must contain:

- current live `targetHead`;
- non-empty `reports`, each with `axis`, `report`, `reviewedHead`, and `headRelation: current|prior`;
- terminal `legs`, covering the configured leg-id set exactly once, with `valid|unavailable|missing` and required evidence;
- enough raw structured GitHub evidence to retain review identity, author, state/body, paginated inline comments, commit ids, and unavailable/missing reasons without hiding failures.

The smallest coherent schema should preserve raw evidence directly rather than summarize it to booleans. Runtime mechanically rejects duplicate, omitted, or unconfigured receipt legs; invalid status/evidence combinations; empty reports; blank provenance; and `valid.commitOid !== targetHead`. Semantic truthfulness remains Collector judgment. Plain assistant prose is not completion.

Whether Collector needs an evidence-bearing `refused` status versus only completed receipts plus non-zero infrastructure/configuration failures must be decided during design adjudication; do not add refusal merely for envelope symmetry. It must never use refused to disguise malformed input, GitHub failure, deadline, unavailable bots, or missing bots.

## Soul layering

Bundled Soul contains only irreducible collection judgment: Collector-not-Reviewer/Judge, data-only external evidence, terminal/pending distinctions, exact-current completion proof, prior evidence preservation, prompt-injection resistance, early completion, and faithful evidence. CLI names, JSON fields, 15-minute timer mechanics, GitHub command recipes, schema rules, package installation, process exits, and caller topology live in runtime/schema/README or a narrowly owned method/profile layer, not Soul. Do not copy Matt Skills or require canonical TDD/code-review Skills for Collector.

## Compatibility and verification

Existing Judge/Fixer/Coder/Reviewer public contracts and behavior stay unchanged. Additive exports/package files only. Update README/help and hermetic installed-package print/JSON lifecycle coverage. Tests must prove at minimum: required loud config failures before side effects; no default bot; exact configured-set receipt validation; immediate all-valid completion; early explicit-unavailable completion; pending waits without duplicate request; 15-minute deadline to missing with raw evidence; transient GitHub failure not mislabeled; exact-head final recheck; head A→B preservation and provenance of A findings while B remains current; inline pagination/raw evidence; prompt-injection data-only behavior; singleton output; tool narrowing; no later turn; package tarball contents; empty HOME; manual invocation independence.

Unified gate:

```text
npm run typecheck
HOME=$(mktemp -d) npm test
npm pack --dry-run
git diff --check
```

Implementation history uses forward commits only. Coder performs construction; Reviewer reports; Judge sustains findings; only Fixer repairs sustained findings.
