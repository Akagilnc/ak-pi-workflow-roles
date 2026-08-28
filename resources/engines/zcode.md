# zcode engine method material

This file is packaged technical material for the optional `zcode` labor engine
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
`--mode build|edit|plan|yolo`, `--resume <sess_...>`, `--json` where
supported. Prefer `zcode --help` on the host over any remembered flag set.

## Realm and model traps (host-verified 2026-08-29, all three hit in sequence)

- Missing `~/.zcode/cli/config.json` → hard error `Model config is missing`.
  The desktop app's login is NOT shared with the CLI.
- `zcode login` signs into the **overseas Z.AI realm only**. An account on the
  mainland BigModel realm then fails with
  `[1113][Insufficient balance or no resource package]`.
- The scaffolded config defaults `model.main` to `zai/glm-5.2`, which is not
  in the coding plan — same 1113 failure even with a valid plan.

Working mainland configuration (per official docs
`docs.bigmodel.cn/cn/coding-plan/quick-start`): in
`~/.zcode/cli/config.json`, provider kind `anthropic` with
`baseURL: https://open.bigmodel.cn/api/anthropic`, `options.apiKey` = the
coding-plan key (host keychain: service `glm-key`, account `akagilnc`), and
`model.main: zai/glm-5.3`, `model.lite: zai/glm-5.3-flash`. With that config
the smoke prompt returns normally.

## Quota facts (owner-provided, 2026-08-28)

Plan quotas are daily and per-model (GLM-5.3 3M/day, Flash 5M/day on the
current plan; a weekend event granted a larger temporary pool). Whether cached
tokens count toward quota is unverified.
