# Fresh independent review — architecture wave 1

Fixed point: `380b20515a821d6200625d5cb22cead2b699c25e`
Reviewed target: `6bb1eb6c10da4dcb5dd3132575298993346a085b`

Review exactly the committed wave-1 diff and log between those points using the canonical Matt code-review method.

Spec authority, in order:

1. `/tmp/ak-roles-ledger-deepening-task.md`
2. `/tmp/ak-ledger-plan-revision.md`
3. `/tmp/ak-ledger-approved-plan-candidate.md`
4. Judge approval in `/tmp/ak-ledger-plan-judge-2.jsonl`

Repository standards include `CLAUDE.md`, `CONTEXT.md`, applicable ADRs 0001–0009, existing public package behavior, and tests.

This is a behavior-preserving deep-module extraction. Pay particular attention to counterexamples involving atomic provenance ownership, legal/illegal attempt transitions, prior-fatal refusal blocking, immutable defensive audit records, Agent details/usage preservation, Pi lifecycle event ordering, bash evidence pairing, package exports, and regressions in Judge/Fixer/Coder/Reviewer. Evaluate whether the new module is genuinely deep rather than a moved state bag.

Run Standards and Spec as sibling parallel Agent calls in one assistant message. Writable probes are allowed only in assigned isolated scratch clones. Do not repair, commit, push, or mutate the original target.
