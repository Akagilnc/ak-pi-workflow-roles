# sonnet engine method material

This file is packaged technical material for the optional `sonnet` labor engine
(Claude Code CLI on the host, pinned to the Sonnet model).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation

Same host CLI as the `opus` engine: the machine entrypoint is `claude`, and all
CLI mechanics (print mode, `--output-format=stream-json` requiring `--verbose`,
fd layout, result-row extraction) are documented in `../opus.md` — read that
note for them; they are not duplicated here.

The only difference is the model pin:

```bash
claude -p --model sonnet --verbose --output-format=stream-json "YOUR_LABOR_PROMPT"
```

`--model sonnet` is verified accepted on this host (Claude Code 2.1.233); the
stream-json init event reports `claude-sonnet-5` (host-verified 2026-08-28).

Prefer `claude --help` on the host over any remembered flag set. Do not wrap
this engine behind `ak-role` flags.
