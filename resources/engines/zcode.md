# zcode engine method material

This file is packaged technical material for the `zcode` labor engine
(Z.AI ZCode agent runtime on the host, GLM Coding Plan models).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Invocation (host-verified 2026-08-29)

The machine entrypoint is `zcode` (npm `zcode-app-cli`, wraps the official
ZCode runtime; host has 3.10.1-17 / runtime 0.16.5). Non-interactive labor:

```bash
zcode --prompt 'YOUR_LABOR_PROMPT' --cwd /path/to/worktree
```

`--prompt` defaults to permission mode `yolo` (no TTY permission stalls).
Useful extras measured from `zcode --help`: `--attach <path>` (repeatable),
`--mode build|edit|plan|yolo`, `--resume <sess_...>`. Never `--json` for
labor (the returned body goes back into the seat's context as plain text). The
headless CLI help exposes no per-invocation model flag; do not translate a
requested model into a config edit or invent a CLI flag. Report that capability
gap through the existing path. Prefer `zcode --help` on the host over any
remembered flag set.

## Historical realm and model observations (host-verified 2026-08-29)

These are dated observations, not model or dispatch recommendations. Model
choice remains with the dispatch order; this note does not prescribe a model.

- Missing `~/.zcode/cli/config.json` → hard error `Model config is missing`.
  The desktop app's login is NOT shared with the CLI.
- `zcode login` signs into the **overseas Z.AI realm only**. An account on the
  mainland BigModel realm then fails with
  `[1113][Insufficient balance or no resource package]`.
- At that time, the scaffolded config defaulted `model.main` to `zai/glm-5.2`,
  which was not included in the coding plan and returned the same 1113 failure.
- A mainland configuration using the Anthropic-compatible endpoint and
  `zai/glm-5.3` / `zai/glm-5.3-flash` returned normally with the tested key at
  that time. This is a historical result, not a suggested fixed configuration.

## Quota facts (owner-provided, 2026-08-28)

Plan quotas are daily and per-model (GLM-5.3 3M/day, Flash 5M/day on the
current plan; a weekend event granted a larger temporary pool). Whether cached
tokens count toward quota is unverified.

## Historical funding observations (host-verified 2026-08-29)

The "working" configuration above drew from a new-user gift resource package
(2M general-model tokens), not from any plan. Once that package expired,
glm-5.3-flash returns `1113` (insufficient balance) with the same key on BOTH
the anthropic endpoint and the coding endpoint
(`open.bigmodel.cn/api/coding/paas/v4`, HTTP 429 + code 1113, probed with a
minimal request). The ZCode Start/Weekend plan quotas are bound to the desktop
app's OAuth connection ("Start Plan" connection mode); the CLI's
`/login bigmodel-coding-plan` OAuth variant hard-fails with
`BigModel OAuth appSecret is required.` (the client secret ships only inside
the desktop app; no env override exists — only `BIGMODEL_*_API_BASE_URL`).
The plan page issues exactly one API key and it is the key tested above.

The later tests found that the tested key had no funded model after the gift
resource package expired. Current funding and model availability were not
established by those tests; report an actual invocation failure through the
existing path and leave any seat change to the caller.
