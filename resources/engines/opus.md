# opus engine method material

This file is packaged technical material for the `opus` labor engine
(Claude Code CLI on the host).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation examples (local Claude Code CLI)

The machine entrypoint is `claude`. Run from the role project root. Non-interactive
print mode (`-p` / `--print`) is verified available on this host.

Print mode (`-p`) with `--output-format text` returns the labor body on stdout;
stderr carries banners only. Measured with separate fd redirects (`1>` / `2>`).

```bash
claude -p --output-format text "YOUR_LABOR_PROMPT"
```

Pin the Opus model explicitly (`--model opus` verified accepted on this host;
init event reports `claude-opus-5`):

```bash
claude -p --model opus --output-format text "YOUR_LABOR_PROMPT"
```

Use `--output-format text` (the default): stdout is the labor body and nothing
else. Never use `--output-format=stream-json` / `--verbose` for labor — the
returned body goes back into the seat's context, and the event stream is noise:
measured 2026-09-06 on this host, the same one-sentence task returned 382 bytes
as `text` and 45,028 bytes as `stream-json --verbose` (118×); a 12-minute labor
returned 957k chars and killed the seat with a 712k-token request (#675). Progress observability belongs to the runner's
process watch, not to the returned body.

## Headless permissions

`--dangerously-skip-permissions` is required in headless labor: the CLI's
permission prompts cannot be answered without a TTY and are auto-denied. In
particular, reading any path outside the project root — such as frozen
attachments under `~/.ak-roles/books/<book>/runs/<run>/attachments/` — is
refused without the flag ("The read was not permitted — I don't have access to
that file outside the current worktree") and succeeds with it (host-verified
2026-08-28, both directions).

Prefer `claude --help` on the host over any remembered flag set. Do not wrap this
engine behind `ak-role` flags.
