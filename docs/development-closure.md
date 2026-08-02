# Development closure (contributor / dogfood checklist)

This document owns **only this repository’s** contributor and dogfood checklist
for closing role-package construction work. It is descriptive host practice.

It is **not** packaged workflow authority, not a generic role-ordering rule, not
a transition machine, not package memory, not a mechanical gate, and not a
runtime budget. Callers outside this repository owe it nothing (ADR 0010).

Each role verdict/judgment exists only in that role’s typed submission-tool
Receipt. A development-trail entry may preserve or cite the Receipt but is not
itself a verdict and cannot replace the Receipt. Filenames never carry
verdicts. Restart or compaction recovery is manual rereading of that trail; no
package resume semantics arise. Timeout guidance remains caller-owned and creates no runtime budget.

## Canonical manual record sequence

Maintainers walk these beats in order when they apply. An inapplicable beat may
be omitted only with an **explicit disposition** recorded in the trail.

1. **Identify authority inputs** — instantiate or cite authority materials with
   repository-relative path + SHA-256 of exact bytes (see
   `packets/judge-authority.md`).
2. **Record any authority judgment** — preserve/cite the Authority typed Receipt
   in the trail against the identified inputs. The trail entry is not the verdict
   and cannot replace the Receipt. Filename is not the verdict.
3. **Record a construction plan** — bind authority identity and record
   Behavior / Owner / Red / Green / Scope for each proposed change (see
   `packets/judge-plan.md`).
4. **Preserve construction receipt / commit / test evidence** — keep the worker
   report, full target commit SHA, and test evidence that the construction
   actually produced.
5. **Record Apply judgment** — preserve/cite the Apply typed Receipt in the
   trail against authority/plan identities and the committed target (see
   `packets/judge-apply.md`). The trail entry is not the verdict and cannot
   replace the Receipt.
6. **Preserve independent review and per-finding adjudication** — bind each
   finding/disposition to authority, a fixed reviewed range (full base
   and target SHAs), and current facts (see `packets/judge-review.md`).
7. **Issue a forward repair artifact when needed** — open a new `FixPacketV1`
   repair request using its current typed contract (see the
   `packets/fixer-repair.json` example) without overwriting prior artifacts.
   Preserve the accepted current Fixer receipt and its audit observation. Its
   typed `classResults` records completed or lawfully refused findings.

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
new work. Do not invent package-level memory or automatic resume.
