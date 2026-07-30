# Review task: external reviewer protocols and caller-owned composition

Review fixed diff `7f44baa719a048a3256df6000c4efd57f2666f0c...d26033eb8a95a501c1d1a62da718ac3d7f49d56e` in `/Users/akagilnc/WorkSpace/ak-pi-workflow-roles-reviewer-protocols`.

## Authority

Owner decisions:

1. Roles own only one invocation's internal work. Callers own role composition, order, repetition count, budgets, and stopping conditions. No role may acquire workflow rounds, next-role, or mandatory topology semantics.
2. Collector should adapt to external review bots' documented native protocols rather than require every bot to emit one universal GitHub object.
3. The current change is documentation/research only. It must not silently authorize runtime behavior not supported by cited primary sources.

## Review axes

Standards: repository documentation layering, ADR/domain-language quality, accuracy, internal consistency, scope, and maintainability.

Spec: completeness and fidelity to the three owner decisions; primary-source support for Codex, CodeRabbit, Cursor Bugbot and GitHub object semantics; clear distinction between documented contract, observed behavior, recommendation, and future design.

Review the committed diff only. Do not repair it. Use exactly the canonical code-review method and return one faithful aggregate report.
