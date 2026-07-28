# Authority evidence packet (contributor template)

This file is a **repository-contributor template** for a manually supplied
Authority-evidence artifact. The filename identifies an **evidence burden**, not
a verdict, phase flag, transition, or required predecessor/successor.

Selection, composition, and use are **caller-owned** (ADR 0010). This template
does not restate or amend Judge law in `souls/judge.md`. It creates no routing,
next-role, package memory, resume semantics, timeout budget, or trust tier.

## Identity seal

Every supplied artifact is identified by:

| Field | Value |
| --- | --- |
| Repository-relative path | |
| SHA-256 of exact bytes | |

A digest seals **identity only**. It does not prove truth, acceptance, or
freshness. Judge independently checks claims against the supplied current
target. This packet does **not** require Apply-level executable proof.

## Authority items

Record each item the contributor wants examined under the Authority burden.
Do not invent Apply fixtures, blanket `file:line` demands, or implementation
recipes here.

### Clauses

| ID | Clause | Notes |
| --- | --- | --- |
| A1 | | |

### Decisions

| ID | Decision | Owner | Notes |
| --- | --- | --- | --- |
| D1 | | | |

### Counterexamples

| ID | Counterexample | Why it matters |
| --- | --- | --- |
| C1 | | |

### Boundaries

| ID | In-scope / out-of-scope boundary |
| --- | --- |
| B1 | |

### Unresolved owner choices

| ID | Open choice | Options | Blocking? |
| --- | --- | --- | --- |
| U1 | | | |

## Explicit non-claims

- Filename is not a verdict and does not imply convergence.
- Instantiation does not start, order, or require any role call.
- No mechanical schema/runtime enforcement is claimed by this template.
