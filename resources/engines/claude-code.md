# claude-code engine method material

This file is packaged technical material for labor using the Claude Code CLI
on the host.

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this CLI's technical parameters.

## Invocation examples (local Claude Code CLI)

The machine entrypoint is `claude`.
Non-interactive print mode (`-p` / `--print`) is verified available on this
host.

Print mode with `--output-format text` returns the labor body on stdout;
stderr carries banners only. Measured with separate fd redirects (`1>` / `2>`):

```bash
claude -p --dangerously-skip-permissions --output-format text "YOUR_LABOR_PROMPT"
```

Pass the model requested by the labor mandate through `--model` when one is
specified:

```bash
claude -p --dangerously-skip-permissions --model <MODEL_ID> --output-format text "YOUR_LABOR_PROMPT"
```

`--output-format text` is the default. Output-selection policy is in
[engine dispatch](../engine-dispatch.md#process-shape).
Measured 2026-09-06 on this host: the same one-sentence task returned 382 bytes
as `text` and 45,028 bytes as `stream-json --verbose` (118×); a 12-minute labor
returned 957k chars and killed the seat with a 712k-token request (#675).

## Headless permissions

`--dangerously-skip-permissions` is required in headless labor: the CLI's
permission prompts cannot be answered without a TTY and are auto-denied. In
particular, reading any path outside the project root — such as frozen
attachments under `~/.ak-roles/books/<book>/runs/<run>/attachments/` — is
refused without the flag ("The read was not permitted — I don't have access to
that file outside the current worktree") and succeeds with it (host-verified
2026-08-28).

CLI parameters: `claude --help`. Invocation boundaries: [engine dispatch](../engine-dispatch.md).
