# Dogfood finding — observe evidence is invisible to Collector model

## Finding

`ak_collector_observe` stores/returns complete structured evidence in the tool-result `details`, but its model-visible `content` contains only a one-line snapshot summary. Pi sends tool-result content to the model; extension details are session/host metadata and are not an evidence view the model can classify.

## Reproduction

On PR #5 current HEAD `6fc54e117ebc5e43414015c6e02ef332e9f7d2af`, GitHub contains a qualifying `chatgpt-codex-connector[bot]` PullRequestReview in `COMMENTED` state with exact `commit_id`.

Fresh Collector sessions using two active models independently behaved the same:

- `openai-codex/gpt-5.6-sol`: observe succeeded, then model called request; request runtime rejected: `already has an exact-head qualifying review` and the action exited non-zero.
- `xai/grok-4.5`: explicitly reasoned that the observe message was brief and no qualifying review was noted, then called request; runtime rejected the same way and action exited non-zero.

Transcripts:

- `/tmp/ak-collector-dogfood-pr5-valid-retry.jsonl`
- `/tmp/ak-collector-dogfood-pr5-grok.jsonl`

The tool result shows evidence records only under `details`; model-visible content is `Observed snapshot <id> at <head> (OPEN)`.

## Authority

Collector v1 authority §6 says observe returns a bounded evidence view plus stable evidence/snapshot IDs, without classifying semantics. The model owns valid/pending/unavailable/missing judgment from cited ledger evidence. If evidence is hidden from the model, that judgment is impossible.

## Root repair direction

Repair `ak_collector_observe` at its tool presentation seam so model-visible content includes the bounded configured-author/request-relevant normalized evidence view and stable IDs needed to classify and cite. Keep authoritative raw/self-contained evidence in ledger/details. Runtime must not pre-classify valid/pending/unavailable/missing, and request rejection must remain fail-closed rather than becoming a soft no-op that masks model blindness.

Do not expose unbounded raw GitHub JSON, add read/bash access, duplicate the ledger, or alter receipt semantics.

## Acceptance

1. Real Pi test where observe returns an exact-head qualifying review: provider's next turn can see author/state/commitOid/evidenceId/snapshotId in tool content and submits valid without calling request.
2. Real Pi test where only same-head request marker/pending comment exists: model-visible content carries the marker/comment evidence needed to wait instead of blindly re-request.
3. Content is bounded and derived from the same immutable normalized snapshot records; no separate classification or second evidence source.
4. Existing `details`, ledger, self-contained receipt, size limits, pagination, request refusal, tool narrowing, and public receipt contract remain intact.
5. Forward commit and full gates.
