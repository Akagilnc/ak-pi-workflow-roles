# grok-4.6 engine method material

This file is packaged technical material for the `grok-4.6` labor
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
- `--always-approve` (equivalently `--yolo` or `--permission-mode
  bypassPermissions`) keeps the run non-interactive (documented). Headless
  permissions otherwise default to interactive approval, where an `ask`
  decision has no UI to answer; alternatively, use an explicit permission
  setup that auto-approves the required call.
- Official docs list `-p/--single` as the canonical headless prompt input;
  `--prompt-file` exists in the installed CLI (`--help`) and is smoke-verified
  on this host — prefer it for long prompts, fall back to `-p` if absent.
- `--output-format plain` keeps stdout clean for capture and is the only
  format to use for labor. Do not use `streaming-json`: its NDJSON deltas go
  back into the seat's context as noise (see `opus.md` for the measured ratio);
  progress observability belongs to the runner's process watch, not to the
  returned body.
- **Always pass `--reasoning-effort <low|medium|high>`** matching the effort
  tier ordered in the labor mandate (verified live 2026-08-21: flag exists,
  alias `--effort`; a low-tier run completed correctly). If the mandate names
  no tier, use the seat's ordered thinking tier; never omit the flag — the
  CLI default is not guaranteed to match the ordered tier.
- Feeding raw JSON directly through `--prompt-file` is rejected by the CLI as
  non-ACP JSON (`JSON object must have a type field`; live-verified
  2026-08-21).

## MCP host behavior

- Repository MCP entries live under `[mcp_servers.<name>]` in
  `.grok/config.toml`. They take effect only after the folder is trusted; pass
  `--trust` on unattended/headless invocations. Without it, the project server
  may be absent even though the file is present (`live-1787838141494`), and
  `grok mcp doctor` reports `folder untrusted…re-run with --trust`
  (`live-1787838491136`).
- Diagnose server startup with `grok mcp doctor [<server>]`, then inspect
  `~/.grok/logs/mcp/<server>.stderr.log`; Grok truncates that stderr log on
  each stdio server launch.
- MCP tools are exposed to the model as `<server>__<tool>` (for example,
  `ak_489_coder__ak_coder_output`). Use the fully qualified name in prompts;
  a bare tool name relies on the host's loose discovery/matching behavior.
- The headless permission setting described above also covers MCP calls.
- Grok launches a stdio server from the task cwd. Make `command` and `args`
  cwd-independent: use absolute entrypoint paths and do not rely on resolving
  a task-local `node_modules` binary. A cwd-dependent `tsx` launcher failed in
  `live-1787838491136`; the absolute-path form completed the MCP route in
  `live-1787838776163`.
