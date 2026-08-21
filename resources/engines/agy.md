# agy engine method material

This file is packaged method material for the optional `agy` labor engine
(Gemini-family CLI on the host). When a role run selects this engine, read
these bytes and follow the local CLI's actual interface for the labor detour.
Return the labor result to the same role session so typed submission stays on
the existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

## Invocation examples (local agy CLI)

The machine entrypoint is `agy`. Run from the repository root of the role
project (repo root matters for its sandbox). Non-interactive labor uses
sandboxed print mode with the prompt as the positional/print argument and a
log file for diagnostics:

```bash
agy --sandbox --print 'YOUR_LABOR_PROMPT' --log-file /tmp/agy-labor.log
```

- Treat a quota/auth error like any other engine failure (do not retry-loop).

## Failure handling

On any spawn, quota, or model failure, return the soft failure to the session
and continue labor in-seat per ADR 0071 (seat fallback with typed declaration).
