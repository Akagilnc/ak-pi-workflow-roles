# kimi-code engine method material

This file is packaged technical material for labor using the Kimi Code CLI on
the host.

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation examples (local Kimi Code CLI)

The machine entrypoint on this host is installed at `~/.kimi-code/bin/kimi`
(put that directory on PATH, or pass the absolute path as argv[0]).

Non-interactive labor uses `-p` / `--prompt` alone. On this host (kimi 0.36.1),
`-p` cannot be combined with `--yolo` or `--auto` — both are rejected at parse
time with `Cannot combine --prompt with --yolo.` / `... --auto.`. Do not add
those flags to prompt-mode argv:

```bash
kimi -p "YOUR_LABOR_PROMPT"
```

Pass the model requested by the labor mandate through `-m` when one is
specified:

```bash
kimi -m <MODEL_ID> -p "YOUR_LABOR_PROMPT"
```

`--output-format text` is the default. Output-selection policy is in
[engine dispatch](../engine-dispatch.md#process-shape). Measured on this host
with separate fd redirects (`1>` / `2>`): stdout is the labor answer body;
stderr carries the version line, thinking bullets, and the trailing
`To resume this session:` hint. Collect the labor body from stdout only — do
not treat resume lines as same-stream noise to strip from stdout (they are not
on that stream; stripping bullet-shaped lines risks deleting answer content):

```bash
kimi -p "YOUR_LABOR_PROMPT" --output-format text
```

CLI parameters: `kimi --help`. Invocation boundaries: [engine dispatch](../engine-dispatch.md).
