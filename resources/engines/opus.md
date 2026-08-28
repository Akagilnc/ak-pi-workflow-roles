# opus engine method material

This file is packaged technical material for the optional `opus` labor engine
(Claude Code CLI on the host).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation examples (local Claude Code CLI)

The machine entrypoint is `claude`. Run from the role project root. Non-interactive
print mode (`-p` / `--print`) is verified available on this host.

On this host (Claude Code 2.1.233), `--print` with `--output-format=stream-json`
requires `--verbose` — without it the CLI exits immediately with
`Error: When using --print, --output-format=stream-json requires --verbose`.
Include `--verbose` in stream-json argv. Measured with separate fd redirects
(`1>` / `2>`): NDJSON event rows land on stdout (including intermediate
`system` / `assistant` activity and a final `type:"result"` row); stderr is
empty on the success path — except when stdin is an open stream supplying no
data (e.g. a shell test without redirection): then a benign
`Warning: no stdin data received in 3s, proceeding without it` lands on stderr
after a 3-second wait (host-verified 2026-08-28); redirect `< /dev/null` in
shell tests. The packaged detour tool spawns engines with stdin ignored
(`/dev/null`), which avoids this path:

```bash
claude -p --verbose --output-format=stream-json "YOUR_LABOR_PROMPT"
```

Pin the Opus model explicitly (`--model opus` verified accepted on this host;
init event reports `claude-opus-5`):

```bash
claude -p --model opus --verbose --output-format=stream-json "YOUR_LABOR_PROMPT"
```

Use `--output-format=stream-json` (choices measured on this host: `text`, `json`,
`stream-json`) when long labor needs progressive observability while the engine
works; take the labor body from the final `result` event's `result` field,
not from intermediate stream rows.

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
