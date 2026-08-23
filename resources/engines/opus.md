# opus engine method material

This file is packaged method material for the optional `opus` labor engine
(Claude Code CLI on the host). When a role run selects this engine, read these
bytes and follow the local CLI's actual interface for the labor detour. Return
the labor result to the same role session so typed submission stays on the
existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

Dispatch rules — what may go into the labor prompt, process shape, and failure
handling — are shared across all engines in `resources/engine-dispatch.md`;
read those bytes too and follow them. This note only covers this engine's CLI
technical parameters.

## Invocation examples (local Claude Code CLI)

The machine entrypoint is `claude`. Run from the role project root. Non-interactive
print mode (`-p` / `--print`) is verified available on this host.

On this host (Claude Code 2.1.233), `--print` with `--output-format=stream-json`
requires `--verbose` — without it the CLI exits immediately with
`Error: When using --print, --output-format=stream-json requires --verbose`.
Include `--verbose` in stream-json argv. Measured with separate fd redirects
(`1>` / `2>`): NDJSON event rows land on stdout (including intermediate
`system` / `assistant` activity and a final `type:"result"` row); stderr is
empty on the success path:

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

Prefer `claude --help` on the host over any remembered flag set. Do not wrap this
engine behind `ak-role` flags.
