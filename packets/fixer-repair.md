# Repair request packet (contributor template)

This file is a **repository-contributor template** for a manually supplied
forward repair-request artifact. The filename identifies an **evidence
burden**, not a verdict, phase flag, transition, or required
predecessor/successor.

Selection, composition, and use are **caller-owned** (ADR 0010). This template
owns only the contributor-facing repair request shape. It must **not** claim
Judge origin, Fixer destination, return-to-Judge flow, mechanical enforcement,
Soul-compliance audit, receipt-envelope enforcement, or a cross-role ledger.

Current Fixer public output remains the thin contract in `src/worker-role.ts`:
`status`, free-form Markdown `report`, and optional `commitSha`. Mechanical
Fixer receipt enforcement of an `R#` ledger requires **separate authority** that
explicitly changes that public contract.

## Identity seal

This packet’s repository-relative path and exact-byte SHA-256 belong in the
**external contributor trail**, not inside the packet bytes (a self-digest
cannot seal the bytes that contain it).

| Field | Value |
| --- | --- |
| Related authority materials (path + SHA-256), if any | |
| Related plan / prior artifacts (path + SHA-256), if any | |

In-packet path + SHA-256 entries identify separately sealed related artifacts
only. A digest seals identity only—not truth, acceptance, or freshness.

## Repair scope

### In scope (exact mandated set)

Enumerate every mandated counterexample, row, oracle, or repair item with a
stable unique ID. **No mandated item may arrive only as prose outside this
set.** IDs must be unique; the set is exact.

| R# | Mandated item | Observable acceptance signal |
| --- | --- | --- |
| R1 | | |
| R2 | | |

### Out of scope / preserved non-goals

| ID | Non-goal / must not change |
| --- | --- |
| N1 | |

## Requested report shape (manual)

When a worker responds, request one keyed data line per packet `R#`. Each exact
packet key must occur exactly once at the start of a keyed data line and carry a
nonblank disposition. Example shape (headings optional and non-normative):

```text
R1 <nonblank disposition>
R2 <nonblank disposition>
```

### Manual exact-set reconciliation (required before trail acceptance)

Before accepting a response into **this repository’s** development trail, a
maintainer **manually** verifies:

1. the response key set exactly equals the packet’s unique `R1..Rn` set;
2. each exact packet `R#` occurs exactly once at the start of a keyed data line;
3. each keyed disposition is nonblank;
4. missing, duplicate, or extra keys fail reconciliation.

Headings and header spelling are ignored and are not evidence. No per-item
wording grammar is required beyond a nonblank disposition.

Acceptance or rejection of that reconciliation is recorded **externally** in the
contributor trail (see `docs/development-closure.md`). This template does **not**
claim runtime, schema, Soul-audit, or receipt-gate enforcement of the ledger.

## Forward-only amendment

Replacing or amending this repair request is a **forward** commit with a new
digest and an explicit disposition of the prior artifact bytes. Do not overwrite
history in place.

## Explicit non-claims

- Filename is not a verdict and does not imply any role must run next.
- This packet did not necessarily come from Judge and need not go to Fixer.
- No return-to-Judge, orchestration, or stage-machine obligation is created.
- Approximate-delivery bounce at a mechanical gate is **out of scope** here.
