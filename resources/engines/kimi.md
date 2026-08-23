# kimi engine method material

This file is packaged technical material for the optional `kimi` labor engine
(Kimi Code CLI on the host).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation examples (local Kimi Code CLI)

The machine entrypoint on this host is installed at `~/.kimi-code/bin/kimi`
(put that directory on PATH, or pass the absolute path as argv[0]). Run from
the role project root.

Non-interactive labor uses `-p` / `--prompt` alone. On this host (kimi 0.36.1),
`-p` cannot be combined with `--yolo` or `--auto` — both are rejected at parse
time with `Cannot combine --prompt with --yolo.` / `... --auto.`. Do not add
those flags to prompt-mode argv:

```bash
kimi -p "YOUR_LABOR_PROMPT"
```

Pin a model alias configured in the host `config.toml` when the seat needs a
known Kimi model id (example alias shape measured: `kimi-code/k3-256k`):

```bash
kimi -m <model-alias> -p "YOUR_LABOR_PROMPT"
```

Use `--output-format stream-json` (choices measured on this host: `text`,
`stream-json`; default is `text`) when long labor needs progressive observability
while the engine works. Take the labor body from
`{"role":"assistant","content":...}` rows, not from `role:meta` rows:

```bash
kimi -p "YOUR_LABOR_PROMPT" --output-format stream-json
```

Text / default mode when stream events are not needed. Measured on this host
with separate fd redirects (`1>` / `2>`): stdout is the labor answer body;
stderr carries the version line, thinking bullets, and the trailing
`To resume this session:` hint. Collect the labor body from stdout only — do
not treat resume lines as same-stream noise to strip from stdout (they are not
on that stream; stripping bullet-shaped lines risks deleting answer content):

```bash
kimi -p "YOUR_LABOR_PROMPT" --output-format text
```

Prefer `kimi --help` on the host over any remembered flag set. Do not wrap this
engine behind `ak-role` flags.
