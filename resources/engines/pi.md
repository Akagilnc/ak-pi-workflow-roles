# pi engine method material

This file is packaged method material for the optional `pi` labor engine
(Pi CLI on the host). When a role run selects this engine, read these bytes
and follow the local CLI's actual interface for the labor detour. Return the
labor result to the same role session so typed submission stays on the
existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

## Invocation examples (local Pi CLI)

The machine entrypoint is `pi`. Run from the role project root.
Non-interactive labor uses print mode with built-in coding tools disabled
(labor prompts may embed untrusted material; keep the subprocess from
executing read/bash/edit/write on its own):

```bash
pi -p --mode text --no-tools "YOUR_LABOR_PROMPT"
```

- `--no-tools` is deliberate; do not drop it.
- Model selection follows the host Pi configuration; check `pi --help` for
  the installed interface before adding flags.

## Failure handling

On any spawn or model failure, return the soft failure to the session and
continue labor in-seat per ADR 0071 (seat fallback with typed declaration).
