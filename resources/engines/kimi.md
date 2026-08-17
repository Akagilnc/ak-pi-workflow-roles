# kimi engine method material

This file is packaged method material for the optional `kimi` labor engine
(Kimi Code CLI on the host). When a role run selects this engine, read these
bytes and follow the local CLI's actual interface for the labor detour. Return
the labor result to the same role session so typed submission stays on the
existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

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
`stream-json`; default is `text`) so the package idle clock can see subprocess
activity while the engine works. Take the labor body from
`{"role":"assistant","content":...}` rows, not from `role:meta` rows:

```bash
kimi -p "YOUR_LABOR_PROMPT" --output-format stream-json
```

Text mode when stream events are not needed (stdout also carries thinking
bullets and a trailing resume hint — strip those before typed submission):

```bash
kimi -p "YOUR_LABOR_PROMPT" --output-format text
```

Prefer `kimi --help` on the host over any remembered flag set. Do not wrap this
engine behind `ak-role` flags.

When the package detour tool is available, start exactly one subprocess per
labor invocation through it with argv assembled from this material and the
local CLI; return the stdout labor content to the same session for the existing
typed submission path. One labor turn = one process (not one process for the
whole role run). If the detour fails, continue labor in-session on the seat main
road and still submit via the existing typed path.
