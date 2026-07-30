# Dogfood finding — Collector wait cadence

Finding: 单次 wait 可合法吃满剩余 collection window，把 early completion 原则架空。

Evidence:

- dogfood PR #4 operation chain: `observe → request → wait 30s → observe → wait 60s → observe → wait 900000ms`，最后一次 wait 被 runtime 仅按剩余 deadline 封顶，等价于睡到截止。
- dogfood PR #5 under the same law selected `60s / 180s / 180s` cadence.
- Cadence therefore depends entirely on model variance. If an external review completes shortly after PR #4's long wait begins, Collector cannot observe it until up to roughly twelve minutes later, contrary to early-completion intent.

Suggested repair direction is evidence, not prescription: runtime already owns monotonic deadline and wait capping. A bounded single wait such as `min(requested, remaining eligibility / 2, 300s)` could force return to the model while preserving shorter choices. Do not add a scheduler, watcher, polling loop, new mechanism, or Runner behavior.

Authority question that must be answered before construction:

- Current authority says waits are capped at the eligibility deadline and Collector submits early when all legs are terminal.
- Does tightening the runtime-owned maximum single wait require an authority addendum because it changes behavior, or is it an implementation/method cadence detail already owned by runtime?

Required acceptance if sustained:

1. Red test: a wait request above the new per-wait cap is truncated to the exact allowed duration.
2. Red scenario: PR4-style remaining-window sleep returns control to the model at the cap so a fresh observation can occur before the overall deadline.
3. No scheduler, generic watcher, additional timer mechanism, or public contract change.
4. Forward commit and full gates: typecheck, initially empty-HOME test suite, pack dry-run, diff-check.
