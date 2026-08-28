# hermes engine method material

This file is packaged technical material for the optional `hermes` labor
engine (Hermes Agent CLI on the host; current owner directive routes the
free-tier labor leg through it). Sourced from the official CLI reference
(hermes-agent.nousresearch.com/docs/reference/cli-commands, read 2026-08-28)
plus a live smoke on this host.

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation (official one-shot scripting mode)

The machine entrypoint is `hermes`. `-z` is the official pure-scripting mode:
"single prompt in, final response text out, nothing else on stdout or stderr"
— no banner, no spinner, no tool previews. Exit codes: `0` success,
`1` backend/delivery failure, `2` usage errors.

Factory labor line:

```bash
hermes -z "YOUR_LABOR_PROMPT" --in /path/to/project --no-restore-cwd \
  --ignore-rules --usage-file /tmp/hermes-usage.json
```

- `--in DIR` changes directory before start and scopes workspace lookups.
- `--no-restore-cwd` keeps the run from touching the interactive session's
  working-directory state.
- `--ignore-rules` skips the host's personal AGENTS.md/SOUL.md/.cursorrules
  and memory injection — required for factory legs so the owner's personal
  agent identity does not leak into labor output.
- `--usage-file PATH` (works with `-z` only) writes a JSON spend report
  (`estimated_cost_usd`, token counts, model, provider, `completed`/`failed`)
  **even when the run fails** — attach it to the leg's receipt for accounting.
- Long or untrusted prompts: `--query-file PATH` reads the prompt from a file
  verbatim ("nothing is shell-interpreted"); mutually exclusive with `-q`.
- Model/provider default comes from host `~/.hermes/config.yaml`
  (owner-selected; verified 2026-08-28: `poolside/laguna-s-2.1:free` on Nous
  Portal). Override with `-m provider/model` + `--provider` only when the
  dispatch order says so.
- Isolation stronger than `--ignore-rules` exists but has trade-offs:
  `--ignore-user-config` also drops the config-file model default and switches
  credential loading to `.env`; `--safe-mode` additionally disables plugins,
  hooks and MCP. Do not use them for routine labor unless the order says so —
  they can sever the owner-configured model/auth path.
- Do NOT pass `--yolo` (blanket approval bypass) for factory labor;
  permissions stay at the CLI's defaults.
- Debug variant: `hermes chat -q "..."` runs one-shot **with** tool output and
  intermediate steps on stdout (unlike `-z`) — use when a labor run needs its
  steps inspected.

## Smoke test (run before first labor leg of a session)

```bash
hermes -z "Reply with exactly one word: OK" --no-restore-cwd
```

Expected: stdout is exactly `OK`, exit code 0. Verified 2026-08-28 on this
host (model `poolside/laguna-s-2.1:free`, Nous Portal). If it fails, check
`hermes status` (model/provider block) and `~/.hermes/provider_models_cache.json`
for the current catalog; the interactive picker is `hermes model`.
