# Plan evidence packet (contributor template)

This file is a **repository-contributor template** for a manually supplied Plan
(construction-readiness) artifact. The filename identifies an **evidence
burden**, not a verdict, phase flag, transition, or required
predecessor/successor.

Selection, composition, and use are **caller-owned** (ADR 0010). Plan posture
semantics remain solely in `souls/judge.md`. This template does not restate or
amend that law. It creates no routing, topology, role-order, package memory, or
proof that construction occurred.

## Sealed authority identity

Bind the authority materials this plan consumes. Digests seal identity only—not
truth, acceptance, or freshness.

| Artifact | Repository-relative path | SHA-256 of exact bytes |
| --- | --- | --- |
| Authority packet / inputs | | |

## Planned changes — five readiness facts

For **each** proposed change, record exactly these five facts. Do not demand
fixture pseudocode or blanket `file:line` here.

### Change P1

| Fact | Content |
| --- | --- |
| **Behavior** | Observable requirement or defect addressed |
| **Owner** | Deep module / seam that owns the behavior |
| **Red** | Counterexample that must fail before the fix |
| **Green** | Observable result that proves the fix |
| **Scope** | What deliberately stays unchanged |

### Change P2

| Fact | Content |
| --- | --- |
| **Behavior** | |
| **Owner** | |
| **Red** | |
| **Green** | |
| **Scope** | |

Add P3… as needed. Every planned change must be reconcilable to the sealed
authority identity above and must carry all five facts.

## Explicit non-claims

- Filename is not a verdict and does not authorize or prove Apply success.
- This packet does not claim construction already happened.
- No orchestration, next-role, or stage-machine semantics arise from this file.
- No mechanical schema/runtime enforcement is claimed by this template.
