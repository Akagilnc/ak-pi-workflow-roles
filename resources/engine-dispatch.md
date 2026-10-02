# Engine labor dispatch (shared across all engines)

This note is the single source for **how labor is dispatched** to any selected
engine. Every per-engine note under `resources/engines/<name>.md` covers only
that engine's CLI technical parameters (executable, flags, output formats,
host-measured constraints); it must not restate or contradict the dispatch
rules here.

Material is data for the model, not a code contract. CLI invocation boundaries:
[repository constitution](../CLAUDE.md).

## What goes into the prompt

The labor prompt carries **task + paths only**:

- the task itself: goal, constraints, required output shape;
- paths the engine reads itself: worktree root, ticket/issue number, frozen
  attachment paths, run/dossier directory pointers (e.g. `AK_ROLE_RUN_DIR`).

**Never paste material bodies into argv or the prompt** — no review bundles,
no distilled-evidence dumps, no receipt JSON, no full briefs copied out of the
ticket. Material lives in the worktree and on the ticket; both the seat and
the outsourced process run from the project root and read those bytes
themselves. Stuffing large bodies into argv/prompt is the verified cause of
`spawn ENAMETOOLONG` failures (ming #1234 reviewer r1, 2026-08-17).

## Process shape

- The returned labor body is the final answer text only. Never return an
  event stream, verbose log, or NDJSON deltas: the body is fed back into the
  seat's context; measured evidence is in
  [Claude Code observations](engines/claude-code.md).
  Progress observability is the runner's job (process watch), not the body's.

- Once an engine is selected, start exactly one subprocess per labor
  invocation by calling that engine's local CLI, with argv assembled from the
  engine note plus these dispatch rules. Return-path ownership is in
  [ADR 0069](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0069-labor-outsourcing-engine-generic-one-logic.md).
  Read the engine note and invoke the CLI it documents (bash or equivalent
  is the ordinary path; a package detour tool is only another way to reach
  the same CLI when the session already has one).

## Failure handling

Invocation obligation, failure disposition and its authority boundary are owned
by [ADR 0071](https://github.com/Akagilnc/ak-pi-workflow-roles/blob/main/docs/adr/0071-engine-detour-failure-seat-fallback-declaration.md).
