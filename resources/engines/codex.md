# codex engine method material

This file is packaged method material for the optional `codex` labor engine
(Codex CLI on the host). When a role run selects this engine, read these
bytes and follow the local CLI's actual interface for the labor detour. Return
the labor result to the same role session so typed submission stays on the
existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

## Invocation examples (local Codex CLI)

The machine entrypoint is `codex`. Run from the role project root. Non-interactive
labor uses `codex exec` (alias `e`). Always pass `--skip-git-repo-check` so the
labor subprocess can start outside a Git work tree when needed:

```bash
codex exec --skip-git-repo-check "YOUR_LABOR_PROMPT"
```

For concurrent or disposable labor turns, add `--ephemeral` so session files are
not persisted to disk:

```bash
codex exec --skip-git-repo-check --ephemeral "YOUR_LABOR_PROMPT"
```

Working-root override when the seat cwd is not the project root:

```bash
codex exec --skip-git-repo-check --ephemeral -C "$PROJECT_ROOT" "YOUR_LABOR_PROMPT"
```

Default (non-`--json`) mode prints the session banner and progress on stderr
(measured on this host). Collect the labor body from stdout so that stderr log
noise is not mixed into the returned body; the package idle clock can still see
activity on both streams. Use `--json` only when the seat itself needs
machine-readable event rows (those rows land on stdout as JSONL; measured event
types include `thread.started`, `turn.started`, `item.completed`, `error`,
`turn.failed`):

```bash
codex exec --skip-git-repo-check --ephemeral --json "YOUR_LABOR_PROMPT"
```

Prefer `codex exec --help` on the host over any remembered flag set. Do not wrap
this engine behind `ak-role` flags. Later host quota/auth failures are separate
from argv acceptance — re-check the local CLI if a turn fails after session start.

When the package detour tool is available, start exactly one subprocess per
labor invocation through it with argv assembled from this material and the
local CLI; return the stdout labor content to the same session for the existing
typed submission path. One labor turn = one process (not one process for the
whole role run). If the detour fails, continue labor in-session on the seat main
road and still submit via the existing typed path.
