# opencode engine method material

This file is packaged technical material for the `opencode` labor
engine (OpenCode CLI on the host; the GLM cheap-pool leg runs through it).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation examples (local OpenCode CLI)

The machine entrypoint is `opencode`. Run from the role project root.
Non-interactive labor uses `run` with an explicit model:

```bash
opencode run -m opencode-go/glm-5.2 "YOUR_LABOR_PROMPT"
```

- `-m provider/model` selects the model. **Always confirm the current id with
  `opencode models` first** — provider prefixes migrate (verified 2026-08-21:
  GLM lives under `opencode-go/`, e.g. `opencode-go/glm-5.2`; the older
  `zai/glm-5.2` id errors with "Unexpected server error").
- Plain text output only (never `--format json` for labor — the returned body
  goes back into the seat's context); `--auto` auto-approves non-denied
  permissions for unattended runs (per official docs).
- Output goes to stdout; long prompts may be passed via shell heredoc or a
  file read into the argument — follow the installed CLI's actual interface.
