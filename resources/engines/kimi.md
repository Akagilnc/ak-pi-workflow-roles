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
the role project root. Non-interactive prompt mode (`-p` / `--prompt`) is
verified available:

```bash
kimi --yolo -p "YOUR_LABOR_PROMPT"
```

Pin a model alias when the seat needs a known Kimi model id:

```bash
kimi --yolo -m <model-alias> -p "YOUR_LABOR_PROMPT"
```

Use `--output-format stream-json` (verified present on this host) so the package
idle clock can see subprocess activity while the engine works; take the labor body
from the final result event, not from intermediate stream rows:

```bash
kimi --yolo --output-format stream-json -p "YOUR_LABOR_PROMPT"
```

Text mode when stream events are not needed:

```bash
kimi --yolo --output-format text -p "YOUR_LABOR_PROMPT"
```

Prefer `kimi --help` on the host over any remembered flag set. Do not wrap this
engine behind `ak-role` flags.

When the package detour tool is available, start exactly one subprocess per
labor invocation through it with argv assembled from this material and the
local CLI; return the stdout labor content to the same session for the existing
typed submission path. One labor turn = one process (not one process for the
whole role run). If the detour fails, continue labor in-session on the seat main
road and still submit via the existing typed path.
