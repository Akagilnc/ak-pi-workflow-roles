# grok-4.6 engine method material

This file is packaged technical material for the optional `grok-4.6` labor
engine (Grok CLI on the host).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation examples (local Grok CLI)

The machine entrypoint is `grok` (NOT `grok-4.6` — the engine name is the model
id, not the executable). Run from the role project root. Non-interactive labor
reads the prompt from a file and prints plain output:

```bash
grok --prompt-file /path/to/labor-prompt.md -m grok-4.6 --always-approve --output-format plain
```

- `-m grok-4.6` selects the model; `grok models` lists valid ids (currently
  `grok-4.6` default, `grok-4.5`).
- `--always-approve` keeps the run non-interactive (documented).
- Official docs list `-p/--single` as the canonical headless prompt input;
  `--prompt-file` exists in the installed CLI (`--help`) and is smoke-verified
  on this host — prefer it for long prompts, fall back to `-p` if absent.
- `--output-format plain` keeps stdout clean for capture — but it stays
  silent until the run finishes. **For labor longer than ~2 minutes use
  `--output-format streaming-json` instead**: it emits NDJSON events
  (thought/text deltas) continuously from the first second, so long runs stay
  observable instead of appearing hung. Reconstruct the final answer by
  concatenating each NDJSON object's `data` where `type == "text"`, in stream
  order; `type == "end"` (stopReason end_turn) marks completion. Do not treat
  `thought` events as the answer (live-verified stream shape 2026-08-21).
- **Always pass `--reasoning-effort <low|medium|high>`** matching the effort
  tier ordered in the labor mandate (verified live 2026-08-21: flag exists,
  alias `--effort`; a low-tier run completed correctly). If the mandate names
  no tier, use the seat's ordered thinking tier; never omit the flag — the
  CLI default is not guaranteed to match the ordered tier.
- Feeding raw JSON directly through `--prompt-file` is rejected by the CLI as
  non-ACP JSON (`JSON object must have a type field`; live-verified
  2026-08-21).
