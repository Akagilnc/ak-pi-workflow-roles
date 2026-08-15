# codex engine method material

This file is packaged method material for the optional `codex` labor engine.
When a role run selects this engine, read these bytes and follow the local CLI's
actual interface for the labor detour. Return the labor result to the same role
session so typed submission stays on the existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

## Invocation examples (local Codex CLI)

Non-interactive labor prompt (working root = role project):

```bash
codex exec -C "$PROJECT_ROOT" "YOUR_LABOR_PROMPT"
```

Write the last agent message to a file, then bring that text back into the role
session:

```bash
codex exec -C "$PROJECT_ROOT" -o /tmp/codex-labor-last.txt "YOUR_LABOR_PROMPT"
```

JSON event stream when the host needs machine-readable progress:

```bash
codex exec --json -C "$PROJECT_ROOT" "YOUR_LABOR_PROMPT"
```

Prefer the installed `codex` binary's own `--help` / `codex exec --help` over
any remembered flag set. Do not wrap this engine behind `ak-role` flags.
