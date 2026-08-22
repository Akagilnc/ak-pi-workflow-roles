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
opencode run -m opencode-go/glm-5.2 "YOUR_LABOR_PROMPT"
```

- `-m provider/model` selects the model. **Always confirm the current id with
  `opencode models` first** — provider prefixes migrate (verified 2026-08-21:
  GLM lives under `opencode-go/`, e.g. `opencode-go/glm-5.2`; the older
  `zai/glm-5.2` id errors with "Unexpected server error").
- `--format json` gives structured output; `--auto` auto-approves non-denied
  permissions for unattended runs (both per official docs).
- Output goes to stdout; long prompts may be passed via shell heredoc or a
  file read into the argument — follow the installed CLI's actual interface.

## Failure handling

The detour is mandatory: you MUST actually invoke the CLI. On any spawn,
quota, or model failure, return the typed failure and STOP — the run fails.
In-seat labor after a detour failure is FORBIDDEN, and so is skipping the
detour to work in-seat. Zero invocations is a violation, not a fallback.
Do not silently swap to another engine id.
