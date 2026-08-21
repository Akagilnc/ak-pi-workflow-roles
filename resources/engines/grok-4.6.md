# grok-4.6 engine method material

This file is packaged method material for the optional `grok-4.6` labor engine
(Grok CLI on the host). When a role run selects this engine, read these bytes
and follow the local CLI's actual interface for the labor detour. Return the
labor result to the same role session so typed submission stays on the
existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

## Invocation examples (local Grok CLI)

The machine entrypoint is `grok` (NOT `grok-4.6` — the engine name is the model
id, not the executable). Run from the role project root. Non-interactive labor
reads the prompt from a file and prints plain output:

```bash
grok --prompt-file /path/to/labor-prompt.md -m grok-4.6 --always-approve --output-format plain
```

- `-m grok-4.6` selects the model; `grok models` lists valid ids (currently
  `grok-4.6` default, `grok-4.5`).
- `--always-approve` keeps the run non-interactive.
- `--output-format plain` keeps stdout clean for capture.
- Reasoning effort follows the host CLI defaults; grok effort tiers are
  low/med/high when a flag is exposed by the installed CLI version — check
  `grok --help` and follow the actual interface. Do not invent flags.

## Failure handling

On any spawn or model-id failure, return the soft failure to the session and
continue labor in-seat per ADR 0071 (seat fallback with typed declaration).
