# agy engine method material

This file is packaged technical material for the `agy` labor engine
(Gemini-family CLI on the host).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation examples (local agy CLI)

The machine entrypoint is `agy`. Run from the repository root of the role
project (repo root matters for its sandbox). Non-interactive labor uses
sandboxed print mode with the prompt as the positional/print argument and a
log file for diagnostics:

```bash
agy --sandbox --dangerously-skip-permissions --print-timeout 30m --print 'YOUR_LABOR_PROMPT' --log-file /tmp/agy-labor.log
```

`--dangerously-skip-permissions` is required in headless labor: the CLI's
permission prompts cannot be answered without a TTY and are auto-denied,
which yields "no output produced" (host-verified 2026-08-26, run
01a03d96-3897@judge). The sandbox stays on and provides the containment.

## Model selection

Do not pin `--model` unless the dispatch order (owner pool directive) names a
model. Without `--model` the CLI uses its own session default, which is the
current Gemini Flash release — that default is the owner's standing choice.
List the ids this host offers with `agy models` when an order names one.

```bash
agy --sandbox --dangerously-skip-permissions --print-timeout 30m --print 'YOUR_LABOR_PROMPT' --log-file /tmp/agy-labor.log
```

When the dispatch order names a model, pass it verbatim via `--model`; an
unknown model id is an engine-process failure (typed failure, stop — per
`../engine-dispatch.md`). Never copy a model id from this note or from a
previous run — ids here would go stale.

## Print-mode timeout

`--print-timeout` defaults to 5m0s — too short for labor turns; a full apply
labor exceeded it (host-verified 2026-08-26, run 01a03dae-5635@coder,
"timeout waiting for response"). Labor invocations pass `--print-timeout 30m`.
A timeout that still fires is an engine-process failure: typed failure and
STOP per `../engine-dispatch.md`.
