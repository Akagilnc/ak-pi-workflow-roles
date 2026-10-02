# Plan evidence packet (contributor template)

Repository-contributor template for manually supplied Plan evidence.
This packet does not claim construction already happened.
Template scope and preservation: [development closure](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/development-closure.md).
Composition: [ADR 0010](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0010-callers-own-role-composition-and-repetition.md).
Adjudication: [Judge Soul](../souls/judge.md).

## Sealed authority identity

Bind the authority materials this plan consumes. Artifact identity and preservation:
[development closure](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/development-closure.md#artifact-preservation-rules).

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
