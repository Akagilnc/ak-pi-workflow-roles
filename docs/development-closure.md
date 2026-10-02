# Development closure (contributor / dogfood checklist)

This document owns **only this repository’s** contributor and dogfood checklist
for closing role-package construction work. It is descriptive host practice.

It is **not** packaged workflow authority, not a generic role-ordering rule, not
a transition machine, not package memory, not a mechanical gate, and not a
runtime budget. Callers outside this repository owe it nothing (ADR 0010).

Role-result authority: [submission contracts](../src/package-contracts/terminating-tools.ts)
and [ADR 0003](adr/0003-per-role-submission-tools.md). Caller-owned composition and
budgets: [ADR 0010](adr/0010-callers-own-role-composition-and-repetition.md).
A development-trail entry may preserve or cite the Receipt but is not
itself a verdict and cannot replace the Receipt.

## Canonical manual record sequence

Maintainers walk these beats in order when they apply. An inapplicable beat may
be omitted only with an **explicit disposition** recorded in the trail.

1. **Identify authority inputs** — instantiate or cite authority materials with
   repository-relative path + SHA-256 of exact bytes (see
   `packets/judge-authority.md`).
2. **Record any authority judgment** — preserve/cite the Authority typed Receipt
   in the trail against the identified inputs.
3. **Record a construction plan** — use [the Plan template](../packets/judge-plan.md).
4. **Preserve construction receipt / commit / test evidence** — keep the worker
   report, full target commit SHA, and test evidence that the construction
   actually produced.
5. **Record Apply judgment** — preserve/cite the Apply typed Receipt in the
   trail against authority/plan identities and the committed target (see
   `packets/judge-apply.md`).
6. **Preserve independent review and per-finding adjudication** — bind each
   finding/disposition to authority, a fixed reviewed range (full base
   and target SHAs), and current facts (see `packets/judge-review.md`).
7. **Issue forward repair material when needed** — write opaque prose
   instructions (see `packets/fixer-repair.md`) and, only when needed, a separate
   typed prerequisite attachment (see `packets/fixer-prerequisites.json`) without
   overwriting prior artifacts. Preserve the accepted current Fixer receipt and
   its audit observation; fields are defined by [the Fixer contract](../src/package-contracts/fixer-output.ts).

## Artifact preservation rules

- An **accepted** artifact is preserved with its exact bytes, digest, and any
  typed Receipt preserved or cited in the trail.
- **Amendment or replacement** is a forward commit and new digest, with explicit
  disposition of the prior artifact. Do not rewrite history in place.
- Digests seal identity only—they do not prove truth, acceptance, or freshness.
- Code/apply facts also bind the full target commit SHA; review ranges bind full
  base and target commit SHAs.
- Packet filenames identify evidence burdens only. They do not imply verdicts,
  stages, topology, Judge origin, Fixer destination, or return paths.

## Restart hygiene

After session restart or context compaction, re-seed by **manually rereading**
the artifact trail (paths, digests, receipts, dispositions) before dispatching
new work. Package automatic retry behavior is owned by
[auto-resume](../src/public-cli/auto-resume.ts), not this manual checklist.
