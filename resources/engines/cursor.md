# cursor engine method material

This file is packaged technical material for the `cursor` labor
engine.

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Entrypoint (verified 2026-08-28)

The machine entrypoint is **`cursor-agent`**. Do NOT use the bare `agent`
name on this host: PATH resolves `agent` to the Grok CLI (`~/.grok/bin/agent`
→ grok 1.0.5, a different product billed to grok.com Build) — its flags
differ and it fails labor invocations (`--force` unknown; billing 402 when
the Grok Build balance is exhausted).

## Invocation (local Cursor Agent CLI)

Non-interactive print mode; `-f/--force`
allows command execution headlessly; `-p` prints responses for scripts:

```bash
cursor-agent -p -f --output-format text "YOUR_LABOR_PROMPT"
```

When the dispatch order specifies a model, pass it verbatim via `--model`:

```bash
cursor-agent -p -f --output-format text --model <MODEL_ID> "YOUR_LABOR_PROMPT"
```

- Model ids come from `cursor-agent models`. Effort tiers may be encoded in
  the id; see `cursor-agent --help` for supported model-specific forms.
- This note does not pin a model id. Without one in the dispatch order, omit
  `--model` and let the CLI use its configured default.
- `--output-format text` selects text output; output-selection policy:
  [engine dispatch](../engine-dispatch.md#process-shape).

CLI parameters: `cursor-agent --help`. Invocation boundaries: [engine dispatch](../engine-dispatch.md).
