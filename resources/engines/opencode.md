# opencode engine method material

This file is packaged technical material for the `opencode` labor
engine (OpenCode CLI on the host; the GLM cheap-pool leg runs through it).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation examples (local OpenCode CLI)

The machine entrypoint is `opencode`. Run from the role project root.
Non-interactive labor uses `run` with `--auto`. When the labor order specifies
an engine model, pass it with `-m`:

```bash
opencode run --auto -m <MODEL_ID> "YOUR_LABOR_PROMPT"
```

When no engine model is specified, omit `-m` and let OpenCode choose: it uses
the model configured in OpenCode, then the last-used model, then its internally
prioritized first model.

```bash
opencode run --auto "YOUR_LABOR_PROMPT"
```

- `--auto` is required: it auto-approves permissions that are not explicitly
  denied. Without it, any `ask` permission (e.g. `external_directory` when the
  labor reads the case dossier outside the project root) is auto-rejected in a
  headless `run`, and the engine exits after its opening sentence with no labor
  done (upstream anomalyco/opencode#36413).

- Model id is not pinned by this note; it comes from the dispatch order
  (owner pool directive), passed verbatim as `provider/model`. **Always
  confirm the current id with `opencode models` first** — provider prefixes
  migrate (verified 2026-08-21:
  GLM lives under `opencode-go/`, e.g. `opencode-go/glm-5.2`; the older
  `zai/glm-5.2` id errors with "Unexpected server error").
- Plain text output only (never `--format json` for labor — the returned body
  goes back into the seat's context).
- Output goes to stdout; long prompts may be passed via shell heredoc or a
  file read into the argument — follow the installed CLI's actual interface.
