# Fresh independent Collector v1 review

Fixed point: `c5f75b63415bf24b8a2318ef8744a60d255eb135`
Target: `3bec03f84b1bee6a5f7d7c7068028b3c2849116f`
Exact range: `c5f75b6...3bec03f`

Review the complete committed Collector v1 construction and all forward repair commits. Do not repair, commit, push, or mutate the original worktree. Scratch probes only in isolated Reviewer Agent clones.

## Spec authority

Read fully:

- `/tmp/ak-collector-v1-authority-v2.md`
- `/tmp/ak-collector-v1-authority-v3-addendum.md` (controls conflicts)
- `/tmp/ak-collector-approved-synthesis.md`
- `/tmp/ak-collector-owner-decision-skill.md`
- design convergence `/tmp/ak-collector-design-judge-3.jsonl`
- final apply adjudication `/tmp/ak-collector-postfix5-judge.jsonl`

The owner decision means Collector categorically forbids all Skills. Normally loaded/discovered Skills must fail before provider/GitHub/receipt. Unsupported hostile sibling-extension injection first visible at late `before_agent_start` must fatal/no receipt/GitHub-zero, while provider count is non-normative under Pi 0.82.1. Do not demand a provider proxy or Soul change.

## Standards authority

Read repository `CLAUDE.md`, `CONTEXT.md`, README, package manifest, ADRs, existing role architecture, Soul discipline, and tests. Collector remains standalone and caller-independent; no orchestrator integration is authorized.

## Required scrutiny

Run Standards and Spec as fresh sibling parallel Agent legs. Independently inspect/probe:

- exact CLI target/manifest validation and no implicit bot;
- fixed github.com transport, complete pagination, request marker/race honesty;
- 15-minute controlled cutoff, HEAD/final-snapshot timing, PR state;
- exact valid/unavailable/missing semantics and authoritative version times;
- prior-head/edit/dismiss/delete/inline findings preservation;
- singular TypeBox schema ownership and finalized-message batch-before-execute gate;
- per-leg evidence ownership, recovery, self-contained receipt, ID uniqueness;
- exact 8/32 MiB loud failure without truncation;
- purpose-built observe/request/wait/output tools and no mutation drift;
- one-shot prompt replacement, startup/profile/Skill fail-closed behavior;
- real executable gh, real Pi, installed-tarball and empty-HOME seams;
- Soul thinness and package contents;
- whether large tests duplicate implementation, mislabel probes, or leave a real counterexample;
- preservation of Judge/Fixer/Coder/Reviewer behavior.

Run typecheck, an initially empty-HOME full suite, pack dry-run exact contents, and diff-check in scratch clones as useful. Report only concrete findings with severity and evidence; distinguish authority violations from judgment-call smells. Aggregate both legs faithfully and submit only through `ak_reviewer_output`.
