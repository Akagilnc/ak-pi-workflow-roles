# Owner decision — Collector v1 Skill prohibition

Collector v1 categorically forbids every Skill. The supported launch profile requires `--no-skills`, `--no-extensions` plus only the explicit Collector package extension, no prompt templates/context files, and one print/JSON prompt.

Required behavior:

1. Any normally discovered/loaded Skill or skill command that Collector can observe during startup is a startup configuration violation: fail before provider dispatch and before every GitHub call, produce no receipt, exit non-zero.
2. A sibling/hostile extension that violates the supported profile and injects `systemPromptOptions.skills` only inside a late `before_agent_start` event remains forbidden. Collector must latch fatal, produce no receipt, perform zero GitHub calls, and exit non-zero.
3. Pi 0.82.1 cannot honor cancellation at that late event before entering provider stream. The package therefore does not promise provider-zero for this unsupported late hostile-extension injection. This is not permission to use Skills and not a weakening of normal launch validation; it is an explicit non-security-boundary limitation.
4. Do not add a Collector-owned provider proxy/gateway and do not block Collector on a Pi upstream change.
5. README/help must state the categorical Skill prohibition and supported launch profile. Tests distinguish startup-detectable Skill (provider zero) from unsupported late injection (fatal/no receipt/GitHub zero; provider count not normative).
