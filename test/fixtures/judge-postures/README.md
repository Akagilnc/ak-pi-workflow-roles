# Judge posture recordings

Checked-in role-law oracles for artifact-relative Judge postures.

## Bundles

| Bundle | Direction | Model-visible inputs | External expected |
| --- | --- | --- | --- |
| `r-block/` | construction-readiness blocker | `input/materials.md`, `input/prompt.md` | `expected.json` |
| `r-ready/` | construction-ready plan | `input/materials.md`, `input/prompt.md` | `expected.json` |

Each bundle also carries:

- `session.jsonl` — raw packaged Judge `--mode json` transcript (**acceptance trust root**)
- `receipt.json` — copy of the sole successful accepted `ak_judge_output` details (cross-check only)
- `meta.json` — provenance (model, package SHA, timestamp, soul digest); not Judge input

`expected.json` and `meta.json` must stay outside `input/` so they are not model-visible case materials.

## Neutrality rule

`input/materials.md` and `input/prompt.md` must not coach the model with expected
`judgeStatus`, blocker-class answer keys, or “you should continue/converge”
grading language. Expected outcomes live only in `expected.json` and the
offline validator.

## Offline CI

`test/judge-posture-recordings.test.ts` validates fixtures without calling a
paid model:

1. Parse `session.jsonl` for the **sole** successful `ak_judge_output` with
   `isError: false` and text `Judge verdict accepted`.
2. Cross-check `receipt.json` against that JSONL-derived verdict.
3. Pin soul digest to current `souls/judge.md` and require the soul body in the session.
4. Assert direction against external `expected.json` only.
5. Static neutral-input guard on model-visible files.

A receipt-only or self-asserted audit marker without JSONL acceptance fails.

## Re-record (operator, not CI)

After `souls/judge.md` changes, re-record both bundles before claiming green:

```bash
ROOT=$(pwd)
SOUL_DIGEST=$(node -e "const fs=require('fs');const c=require('crypto');process.stdout.write(c.createHash('sha256').update(fs.readFileSync('souls/judge.md')).digest('hex'))")

record() {
  local name=$1
  local dir=$ROOT/test/fixtures/judge-postures/$name
  local prompt
  prompt=$(cat "$dir/input/prompt.md")
  pi --no-extensions \
    -e "$ROOT/extensions/role-runtime.ts" \
    --no-skills --no-prompt-templates --no-themes --no-context-files \
    --no-session \
    --mode json \
    --ak-role judge \
    -p "$prompt

Materials path (read this file as the sole case materials): $dir/input/materials.md" \
    > "$dir/session.jsonl"
}

# Derive receipt.json from the sole accepted tool result in session.jsonl.
# Write meta.json with model, packageSha, recordedAt, soulDigest=$SOUL_DIGEST.
# Confirm the session contains a full read of souls/judge.md.
# Do not pass expected.json or meta.json into the Judge invocation.
```
