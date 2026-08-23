# agy engine method material

This file is packaged technical material for the optional `agy` labor engine
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
agy --sandbox --print 'YOUR_LABOR_PROMPT' --log-file /tmp/agy-labor.log
```
