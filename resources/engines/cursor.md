# cursor engine method material

This file is packaged method material for the optional `cursor` labor engine.
When a role run selects this engine, read these bytes and follow the local CLI's
actual interface for the labor detour. Return the labor result to the same role
session so typed submission stays on the existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

## Invocation examples (local Cursor Agent CLI)

The machine entrypoint is `agent` (also exposed as `cursor-agent`). Run from the
role project root. Non-interactive print mode:

```bash
agent -p --force --output-format text "YOUR_LABOR_PROMPT"
```

Choose a model explicitly when the seat needs a known Cursor model id:

```bash
agent -p --force --model grok-4.5 --output-format text "YOUR_LABOR_PROMPT"
```

Stream JSON events for long labor:

```bash
agent -p --force --output-format stream-json "YOUR_LABOR_PROMPT"
```

Prefer `agent --help` on the host over any remembered flag set. Do not wrap this
engine behind `ak-role` flags.
