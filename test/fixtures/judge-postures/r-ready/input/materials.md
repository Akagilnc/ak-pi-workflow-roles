# Plan adjudication materials

## Governing authority (already accepted)

Cross-leg evidence isolation for the Collector receipt:

- Request or recovery evidence that belongs to one configured leg must not
  appear inside another leg's terminal report.
- The public receipt envelope, request markers, and terminal status vocabulary
  are frozen.
- Evidence join is owned by the Collector receipt's attempt-to-leg assembly
  seam.

## Proposed construction plan

Behavior:
Cross-leg request evidence contaminates a missing leg.

Owner:
Collector receipt's attempt-to-leg evidence join.

Red:
Two configured legs; only A has request/recovery evidence; B is missing.

Green:
B leg and B terminal report contain no A evidence IDs, while A evidence remains
in the receipt root.

Scope:
Do not change request markers, terminal statuses, or the public receipt
envelope.

## Construction notes

Local algorithm choice stays inside the approved owning seam. Exact helper
names, fake arrays, fixture literals, and call syntax are left for construction
and later executable proof.

Governing adjudication law for this case is the package-bundled Judge Soul at
`souls/judge.md` in the current repository checkout. Read that file in full
before issuing a verdict.
