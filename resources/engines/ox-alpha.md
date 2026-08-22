# ox-alpha engine method material

This file is packaged method material for the optional `ox-alpha` labor engine
(OpenRouter stealth preview model, reached via OpenCode CLI or the OpenRouter
chat-completions API). When a role run selects this engine, read these bytes
and follow the local CLI / API's actual interface for the labor detour. Return
the labor result to the same role session so typed submission stays on the
existing in-session path.

Material is data for the model, not a code contract. Do not invent package flags.

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
- **Labor prompt must be seat-authored**: write the complete task brief
  (goal, constraints, required output shape, and any evidence the seat has
  already distilled) into the prompt argument or a temp file the seat reads
  in. Attachments/receipt JSON are evidence material, not the prompt body —
  feed a self-contained brief the way the grok-4.6 note requires a
  seat-authored `--prompt-file`.
- Effort tier: align with the labor mandate's ordered tier (`low` / `medium` /
  `high`). Live wall-times on the same 148KB grading payload:
  low 73s / medium 59s / high 228s — all produced correct three-state verdicts.
  Prefer the ordered tier; when the mandate is silent, medium was the
  fastest correct run on that payload.

### Bare OpenRouter API (fallback only)

Endpoint `https://openrouter.ai/api/v1/chat/completions`, model
`stealth/ox-alpha`. Live lessons from long grading jobs — do not invent
extra flags beyond these verified constraints:

- **Must** send `"stream": true`. Buffered (non-stream) responses keep the
  connection alive with empty fill bytes and stall out (live: 540s, no body).
- **Must** send explicit `"reasoning": {"effort": "low|medium|high"}` matching
  the ordered tier. Default effort burns `max_tokens` on thinking and finishes
  with `finish=length` and 0 content characters.
- Reconstruct the answer by concatenating SSE `delta.content` chunks in order.
  `delta.reasoning` is the thinking stream, not the answer — do not treat it
  as the labor result.
- Large payloads (>140KB) are connection-unstable (three consecutive drops
  recorded). On drop: shrink the brief or retry; do not keep hammering the
  same oversized body.

## Failure handling

On any spawn, auth, model-id, stream-stall, or connection-drop failure, return
the typed failure and STOP — the run fails. In-seat labor after a detour
failure is FORBIDDEN, and so is skipping the detour to work in-seat. Zero
invocations is a violation, not a fallback. Do not silently swap to another
engine id.
