# Fresh independent review — architecture wave 3

Fixed point: `05413b2e14b956e079eeb0bc20a1595fb562b3f6`
Reviewed target: `d8bfe1f6ed758c04fc9f35753ea9b92b854302c3`

Review exactly this committed role-runtime locality wave.

Spec authority:
1. `/tmp/ak-roles-runtime-deepening-task.md`
2. `/tmp/ak-runtime-coder-plan.md`
3. Judge plan approval `/tmp/ak-runtime-plan-judge.jsonl`

Repository standards include CLAUDE.md, CONTEXT.md, ADRs 0001–0009, public package behavior, and tests.

Inspect whether Judge, Worker, and Reviewer modules are genuinely deep; whether role-runtime is only composition; whether Coder/Fixer distinctions and named tools remain explicit; whether exports, lifecycle event ordering, diagnostics, Souls, tools, prompts, audits, fatal channels, and package contents remain compatible; and whether tests preserve real behavior without merely duplicating implementation. Apply the deletion test and reject generic role-framework drift.

Run Standards and Spec in one sibling parallel Agent batch. Scratch probes only in assigned clones. Do not repair, commit, push, or mutate the original target.
