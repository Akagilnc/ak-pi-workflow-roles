# opus engine method material

This file is packaged method material for the optional `opus` labor engine
(Claude Code CLI on the host). When a role run selects this engine, read these
bytes and follow the local CLI's actual interface for the labor detour. Return
the labor result to the same role session so typed submission stays on the
existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

## Invocation examples (local Claude Code CLI)

The machine entrypoint is `claude`. Run from the role project root. Non-interactive
print mode (`-p` / `--print`) is verified available on this host:

```bash
claude -p --output-format=stream-json "YOUR_LABOR_PROMPT"
```

Pin the Opus model explicitly (`--model opus` verified accepted on this host):

```bash
claude -p --model opus --output-format=stream-json "YOUR_LABOR_PROMPT"
```

Use `--output-format=stream-json` (verified present on this host) so the package
idle clock can see subprocess activity while the engine works; take the labor body
from the final `result` event, not from intermediate stream rows.

Prefer `claude --help` on the host over any remembered flag set. Do not wrap this
engine behind `ak-role` flags.

When the package detour tool is available, start exactly one subprocess per
labor invocation through it with argv assembled from this material and the
local CLI; return the stdout labor content to the same session for the existing
typed submission path. One labor turn = one process (not one process for the
whole role run). If the detour fails, continue labor in-session on the seat main
road and still submit via the existing typed path.
