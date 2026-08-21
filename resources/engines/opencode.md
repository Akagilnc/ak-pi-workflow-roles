# opencode engine method material

This file is packaged method material for the optional `opencode` labor engine
(OpenCode CLI on the host; the GLM cheap-pool leg runs through it). When a role
run selects this engine, read these bytes and follow the local CLI's actual
interface for the labor detour. Return the labor result to the same role session
so typed submission stays on the existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

## Invocation examples (local OpenCode CLI)

The machine entrypoint is `opencode`. Run from the role project root.
Non-interactive labor uses `run` with an explicit model:

```bash
opencode run -m zai/glm-5.2 "YOUR_LABOR_PROMPT"
```

- `-m provider/model` selects the model (e.g. `zai/glm-5.2`); check
  `opencode models` / `opencode --help` on the host for valid ids.
- Output goes to stdout; long prompts may be passed via shell heredoc or a
  file read into the argument — follow the installed CLI's actual interface.

## Failure handling

On any spawn or model failure, return the soft failure to the session and
continue labor in-seat per ADR 0071 (seat fallback with typed declaration).
