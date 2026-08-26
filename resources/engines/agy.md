# agy engine method material

This file is packaged technical material for the optional `agy` labor engine
(Gemini-family CLI on the host).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation examples (local agy CLI)

The machine entrypoint is `agy`. Run from the repository root of the role
project (repo root matters for its sandbox). Non-interactive labor uses
sandboxed print mode with the prompt as the positional/print argument and a
log file for diagnostics:

```bash
agy --sandbox --print 'YOUR_LABOR_PROMPT' --log-file /tmp/agy-labor.log
```

## Model selection

Pin the model per invocation with `--model <id>`; without it the CLI uses its
own session default. List installed ids with `agy models`. Examples observed on
this host (2026-08-26): `gemini-3.7-flash-high`, `gemini-3.7-flash-medium`,
`gemini-3.7-flash-low`, and 3.6 equivalents.

```bash
agy --sandbox --model gemini-3.7-flash-high --print 'YOUR_LABOR_PROMPT' --log-file /tmp/agy-labor.log
```

When the dispatch order names a model, pass it verbatim via `--model`; an
unknown model id is an engine-process failure (typed failure, stop — per
`../engine-dispatch.md`).
