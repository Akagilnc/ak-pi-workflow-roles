# Review evidence packet (contributor template)

This file is a **repository-contributor template** for a manually supplied
Review (finding-adjudication) artifact. The filename identifies an **evidence
burden**, not a verdict, phase flag, transition, or required
predecessor/successor.

Selection, composition, and use are **caller-owned** (ADR 0010). This template
records adjudication evidence only. It does **not** define Reviewer protocol,
alter Reviewer method/audit, or alter Collector ledger semantics. Judge Review
posture meaning remains in `souls/judge.md`. No generic Reviewer/Collector
provider law is introduced (ADR 0011).

## Sealed authority identity

| Artifact | Repository-relative path | SHA-256 of exact bytes |
| --- | --- | --- |
| Authority materials | | |

A digest seals identity only—not truth, acceptance, or freshness.

## Fixed reviewed range

Every finding and disposition in this packet concerns **one immutable range**
and current target facts. A changed target or range requires a **new**
artifact/digest; do not silently mutate this packet.

| Field | Full SHA |
| --- | --- |
| Range base commit | |
| Range target commit | |
| Current target facts bind to | |

## Findings and dispositions

Bind each independent finding to sealed authority, the fixed range above, and
current facts. Every finding needs an explicit disposition.

| Finding ID | Claim | Authority binding | Evidence on current target/range | Disposition | Disposition evidence |
| --- | --- | --- | --- | --- | --- |
| F1 | | | | sustained / rejected / deferred / other | |

## Explicit non-claims

- Filename is not a verdict and does not imply Review convergence.
- This packet defines no required review order, repetition count, or return path
  to any role.
- No routing, next-role, stage machine, or provider-universal protocol arises here.
- No mechanical schema/runtime enforcement is claimed by this template.
