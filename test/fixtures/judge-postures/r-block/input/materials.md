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
Stop cross-leg request evidence from contaminating a leg that has no local
request or recovery evidence.

Owner:
Collector receipt attempt-to-leg evidence join.

Scope:
Do not change request markers, terminal statuses, or the public receipt
envelope.

## Notes from the author

Implementation will add tests and adjust the join. Exact helper names, fixture
object shapes, and library call details are still open and will be chosen
during construction inside the owning seam.

Governing adjudication law for this case is the package-bundled Judge Soul at
`souls/judge.md` in the current repository checkout. Read that file in full
before issuing a verdict.
