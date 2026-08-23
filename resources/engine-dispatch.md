# Engine labor dispatch (shared across all engines)

This note is the single source for **how labor is dispatched** to any optional
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

- When the package detour tool is available, start exactly one subprocess per
  labor invocation through it, with argv assembled from the engine note plus
  these dispatch rules; return the stdout labor content to the same role
  session for the existing typed submission path.
- One labor turn = one process (not one process for the whole role run).

## Failure handling

If an attempted detour fails because of spawn, auth, quota, model-id,
stream-stall, connection-drop, or another engine-process failure, continue the
labor in the seat and submit through the existing typed path. The resulting
typed receipt carries the attached `engineLaborFallback` declaration. Do not
silently swap to another engine id.
