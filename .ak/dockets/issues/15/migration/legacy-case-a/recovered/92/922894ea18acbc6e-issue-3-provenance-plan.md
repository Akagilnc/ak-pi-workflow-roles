# Plan: Issue #3 recording provenance residual

## Diagnosis (evidence)

- HEAD: `5933d20` (authorized base).
- Both sidecars currently claim false provenance:
  - `test/fixtures/judge-postures/r-block/meta.json` → `provider:"xai"`, `model:"grok-4.5"`
  - `test/fixtures/judge-postures/r-ready/meta.json` → same
- Transcript truth (completed assistant messages only):
  - `r-block/session.jsonl`: 10× `message_end` + assistant → unique pair `openai-codex` / `gpt-5.6-sol`
  - `r-ready/session.jsonl`: 7× `message_end` + assistant → same unique pair
  - No other provider/model pair appears on assistant completions.
- Offline oracle gap: `test/judge-posture-recordings.test.ts` pins `soulDigest`, receipt↔JSONL acceptance, neutrality, and posture-flag absence, but **never** derives or cross-checks `meta.provider` / `meta.model` against JSONL. That is why the false sidecars stay green.
- History testimony: `62596ba` wrote correct `openai-codex`/`gpt-5.6-sol`. Commit `5933d20` re-recorded bundles and overwrote meta to `xai`/`grok-4.5` while the new JSONL still recorded openai-codex — a sidecar-only lie, not a model change. Do **not** “fix” by re-recording or by trusting the current meta text.

## Behavior

Offline posture-recording validation treats JSONL completed-assistant provenance as trust root for `meta.provider`/`meta.model`: each bundle must expose exactly one non-empty `(provider, model)` pair on completed assistant messages, and the sidecar must equal that pair.

## Owner

`test/judge-posture-recordings.test.ts` (oracle) owns the invariant.
`test/fixtures/judge-postures/{r-block,r-ready}/meta.json` own the corrected fact bytes.

## Red

Current tree is already red for the intended invariant (once encoded):

1. For each of `r-block` / `r-ready`, parse `session.jsonl`.
2. Collect `provider`/`model` from rows where `type === "message_end"` and `message.role === "assistant"` with non-empty string fields.
3. Require a unique pair; cross-check `meta.json`.
4. Today: unique JSONL pair is `openai-codex`/`gpt-5.6-sol`, meta claims `xai`/`grok-4.5` → must fail.

## Green

1. Correct both `meta.json` files only:
   - `provider`: `"openai-codex"`
   - `model`: `"gpt-5.6-sol"`
   - Leave `akRole`, `roleFlags`, `packageSha`, `recordedAt`, `soulDigest`, `note` untouched (those are not this residual).
2. Extend `test/judge-posture-recordings.test.ts` inside the existing per-bundle oracle test (not a parallel mechanism):
   - Add a small helper, e.g. `extractUniqueAssistantProvenance(rows)`, that:
     - scans completed assistant `message_end` only (not stream deltas / `message_update`);
     - requires non-empty string `provider` and `model`;
     - fails on zero pairs or more than one distinct pair;
     - returns the unique `{ provider, model }`.
   - Assert `bundle.meta.provider` and `bundle.meta.model` strictly equal that unique pair.
3. Related checks stay as-is (acceptance, receipt cross-check, soul digest, neutrality). No new fixture files, no receipt edits.

## Scope

**In**
- `test/fixtures/judge-postures/r-block/meta.json` — provider/model only
- `test/fixtures/judge-postures/r-ready/meta.json` — provider/model only
- `test/judge-posture-recordings.test.ts` — derive+cross-check helper wired into bundle oracle

**Out**
- No re-record of `session.jsonl` / inputs / receipts / expected.json
- No Soul (`souls/judge.md`) change
- No `src/`, schemas, extensions, runtime, or README rewrite (README already says meta holds model provenance; oracle enforcement is the missing piece)
- No packageSha/recordedAt/soulDigest rewrites unless apply-time verification proves they are also false (current residual is provider/model only)

## Apply steps (when approved)

1. Confirm HEAD still `5933d20` (or strict forward descendant with same residual).
2. Patch both meta sidecars to transcript truth.
3. Add provenance helper + assert in the existing bundle loop.
4. Verify:
   - `node --import tsx --test test/judge-posture-recordings.test.ts`
   - `npm run typecheck` (or repo-declared equivalent)
5. One new forward commit (no amend), title prefix per task contract; body notes sidecar correction to JSONL truth + oracle cross-check; no Soul/re-record.

## Risks / non-goals

- Do not “align” by changing JSONL or inventing xai traffic — transcript is authority.
- Do not weaken other oracle assertions to land the check.
- If apply finds multiple assistant pairs in a bundle, refuse rather than pick arbitrarily — current fixtures are uniquely one pair.
