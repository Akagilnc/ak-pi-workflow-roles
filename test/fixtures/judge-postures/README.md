# Judge posture recordings

Checked-in role-law oracles for artifact-relative Judge postures.

## Bundles

| Bundle | Direction | Model-visible inputs | External expected |
| --- | --- | --- | --- |
| `r-block/` | construction-readiness blocker | `input/materials.md`, `input/prompt.md` | `expected.json` |
| `r-ready/` | construction-ready plan | `input/materials.md`, `input/prompt.md` | `expected.json` |

Offline bundle **directory names** (`r-block` / `r-ready`) are oracle labels only.
They must never appear inside model-visible prompt text, materials paths, or
materials bodies captured in `session.jsonl`.

Each bundle also carries:

- `session.jsonl` — raw packaged Judge `--mode json` transcript (**acceptance trust root**)
- `receipt.json` — copy of the sole successful accepted `ak_judge_output` details (cross-check only)
- `meta.json` — provenance (model, package SHA, timestamp, soul digest); not Judge input

`expected.json` and `meta.json` must stay outside the model-reachable workspace
and outside `input/` so they are never case materials.

## Neutrality rule

Model-visible surfaces are the **JSONL-derived** user prompt and the materials
file actually read during the run (bound to static `input/*` offline):

- no readiness-direction path labels (`r-block`, `r-ready`, `/r-block/`, `/r-ready/`)
- no expectation sidecars (`expected.json`, `meta.json`)
- no coaching (`judgeStatus` answer keys, “you should continue/converge”, etc.)

Direction still comes from case **substance** (missing Red/Green vs full five
facts), never from path labels or sidecars.

## Offline CI

`test/judge-posture-recordings.test.ts` validates fixtures without calling a
paid model:

1. Parse `session.jsonl` for the **sole** accepted `ak_judge_output` bound as a
   unique ordered lifecycle: exactly one assistant-issued `toolCall` (non-empty
   id, object arguments) → exactly one matching `tool_execution_start` (same
   id/name, args deep-equal) → ≥1 terminal success (`tool_execution_end` and/or
   `toolResult`) with `isError === false`, text `Judge verdict accepted`, and
   object `details` deep-equal to the issued arguments; row order must be
   call < start < every terminal. Same-id replay (multiple calls or starts)
   rejects even when payloads would agree under last-write. All terminal
   representations for one id must agree (deep-equal payload); disagreement
   rejects the id. Missing bind, args mismatch, or missing `isError` does not
   count. Two distinct fully-bound ids still count as two even when details are
   identical.
2. Extract user-prompt text from JSONL `message_end` (not stream deltas) and
   materials-read path/body from the successful `read` bound to that prompt.
3. Run neutrality checks on those JSONL-derived surfaces; require static
   `input/prompt.md` to equal/prefix the instruction body and static
   `input/materials.md` to **byte-equal** the materials-read content.
4. Cross-check `receipt.json` against the JSONL-derived verdict.
5. Pin soul digest to current `souls/judge.md` and require the soul body in the session.
6. Assert direction against external `expected.json` only.

A receipt-only, orphan terminal, or self-asserted marker without the bound call
chain fails.

## Re-record (operator, not CI)

After `souls/judge.md` changes, re-record **both** bundles before claiming green.
Use a **detached opaque workspace** so direction labels, sibling bundles, and
oracle sidecars are unreachable to the model.

```bash
ROOT=$(pwd)
PKG_SHA=$(git rev-parse HEAD)
SOUL_DIGEST=$(node -e "const fs=require('fs');const c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('souls/judge.md')).digest('hex'))")

# 1) Export a package tree the model may search — without judge-posture fixtures.
EXPORT=$(mktemp -d)/pkg
mkdir -p "$EXPORT"
# Copy only packaged surfaces (+ enough for -e resolution). Do NOT copy
# test/fixtures/judge-postures into EXPORT.
cp -R "$ROOT/extensions" "$ROOT/src" "$ROOT/souls" "$ROOT/schemas" \
  "$ROOT/package.json" "$ROOT/README.md" "$EXPORT/"
# Optional: keep node_modules resolution via the live checkout.
ln -s "$ROOT/node_modules" "$EXPORT/node_modules"

record_opaque() {
  local offline_name=$1   # r-block | r-ready — offline oracle label only
  local offline=$ROOT/test/fixtures/judge-postures/$offline_name
  local work
  work=$(mktemp -d)/case-$(openssl rand -hex 4)
  mkdir -p "$work"
  # Model-reachable case files only — no expected.json / meta.json / sibling bundles.
  cp "$offline/input/materials.md" "$work/materials.md"
  cp "$offline/input/prompt.md" "$work/prompt.md"

  local prompt
  prompt=$(cat "$work/prompt.md")

  # Run from EXPORT so repo-wide search cannot see offline oracle dir names.
  # Prompt must not embed r-block/r-ready; materials path must be opaque.
  ( cd "$EXPORT" && pi --no-extensions \
      -e "$EXPORT/extensions/role-runtime.ts" \
      --no-skills --no-prompt-templates --no-themes --no-context-files \
      --no-session \
      --mode json \
      --ak-role judge \
      -p "$prompt

Materials path (read this file as the sole case materials): $work/materials.md" \
    ) > "$offline/session.jsonl"
}

record_opaque r-block
record_opaque r-ready

# Derive receipt.json from the sole accepted tool result (isError===false,
# Judge verdict accepted, distinct toolCallId) in each session.jsonl.
# Write meta.json with provider, model, packageSha=$PKG_SHA, recordedAt,
# soulDigest=$SOUL_DIGEST, akRole=judge, roleFlags.
# Confirm session contains a full read of souls/judge.md from EXPORT.
# Confirm static input/* still byte-match the JSONL user instruction body and
# materials-read content (re-copy from the opaque work files if needed).
# Do not pass expected.json or meta.json into the Judge invocation.
# Do not hand-edit fake acceptance markers into session.jsonl.
```
