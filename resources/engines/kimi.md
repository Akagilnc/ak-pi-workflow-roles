# kimi engine method material

This file is packaged method material for the optional `kimi` labor engine.
When a role run selects this engine, read these bytes and follow the local CLI's
actual interface for the labor detour. Return the labor result to the same role
session so typed submission stays on the existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

## Invocation examples (local Kimi Code CLI)

One-shot non-interactive prompt from the role project root:

```bash
kimi --yolo -p "YOUR_LABOR_PROMPT"
```

Pin a model alias when needed:

```bash
kimi --yolo -m <model-alias> -p "YOUR_LABOR_PROMPT"
```

Machine-readable prompt mode:

```bash
kimi --yolo --output-format text -p "YOUR_LABOR_PROMPT"
```

Prefer `kimi --help` on the host over any remembered flag set. Do not wrap this
engine behind `ak-role` flags.

When the package detour tool is available, start exactly one subprocess through
it with argv assembled from this material and the local CLI; return the stdout
labor content to the same session for the existing typed submission path.
