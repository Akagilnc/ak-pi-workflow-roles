# hermes engine method material

This file is packaged technical material for the optional `hermes` labor
engine (Hermes Agent CLI on the host; current owner directive routes the
free-tier labor leg through it).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation examples (local Hermes CLI)

The machine entrypoint is `hermes`. Non-interactive labor uses `-z` with the
project directory pinned:

```bash
hermes -z "YOUR_LABOR_PROMPT" --in /path/to/project --no-restore-cwd
```

- The default model/provider comes from the host `~/.hermes/config.yaml`
  (owner-selected; verified 2026-08-28: `poolside/laguna-s-2.1:free` on Nous
  Portal). Override explicitly with `-m provider/model` plus `--provider` only
  when the dispatch order says so.
- `--no-restore-cwd` keeps the run from touching the interactive session's
  working-directory state.
- Do NOT pass `--yolo` (blanket auto-approval) for factory labor; permissions
  stay at the CLI's defaults.
- Output goes to stdout. Long prompts may be passed via a file read into the
  argument — follow the installed CLI's actual interface.
- The host CLI is feature-rich (proxy, gateway, cron, ...); labor legs use
  only the one-shot `-z` form above. Model catalog inspection:
  `hermes model` (interactive picker) or `~/.hermes/provider_models_cache.json`.
