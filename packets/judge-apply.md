# Apply evidence packet (contributor template)

Repository-contributor template for manually supplied Apply evidence.
Template scope and preservation: [development closure](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/development-closure.md).
Composition: [ADR 0010](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0010-callers-own-role-composition-and-repetition.md).
Adjudication: [Judge Soul](../souls/judge.md).

## Sealed upstream identities

Artifact identity and preservation: [development closure](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/development-closure.md#artifact-preservation-rules).

| Artifact | Repository-relative path | SHA-256 of exact bytes |
| --- | --- | --- |
| Authority materials | | |
| Plan materials | | |

## Target and range identity

| Kind | Full SHA | Meaning |
| --- | --- | --- |
| **Target commit** (required for code/apply facts) | | Complete snapshot under claim |
| **Range base** (only if a range is claimed) | | Base snapshot from which the reviewed delta starts |
| **Range target** (only if a range is claimed) | | Target snapshot at which that delta ends |

Distinguish carefully:

- **path + SHA-256** → exact bytes of a named artifact
- **full target commit SHA** → complete code snapshot under claim
- **full base + target SHAs** → identify only the reviewed delta (not a commit-set membership rule or range syntax)
- **tests / seam / boundary observations** → behavioral evidence

None of these alone proves truth or acceptance.

Adjudication duties: [Judge Soul](../souls/judge.md).

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
