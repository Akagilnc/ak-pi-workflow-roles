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
claude -p "YOUR_LABOR_PROMPT"
```

Pin the Opus model explicitly (`--model opus` verified accepted on this host):

```bash
claude -p --model opus "YOUR_LABOR_PROMPT"
```

Prefer `claude --help` on the host over any remembered flag set. Do not wrap this
engine behind `ak-role` flags.

When the package detour tool is available, start exactly one subprocess through
it with argv assembled from this material and the local CLI; return the stdout
labor content to the same session for the existing typed submission path.
