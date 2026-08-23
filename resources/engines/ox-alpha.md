# ox-alpha engine method material

This file is packaged technical material for the optional `ox-alpha` labor
engine (OpenRouter stealth preview model, reached via OpenCode CLI).

Before invoking the engine, read `../engine-dispatch.md`, resolving that path
relative to this note. This note only covers this engine's CLI technical
parameters.

## Identity and warnings

- Model id: `stealth/ox-alpha` on OpenRouter (listed 2026-08-20). Anonymous
  vendor, preview-period pricing $0. Specs claimed by the listing: 1M ctx /
  131K out, text+image+video in, tool calling, reasoning.
- **Retention**: the provider retains prompts/completions (stated not used for
  training). Time-boxed experiment — may be delisted or re-priced at any time.
- Free-tier rate limit (official ~20 req/min).
- Quality role (live exam 2026-08-21/22): control / hardening seat, not a
  substitute for the main-court engine. On a standard-answer tool-idle-clock
  final exam it caught all 7 residual shells at every effort tier (medium 59s
  best); sol low missed `converged`, grok-4.6 low also caught 7 but took 979s.

## Invocation examples

### Recommended: agentic via OpenCode CLI

The machine entrypoint is `opencode` with the OpenRouter-routed model id.
Key is on this host's keychain under label `openrouter` (smoke-verified
2026-08-21/22). Run from the role project root:

```bash
OPENROUTER_API_KEY=$(security find-generic-password -l openrouter -w) \
  opencode run -m openrouter/stealth/ox-alpha '<task>'
```

Smoke: prompt `只回两个字：收到` → `收到` (agentic leg usable).

- `-m openrouter/stealth/ox-alpha` selects the model; confirm the current id
  with `opencode models` before long labor — stealth ids can vanish.
- Effort tier: align with the labor mandate's ordered tier (`low` / `medium` /
  `high`). Live wall-times on the same 148KB grading payload:
  low 73s / medium 59s / high 228s — all produced correct three-state verdicts.
  Prefer the ordered tier; when the mandate is silent, medium was the
  fastest correct run on that payload.
