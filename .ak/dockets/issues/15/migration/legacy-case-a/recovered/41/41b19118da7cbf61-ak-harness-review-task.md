# Fresh independent review — architecture wave 4

Fixed point: `802d28af17efa588aa12d9f8dc689e4a740ebc1d`
Reviewed target: `c5f75b63415bf24b8a2318ef8744a60d255eb135`

Review exactly this committed test-harness deepening wave.

Spec authority:
1. `/tmp/ak-roles-test-harness-task.md`
2. `/tmp/ak-harness-plan-revision.md`
3. `/tmp/ak-harness-approved-plan.md`
4. Judge approval `/tmp/ak-harness-plan-judge-2.jsonl`

Repository standards include CLAUDE.md, CONTEXT.md, ADRs 0001–0009, existing package behavior, CI, and tests.

Independently inspect exact test-name/assertion preservation, local help exit-code and manifest assertions, raw process/provider/session/tool evidence visibility, harness depth and deletion test, cleanup/throw identity, empty-HOME hermeticity, production byte identity, package contents, and whether one-off scenarios stayed local. Seek concrete cases where abstraction hides failures or tests cease to cross real Pi interfaces.

Run Standards and Spec in one sibling parallel Agent batch. Scratch probes only in assigned clones. Do not repair, commit, push, or mutate the original target.
