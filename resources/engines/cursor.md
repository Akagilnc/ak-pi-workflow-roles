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

Run from the role project root. Non-interactive print mode; `-f/--force`
allows command execution headlessly; `-p` prints responses for scripts:

```bash
cursor-agent -p -f --output-format text --model <MODEL_ID> "YOUR_LABOR_PROMPT"
```

- Model ids come from `cursor-agent models`. Effort tiers are encoded in the
  id itself (e.g. `cursor-grok-4.6-low`, `cursor-grok-4.6-medium`,
  `cursor-grok-4.6-high`, plus `-fast` variants); some models also accept a
  bracket override form (`'claude-opus-4-8[context=1m,effort=high]'` — see
  `cursor-agent --help`).
- Owner pool directive 2026-08-28: default labor model = `cursor-grok-4.6-low`.
- Stream JSON events for long labor: `--output-format stream-json`.

Prefer `cursor-agent --help` on the host over any remembered flag set. Do not
wrap this engine behind `ak-role` flags.

## Smoke test (run before first labor leg of a session)

```bash
cursor-agent -p -f --output-format text --model cursor-grok-4.6-low "Reply with exactly one word: OK"
```

Expected: stdout ends with exactly `OK`, exit code 0. Verified 2026-08-28 on
this host (Cursor subscription login). If it asks about directory trust, the
`-f` flag (or `--trust`) is missing.
