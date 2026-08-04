# Submission-case evidence template (contributor template)

This file is a **repository-contributor template** for the evidence record of a
manually supplied Submission case (ticket face / plan / disposition ledger /
constitutional review). The submission-case duty law is solely in
`souls/judge.md`; this file supplies its evidence-record format.

Selection, composition, and use are **caller-owned** (ADR 0010). This template
creates no routing, topology, role-order, or package memory.

## Identity seal

| Field | Value |
| --- | --- |
| Case (issue / face / ledger) reference | |

| Artifact | Repository-relative path | SHA-256 of exact bytes |
| --- | --- | --- |
| Dispatch prompt | | |
| Packet | | |

## Item-level dispositions

Record each content item inside the dispatch prompt and inside the packet as a
separate row. “Item” includes claims, dispositions, checklists, acceptance
criteria, dispatch wording, and packet internals; it does not mean the prompt or
packet as one whole artifact.

| Item | Disposition (retain / reject / needs-evidence) | Ratified-law basis (Judge Soul) |
| --- | --- | --- |
| | | |

## Sampled re-derivation record

| Sample | Law source | Primary evidence (file:line / command) | Independently re-derived disposition | Direction (误删 / 该删未删) |
| --- | --- | --- | --- | --- |
| | Judge Soul | | | 误删 |
| | Judge Soul | | | 该删未删 |
