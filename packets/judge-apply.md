# Apply evidence packet (contributor template)

This file is a **repository-contributor template** for a manually supplied Apply
(executable-proof) artifact. The filename identifies an **evidence burden**, not
a verdict, phase flag, transition, or required predecessor/successor.

Selection, composition, and use are **caller-owned** (ADR 0010). Apply posture
semantics remain solely in `souls/judge.md`. Git commit identity owns the code
snapshot and any reviewed range. This template creates no receipt envelope,
audit, runtime enforcement, trust tier, production hook, or package surface.

## Sealed upstream identities

Digests seal **artifact-byte identity only**. They do not prove truth,
acceptance, or freshness.

| Artifact | Repository-relative path | SHA-256 of exact bytes |
| --- | --- | --- |
| Authority materials | | |
| Plan materials | | |

## Target and range identity

| Kind | Full SHA | Meaning |
| --- | --- | --- |
| **Target commit** (required for code/apply facts) | | Complete code state under claim |
| **Range base** (only if a range is claimed) | | Inclusive-exclusive base of reviewed delta |
| **Range target** (only if a range is claimed) | | Target tip of reviewed delta |

Distinguish carefully:

- **path + SHA-256** → exact bytes of a named artifact
- **full target commit SHA** → complete code snapshot
- **full base + target SHAs** → reviewed delta only
- **tests / seam / boundary observations** → behavioral evidence

None of these alone proves truth or acceptance.

## Construction evidence

### Live code and tests

| Claim | Evidence (path, command, or observation) | Binds to target SHA? |
| --- | --- | --- |
| | | yes/no |

Use `file:line` **only where applicable** to a concrete claim. Do not invent
blanket line citations.

### Real production-seam evidence

| Seam / module owner | How the claim crosses the real seam | Result |
| --- | --- | --- |
| | | |

### Boundary evidence

| Boundary condition | How it was actually reached | Result |
| --- | --- | --- |
| | | |

### Guardrail triad (only when adding or approving a guardrail)

Complete this section **only** if the change adds or approves a guardrail;
otherwise record `N/A — no guardrail added or approved` with disposition.

| Question | Answer |
| --- | --- |
| 1. Which real, reproducible failure proves this guardrail is needed? | |
| 2. Which seam owns the invariant it protects? | |
| 3. Why is deleting or simplifying the root cause insufficient for this failure class? | |

## Explicit non-claims

- Filename is not a verdict and does not imply Apply convergence.
- This template does not define or alter role receipts, Soul audit, or runtime gates.
- Instantiation does not route work to any role or require a successor packet.
