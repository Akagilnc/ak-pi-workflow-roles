# Engine labor dispatch (shared across all engines)

This note is the single source for **how labor is dispatched** to any selected
engine. Every per-engine note under `resources/engines/<name>.md` covers only
that engine's CLI technical parameters (executable, flags, output formats,
host-measured constraints); it must not restate or contradict the dispatch
rules here.

Material is data for the model, not a code contract. Do not invent package flags.

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
  seat's context, and one 12-minute Opus labor returned as `stream-json` was
  957k chars and killed the seat (712k-token request, #675, 2026-09-06).
  Progress observability is the runner's job (process watch), not the body's.

- Once an engine is selected, start exactly one subprocess per labor
  invocation by calling that engine's local CLI, with argv assembled from the
  engine note plus these dispatch rules; return the stdout labor content to
  the same role session for the existing typed submission path. Read the
  engine note and invoke the CLI it documents (bash or equivalent is the
  ordinary path; a package detour tool is only another way to reach the same
  CLI when the session already has one).
- One labor turn = one process (not one process for the whole role run).

## Failure handling

Once an engine is selected, invoking that engine CLI is mandatory: you MUST
actually run it. On any spawn, auth, quota, model-id, stream-stall,
connection-drop, or other engine-process failure, return the typed failure and
STOP — the run fails. In-seat labor after an engine-process failure is
FORBIDDEN, and so is skipping the engine CLI to work in-seat. Zero invocations
is a violation, not a fallback. Do not silently swap to another engine id.
