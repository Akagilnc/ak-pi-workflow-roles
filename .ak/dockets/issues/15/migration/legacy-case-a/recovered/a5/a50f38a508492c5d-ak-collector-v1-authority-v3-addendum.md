# Collector v1 authority v3 — controlling corrections to v2

This addendum is normative and supersedes conflicting wording in `/tmp/ak-collector-v1-authority-v2.md`. All unmodified v2 clauses remain in force.

## A. Exact GitHub state and evidence-time law

Replace every `windowRelation: within|after` occurrence with:

```text
windowRelation: before | within | after | uncertain
```

Relations are computed per immutable evidence version:

- `before`: authoritative version/event time is earlier than `activationTime`.
- `within`: authoritative version/event time is at or after activation and at or before `deadlineTime`.
- `after`: authoritative version/event time is later than deadline.
- `uncertain`: GitHub exposes no authoritative timestamp proving when the cited version/state/semantics came into existence. Uncertain evidence is preserved but cannot be backdated to establish a by-deadline terminal conclusion.

Pre-activation evidence is eligible: an existing exact-target review may prove `valid` when its evidence relation is `before`, provided the latest final complete snapshot still shows that same qualifying review version/state and target HEAD.

The only accepted `PullRequestReview.state` values for valid completion are exact GitHub states `APPROVED`, `CHANGES_REQUESTED`, or `COMMENTED`. `PENDING`, `DISMISSED`, blank, or unknown states cannot prove valid. Valid also requires expected author, non-empty own `commit_id`, final-snapshot presence, and `commit_id === targetHead`.

Timestamp ownership is exact:

- review completion uses GitHub `submitted_at` for the submitted review event;
- review body/state versions use their authoritative update/state timestamp when GitHub supplies one;
- issue/review/inline comment text versions use GitHub `created_at`/`updated_at` corresponding to that exact content version;
- unavailable semantics use the authoritative timestamp of the immutable text version that first contains the cited terminal statement;
- deletion/dismissal/state changes use the authoritative change timestamp when exposed; otherwise their timing is `uncertain` and latest-snapshot state still controls present eligibility;
- `firstObservedAt` is evidence of observation, never silently substituted for an absent authoritative event/version time.

A record created before deadline but edited after deadline cannot lend its later text to a before/within terminal conclusion. The earlier immutable text version remains independently preserved. Evidence first discovered in the final snapshot may terminate by deadline only when its exact cited version has authoritative `before` or `within` time. `after` and `uncertain` evidence is preserved in reports but cannot replace deadline `missing` when no other eligible terminal fact exists.

Add acceptance cases for: pre-existing exact-head qualifying review; pre-activation review edited after deadline; before-deadline comment edited to terminal unavailable after deadline; and a state/text change whose authoritative version time is absent.

## B. Snapshot-bound PR state

Replace any atomic/live claim about PR closure or merge with:

- the latest successful complete final snapshot is the sole receipt authority for PR state and HEAD;
- if that snapshot observes PR state other than `OPEN`, Collector exits non-zero with no receipt;
- if another read occurs, it becomes the final complete snapshot and every classification/provenance computation must bind to it;
- close/merge or HEAD changes after the final snapshot are outside this receipt, exactly like any later remote mutation.

The receipt claims only: “at `finalObservationTime`, complete snapshot `finalSnapshotId` observed this OPEN PR at `targetHead`.”

## C. Exact one-shot input behavior

On the first supported print/JSON input, runtime replaces the entire user message with one fixed packaged kickoff. It does not append, quote, preserve, or expose caller prose to the model. Target, manifest, method law, and deadline facts come only from validated runtime-owned context.

The supported runner supplies exactly one prompt. If any later input is nevertheless observed, Collector immediately aborts non-zero; it does not promise that a later unannounced prompt could have been rejected before side effects already completed. Startup-detectable mode/input/tool violations fail before activation. Do not inspect argv or add a wrapper solely to claim detection Pi does not expose. Unsupported session/profile flags that cannot be introspected are documented launch preconditions rather than fictional runtime guarantees.

## D. Mechanical repository grammar

The accepted v1 target is the following documented conservative ASCII subset:

```text
owner: ^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$
repo:  ^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$
```

Thus owner length is 1–39 and repo length is 1–100; both begin and end alphanumeric. The input contains exactly one `/`, no whitespace, URL syntax, credential, query, fragment, percent encoding, control/non-ASCII character, `.` segment, or `..` segment. This may reject some GitHub-accepted names; v1 documents that conservative limitation rather than guessing. Canonical receipt identity lowercases both segments.

## E. Self-contained terminating receipt

The successful `ak_collector_output` tool-result details are self-contained. In addition to the v2 metadata/reports/legs/request attempts, they embed:

```text
snapshots[]
evidenceRecords[]
```

Every `finalSnapshotId` and every report/leg/request `evidenceRef` resolves exactly once inside those embedded arrays. Embedded records carry the normalized raw fields, immutable version/content digests, stable GitHub IDs/URLs, timestamps, pagination-completeness metadata, transport/request evidence, and prior substantive versions required to independently verify classifications and evidence preservation after the one-shot process exits.

The invocation ledger is internal construction state only. At output, runtime mechanically materializes the referenced authoritative subset plus all required prior substantive versions into receipt details. No receipt may depend on a process-local file, memory object, or unexplained ID. The existing 8 MiB per-snapshot and 32 MiB per-receipt/invocation hard limits apply to this self-contained materialization; overflow is non-zero with no truncated receipt.
