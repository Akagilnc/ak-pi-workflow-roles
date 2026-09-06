# codex engine method material

This file is packaged technical material for the `codex` labor engine
(Codex CLI on the host).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

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
noise is not mixed into the returned body. Never use `--json` for labor: its
JSONL event rows go back into the seat's context as noise (see `opus.md` for the
measured ratio).

Prefer `codex exec --help` on the host over any remembered flag set. Do not wrap
this engine behind `ak-role` flags.
